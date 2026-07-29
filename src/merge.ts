import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { git } from "./git.ts";

export interface MergeReport {
  /** Files whose content, link target, or executable bit changed. */
  changed: string[];
  /** Paths newly added from upstream. */
  added: string[];
  /** Paths removed because upstream deleted them and local did not change them. */
  removed: string[];
  /** Paths that require a human or agent choice. */
  conflicts: string[];
}

type TreeEntry =
  | { kind: "file"; content: Buffer; executable: boolean }
  | { kind: "symlink"; target: string };

/** Read Git-trackable file and symlink entries below `dir`. */
async function readTree(dir: string): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  if (!existsSync(dir)) return entries;

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(current, entry.name);
      const path = relative(dir, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isSymbolicLink()) {
        entries.set(path, { kind: "symlink", target: await readlink(absolute) });
      } else if (entry.isFile()) {
        const metadata = await lstat(absolute);
        entries.set(path, {
          kind: "file",
          content: await readFile(absolute),
          executable: (metadata.mode & 0o111) !== 0,
        });
      }
    }
  }

  await walk(dir);
  return entries;
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target;
  if (a.kind === "file" && b.kind === "file") {
    return a.executable === b.executable && a.content.equals(b.content);
  }
  return false;
}

function isBinary(entry: TreeEntry | undefined): boolean {
  if (entry?.kind !== "file") return false;
  const length = Math.min(entry.content.length, 8000);
  for (let index = 0; index < length; index++) {
    if (entry.content[index] === 0) return true;
  }
  return false;
}

function mergeExecutableBit(base: boolean, local: boolean, upstream: boolean): boolean {
  if (local === base) return upstream;
  if (upstream === base) return local;
  return local;
}

async function writeEntry(root: string, path: string, entry: TreeEntry): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await rm(absolute, { recursive: true, force: true });
  await mkdir(dirname(absolute), { recursive: true });
  if (entry.kind === "symlink") {
    await symlink(entry.target, absolute);
    return;
  }
  await writeFile(absolute, entry.content);
  await chmod(absolute, entry.executable ? 0o755 : 0o644);
}

function descendants(tree: Map<string, TreeEntry>, path: string): string[] {
  const prefix = `${path}/`;
  return [...tree.keys()].filter((candidate) => candidate.startsWith(prefix));
}

function subtreeMatches(
  baseTree: Map<string, TreeEntry>,
  localTree: Map<string, TreeEntry>,
  path: string,
): boolean {
  const paths = new Set([...descendants(baseTree, path), ...descendants(localTree, path)]);
  return [...paths].every((candidate) =>
    sameEntry(baseTree.get(candidate), localTree.get(candidate)),
  );
}

function ancestors(path: string): string[] {
  const components = path.split("/");
  const result: string[] = [];
  for (let length = 1; length < components.length; length++) {
    result.push(components.slice(0, length).join("/"));
  }
  return result;
}

type MergeAction =
  | { type: "remove"; path: string }
  | { type: "write"; path: string; entry: TreeEntry };

/**
 * Merge upstream's base-to-new changes into the local tree in place.
 *
 * `baseDir` and `localDir` come from commits in the consumer repository.
 * `upstreamDir` is the newly fetched upstream tree. Text conflicts get normal
 * Git markers. Binary, symlink, type-change, and delete/edit conflicts keep the
 * local entry and are listed in the report.
 */
export async function threeWayMerge(
  baseDir: string,
  localDir: string,
  upstreamDir: string,
): Promise<MergeReport> {
  const report: MergeReport = { changed: [], added: [], removed: [], conflicts: [] };
  const [baseTree, localTree, upstreamTree] = await Promise.all([
    readTree(baseDir),
    readTree(localDir),
    readTree(upstreamDir),
  ]);
  const paths = new Set([...baseTree.keys(), ...localTree.keys(), ...upstreamTree.keys()]);
  const blockedWrites = new Set<string>();
  const conflicts = new Set<string>();

  // A file or symlink replacing a directory may be written only when the local
  // subtree still matches the base. Otherwise writing the parent would erase a
  // committed local descendant.
  for (const path of upstreamTree.keys()) {
    const baseDescendants = descendants(baseTree, path);
    const localDescendants = descendants(localTree, path);
    if (
      (baseDescendants.length > 0 || localDescendants.length > 0) &&
      !subtreeMatches(baseTree, localTree, path)
    ) {
      blockedWrites.add(path);
      conflicts.add(path);
      for (const descendant of new Set([...baseDescendants, ...localDescendants])) {
        if (!sameEntry(baseTree.get(descendant), localTree.get(descendant))) {
          conflicts.add(descendant);
        }
      }
    }

    // A directory replacing a local file or symlink must also preserve a local
    // change at that ancestor instead of deleting it while creating children.
    for (const ancestor of ancestors(path)) {
      const baseAncestor = baseTree.get(ancestor);
      const localAncestor = localTree.get(ancestor);
      if ((baseAncestor || localAncestor) && !sameEntry(baseAncestor, localAncestor)) {
        blockedWrites.add(path);
        conflicts.add(ancestor);
        conflicts.add(path);
      }
    }
  }

  const actions: MergeAction[] = [];
  for (const path of paths) {
    const base = baseTree.get(path);
    const local = localTree.get(path);
    const upstream = upstreamTree.get(path);

    if (sameEntry(base, upstream) || sameEntry(local, upstream)) continue;

    if (sameEntry(base, local)) {
      if (upstream === undefined) {
        actions.push({ type: "remove", path });
        report.removed.push(path);
      } else if (blockedWrites.has(path)) {
        conflicts.add(path);
      } else {
        actions.push({ type: "write", path, entry: upstream });
        if (local === undefined) report.added.push(path);
        else report.changed.push(path);
      }
      continue;
    }

    if (upstream === undefined) {
      conflicts.add(path);
      continue;
    }

    if (blockedWrites.has(path)) {
      conflicts.add(path);
      continue;
    }

    if (
      base?.kind !== "file" ||
      local?.kind !== "file" ||
      upstream.kind !== "file" ||
      isBinary(base) ||
      isBinary(local) ||
      isBinary(upstream)
    ) {
      conflicts.add(path);
      continue;
    }

    const merged = await mergeFile(base.content, local.content, upstream.content);
    actions.push({
      type: "write",
      path,
      entry: {
        kind: "file",
        content: merged.content,
        executable: mergeExecutableBit(base.executable, local.executable, upstream.executable),
      },
    });
    if (merged.conflicted) conflicts.add(path);
    else report.changed.push(path);
  }

  const depth = (path: string) => path.split("/").length;
  const removals = actions
    .filter((action): action is Extract<MergeAction, { type: "remove" }> => action.type === "remove")
    .sort((a, b) => depth(b.path) - depth(a.path));
  const writes = actions
    .filter((action): action is Extract<MergeAction, { type: "write" }> => action.type === "write")
    .sort((a, b) => depth(a.path) - depth(b.path));

  for (const action of removals) {
    await rm(join(localDir, ...action.path.split("/")), { recursive: true, force: true });
  }
  for (const action of writes) {
    await writeEntry(localDir, action.path, action.entry);
  }

  report.conflicts = [...conflicts];
  return report;
}

/** Three-way merge one text file via `git merge-file`. */
async function mergeFile(
  base: Buffer,
  local: Buffer,
  upstream: Buffer,
): Promise<{ content: Buffer; conflicted: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "regraft-merge-file-"));
  const localPath = join(dir, "local");
  const basePath = join(dir, "base");
  const upstreamPath = join(dir, "upstream");
  try {
    await writeFile(localPath, local);
    await writeFile(basePath, base);
    await writeFile(upstreamPath, upstream);
    const result = await git([
      "merge-file",
      "-L",
      "local",
      "-L",
      "base",
      "-L",
      "upstream",
      localPath,
      basePath,
      upstreamPath,
    ]);
    // Git reports the conflict count from 1 through 127. Fatal and usage
    // failures use 128 or above; a negative process result is an execution error.
    if (result.code < 0 || result.code >= 128) {
      throw new Error(`git merge-file failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { content: await readFile(localPath), conflicted: result.code > 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Replace a file tree while preserving executable bits and symlinks. */
export async function replaceDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, preserveTimestamps: true });
}
