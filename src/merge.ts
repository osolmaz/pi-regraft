import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { git } from "./git.ts";

export interface MergeReport {
  /** Files whose content changed in the destination as a result of the merge. */
  changed: string[];
  /** Files newly added from upstream. */
  added: string[];
  /** Files removed because upstream deleted them and you had not touched them. */
  removed: string[];
  /** Files left with conflict markers for a human or agent to resolve. */
  conflicts: string[];
}

/** List every file (recursively) under `dir`, as paths relative to `dir`. */
async function listFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.add(relative(dir, abs).split(sep).join("/"));
      }
    }
  }
  await walk(dir);
  return out;
}

async function readMaybe(dir: string, rel: string): Promise<Buffer | undefined> {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return undefined;
  return readFile(abs);
}

function isBinary(buf: Buffer | undefined): boolean {
  if (!buf) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function eq(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

/**
 * Merge upstream's base->new changes into the local copy, in place.
 *
 * `base` is the tree the local copy was originally taken from, `local` is the
 * destination directory holding your current (possibly edited) files, and
 * `upstream` is the new upstream tree. On return, `local` contains the merged
 * result; conflicts are written as standard `<<<<<<< / ======= / >>>>>>>`
 * markers so the same resolution tools (and the Pi agent) that handle git
 * conflicts apply here too.
 */
export async function threeWayMerge(
  baseDir: string,
  localDir: string,
  upstreamDir: string,
): Promise<MergeReport> {
  const report: MergeReport = { changed: [], added: [], removed: [], conflicts: [] };

  const paths = new Set<string>();
  for (const p of await listFiles(baseDir)) paths.add(p);
  for (const p of await listFiles(localDir)) paths.add(p);
  for (const p of await listFiles(upstreamDir)) paths.add(p);

  for (const rel of paths) {
    const base = await readMaybe(baseDir, rel);
    const local = await readMaybe(localDir, rel);
    const upstream = await readMaybe(upstreamDir, rel);

    // Upstream made no change to this path: nothing to do, keep local as-is.
    if (eq(base, upstream)) continue;

    // You never touched this path (local matches base): take upstream verbatim.
    if (eq(base, local)) {
      if (upstream === undefined) {
        await rm(join(localDir, rel), { force: true });
        report.removed.push(rel);
      } else {
        await writeFileEnsured(join(localDir, rel), upstream);
        if (local === undefined) report.added.push(rel);
        else report.changed.push(rel);
      }
      continue;
    }

    // Both sides diverged from base. Upstream deleted, you edited: keep yours,
    // but flag it so the change is not silently dropped.
    if (upstream === undefined) {
      report.conflicts.push(rel);
      continue;
    }

    // Both sides changed and one side is binary: cannot text-merge. Keep local
    // and flag as a conflict for manual selection.
    if (isBinary(base) || isBinary(local) || isBinary(upstream)) {
      report.conflicts.push(rel);
      continue;
    }

    const merged = await mergeFile(
      base ?? Buffer.alloc(0),
      local ?? Buffer.alloc(0),
      upstream,
    );
    await writeFileEnsured(join(localDir, rel), merged.content);
    if (merged.conflicted) report.conflicts.push(rel);
    else report.changed.push(rel);
  }

  return report;
}

async function writeFileEnsured(abs: string, data: Buffer): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

/**
 * Three-way merge a single text file via `git merge-file`, using a temp
 * directory so nothing touches the destination until we have a result.
 */
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
    // merge-file rewrites <current> (local) with base->other (upstream) changes.
    const res = await git([
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
    const content = await readFile(localPath);
    // Exit code >0 is the number of conflict hunks; <0 is an error.
    return { content, conflicted: res.code > 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Copy an exported tree into a destination directory, replacing its contents. */
export async function replaceDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}
