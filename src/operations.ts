import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  findGraft,
  readManifest,
  upsertGraft,
  writeManifest,
  type Graft,
  type Manifest,
} from "./manifest.ts";
import {
  assertNoIgnoredPaths,
  assertRepositoryReady,
  commitLocalBase,
  exportLocalTree,
  exportTree,
  findLocalBaseCommit,
  headCommit,
  pathsDirty,
  repositoryPath,
  repositoryRoot,
  resolveRef,
  restoreHeadPaths,
} from "./git.ts";
import { replaceDir, threeWayMerge, type MergeReport } from "./merge.ts";

function refSeparator(spec: string): number {
  const lastAt = spec.lastIndexOf("@");
  if (lastAt === -1) return -1;

  const scheme = spec.indexOf("://");
  if (scheme !== -1) {
    const pathStart = spec.indexOf("/", scheme + 3);
    return pathStart !== -1 && lastAt > pathStart ? lastAt : -1;
  }

  const firstAt = spec.indexOf("@");
  const hostColon = firstAt === -1 ? -1 : spec.indexOf(":", firstAt + 1);
  const firstSlash = spec.indexOf("/");
  const scpLike = firstAt > 0 && hostColon > firstAt && (firstSlash === -1 || hostColon < firstSlash);
  if (scpLike && lastAt === firstAt) return -1;
  return lastAt;
}

/** Parse `url[@ref][#subdir]` into its parts, defaulting ref=HEAD, subdir=".". */
export function parseSourceSpec(spec: string): { url: string; ref: string; subdir: string } {
  let rest = spec;
  let subdir = ".";
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    subdir = rest.slice(hash + 1) || ".";
    rest = rest.slice(0, hash);
  }
  let ref = "HEAD";
  const at = refSeparator(rest);
  if (at !== -1) {
    ref = rest.slice(at + 1) || "HEAD";
    rest = rest.slice(0, at);
  }
  return { url: rest, ref, subdir };
}

function safeRelativePath(path: string, label: string, allowDot = false): string {
  if (isAbsolute(path)) throw new Error(`${label} must be relative, got "${path}"`);
  const cleaned = normalize(path);
  if (
    cleaned === ".." ||
    cleaned.startsWith(`..${sep}`) ||
    (!allowDot && (cleaned === "." || cleaned.length === 0))
  ) {
    throw new Error(`${label} must stay inside its root, got "${path}"`);
  }
  const components = cleaned.split(sep);
  if (components.includes(".git")) {
    throw new Error(`${label} must not include a .git directory`);
  }
  return components.join("/");
}

function validateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `graft name "${name}" is invalid; use letters, numbers, dots, underscores, or hyphens`,
    );
  }
}

function assertNoEmbeddedCredentials(sourceUrl: string): void {
  try {
    const parsed = new URL(sourceUrl);
    const httpUserinfo =
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.username.length > 0 || parsed.password.length > 0);
    if (httpUserinfo || parsed.password.length > 0) {
      throw new Error(
        "source URLs must not contain credentials; use a configured Git credential helper or SSH key",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("source URLs must not")) throw error;
    // Local paths and scp-like SSH URLs are not WHATWG URLs.
  }
}

function assertDestinationSeparateFromManifest(dest: string, manifestPath: string): void {
  if (
    dest === manifestPath ||
    dest.startsWith(`${manifestPath}/`) ||
    manifestPath.startsWith(`${dest}/`)
  ) {
    throw new Error(`destination "${dest}" overlaps ${manifestPath}`);
  }
}

function defaultDest(url: string, subdir: string): string {
  if (subdir !== ".") {
    const tail = subdir.split("/").filter(Boolean).pop();
    if (tail) return tail;
  }
  const name = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
  return name ?? "vendored";
}

async function isEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  return (await readdir(dir)).length === 0;
}

async function assertNoSymlinkComponents(root: string, path: string): Promise<void> {
  let current = root;
  for (const component of path.split("/")) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`destination "${path}" passes through symlink ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

interface RepositoryContext {
  projectRoot: string;
  repoRoot: string;
  manifestGitPath: string;
}

async function repositoryContext(manifestPath: string): Promise<RepositoryContext> {
  const projectRoot = dirname(resolve(manifestPath));
  const repoRoot = await repositoryRoot(projectRoot);
  if (projectRoot !== repoRoot) {
    throw new Error("regraft.json must be at the root of its Git repository");
  }
  return {
    projectRoot,
    repoRoot,
    manifestGitPath: repositoryPath(repoRoot, manifestPath),
  };
}

async function removeExport(treeDir: string): Promise<void> {
  await rm(join(treeDir, ".."), { recursive: true, force: true });
}

export interface AddOptions {
  manifestPath: string;
  spec: string;
  dest?: string;
  name?: string;
  note?: string;
}

export interface AddResult {
  graft: Graft;
  baseCommit: string;
}

export async function addGraft(options: AddOptions): Promise<AddResult> {
  const context = await repositoryContext(options.manifestPath);
  await assertRepositoryReady(context.repoRoot);

  const parsed = parseSourceSpec(options.spec);
  if (!parsed.url) throw new Error("source URL must not be empty");
  assertNoEmbeddedCredentials(parsed.url);
  const subdir = safeRelativePath(parsed.subdir, "source subdirectory", true);
  const destRel = safeRelativePath(options.dest ?? defaultDest(parsed.url, subdir), "destination");
  const name = options.name ?? destRel.split("/").filter(Boolean).pop() ?? destRel;
  validateName(name);

  assertDestinationSeparateFromManifest(destRel, context.manifestGitPath);
  await assertNoSymlinkComponents(context.repoRoot, destRel);
  const destAbs = join(context.projectRoot, ...destRel.split("/"));
  const destExisted = existsSync(destAbs);
  if (!(await isEmptyDir(destAbs))) {
    throw new Error(
      `destination "${destRel}" already exists and is not empty; pick another path or remove it first`,
    );
  }

  const manifestExisted = existsSync(options.manifestPath);
  const manifestBefore = manifestExisted ? await readFile(options.manifestPath) : undefined;
  const manifest = await readManifest(options.manifestPath);
  if (findGraft(manifest, name)) {
    throw new Error(`a graft named "${name}" already exists; pass an explicit name`);
  }
  if (
    manifest.grafts.some(
      (entry) =>
        entry.dest === destRel || entry.dest.startsWith(`${destRel}/`) || destRel.startsWith(`${entry.dest}/`),
    )
  ) {
    throw new Error(`destination "${destRel}" overlaps an existing graft`);
  }

  const commit = await resolveRef(parsed.url, parsed.ref);
  const tree = await exportTree(parsed.url, commit, subdir);
  let committed = false;
  try {
    await replaceDir(tree, destAbs);
    const graft: Graft = {
      name,
      dest: destRel,
      source: { url: parsed.url, ref: parsed.ref, subdir },
      commit,
      notes: options.note ? [options.note] : [],
    };
    await writeManifest(options.manifestPath, upsertGraft(manifest, graft));

    const baseCommit = await commitLocalBase(
      context.repoRoot,
      [context.manifestGitPath, destRel],
      name,
      commit,
    );
    committed = true;
    return { graft, baseCommit };
  } finally {
    await removeExport(tree);
    if (!committed) {
      await rm(destAbs, { recursive: true, force: true });
      if (destExisted) await mkdir(destAbs, { recursive: true });
      if (manifestBefore) await writeFile(options.manifestPath, manifestBefore);
      else await rm(options.manifestPath, { force: true });
    }
  }
}

export interface UpdateResult {
  graft: Graft;
  previousCommit: string;
  newCommit: string;
  localBaseCommit: string;
  newBaseCommit?: string;
  upToDate: boolean;
  overlayPending: boolean;
  report?: MergeReport;
}

export async function updateGraft(manifestPath: string, name: string): Promise<UpdateResult> {
  validateName(name);
  const context = await repositoryContext(manifestPath);
  await assertRepositoryReady(context.repoRoot);

  const manifest = await readManifest(manifestPath);
  const graft = findGraft(manifest, name);
  if (!graft) throw new Error(`no graft named "${name}"`);
  assertNoEmbeddedCredentials(graft.source.url);
  const destRel = safeRelativePath(graft.dest, "destination");
  assertDestinationSeparateFromManifest(destRel, context.manifestGitPath);
  const subdir = safeRelativePath(graft.source.subdir, "source subdirectory", true);
  await assertNoSymlinkComponents(context.repoRoot, destRel);
  await assertNoIgnoredPaths(context.repoRoot, destRel);
  const destAbs = join(context.projectRoot, ...destRel.split("/"));

  const localBaseCommit = await findLocalBaseCommit(
    context.repoRoot,
    context.manifestGitPath,
    name,
    destRel,
    graft.commit,
  );
  const newCommit = await resolveRef(graft.source.url, graft.source.ref);
  if (newCommit === graft.commit) {
    return {
      graft,
      previousCommit: graft.commit,
      newCommit,
      localBaseCommit,
      upToDate: true,
      overlayPending: false,
    };
  }

  const localHead = await headCommit(context.repoRoot);
  let baseTree: string | undefined;
  let localTree: string | undefined;
  let upstreamTree: string | undefined;
  try {
    // Export sequentially so every completed temporary tree remains available
    // for cleanup if a later export fails.
    baseTree = await exportLocalTree(context.repoRoot, localBaseCommit, destRel);
    localTree = await exportLocalTree(context.repoRoot, localHead, destRel);
    upstreamTree = await exportTree(graft.source.url, newCommit, subdir);

    const report = await threeWayMerge(baseTree, localTree, upstreamTree);
    const updated: Graft = { ...graft, commit: newCommit };
    const updatedManifest: Manifest = upsertGraft(manifest, updated);

    await replaceDir(upstreamTree, destAbs);
    await writeManifest(manifestPath, updatedManifest);

    let newBaseCommit: string;
    try {
      newBaseCommit = await commitLocalBase(
        context.repoRoot,
        [context.manifestGitPath, destRel],
        name,
        newCommit,
      );
    } catch (error) {
      await restoreHeadPaths(context.repoRoot, [context.manifestGitPath, destRel]);
      throw error;
    }

    try {
      await replaceDir(localTree, destAbs);
    } catch (error) {
      await restoreHeadPaths(context.repoRoot, [destRel]);
      throw new Error(
        `created local base ${newBaseCommit.slice(0, 12)} but could not restore the merged overlay: ${(error as Error).message}`,
      );
    }

    const overlayPending = await pathsDirty(context.repoRoot, [destRel]);
    return {
      graft: updated,
      previousCommit: graft.commit,
      newCommit,
      localBaseCommit,
      newBaseCommit,
      upToDate: false,
      overlayPending,
      report,
    };
  } finally {
    await Promise.all(
      [baseTree, localTree, upstreamTree]
        .filter((tree): tree is string => tree !== undefined)
        .map(removeExport),
    );
  }
}

export interface StatusEntry {
  graft: Graft;
  latestCommit: string;
  localBaseCommit: string;
  behind: boolean;
}

export async function status(manifestPath: string): Promise<StatusEntry[]> {
  const context = await repositoryContext(manifestPath);
  const manifest = await readManifest(manifestPath);
  const entries: StatusEntry[] = [];
  for (const graft of manifest.grafts) {
    validateName(graft.name);
    assertNoEmbeddedCredentials(graft.source.url);
    const destRel = safeRelativePath(graft.dest, "destination");
    assertDestinationSeparateFromManifest(destRel, context.manifestGitPath);
    const [latestCommit, localBaseCommit] = await Promise.all([
      resolveRef(graft.source.url, graft.source.ref),
      findLocalBaseCommit(
        context.repoRoot,
        context.manifestGitPath,
        graft.name,
        destRel,
        graft.commit,
      ),
    ]);
    entries.push({
      graft,
      latestCommit,
      localBaseCommit,
      behind: latestCommit !== graft.commit,
    });
  }
  return entries;
}

export async function addNote(manifestPath: string, name: string, note: string): Promise<Graft> {
  validateName(name);
  const manifest = await readManifest(manifestPath);
  const graft = findGraft(manifest, name);
  if (!graft) throw new Error(`no graft named "${name}"`);
  const updated: Graft = { ...graft, notes: [...graft.notes, note] };
  await writeManifest(manifestPath, upsertGraft(manifest, updated));
  return updated;
}
