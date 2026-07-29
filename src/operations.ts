import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  findGraft,
  readManifest,
  upsertGraft,
  writeManifest,
  type Graft,
} from "./manifest.ts";
import { exportTree, resolveRef, withUpstreamTree } from "./git.ts";
import { replaceDir, threeWayMerge, type MergeReport } from "./merge.ts";

/** Parse `url[@ref][#subdir]` into its parts, defaulting ref=main, subdir=".". */
export function parseSourceSpec(spec: string): { url: string; ref: string; subdir: string } {
  let rest = spec;
  let subdir = ".";
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    subdir = rest.slice(hash + 1) || ".";
    rest = rest.slice(0, hash);
  }
  let ref = "HEAD";
  // Only treat "@" as a ref separator when it is not part of an scp-like URL
  // (git@host:...). The last "@" after the final "/" is the ref delimiter.
  const lastSlash = rest.lastIndexOf("/");
  const at = rest.indexOf("@", lastSlash + 1);
  if (at !== -1) {
    ref = rest.slice(at + 1) || "HEAD";
    rest = rest.slice(0, at);
  }
  return { url: rest, ref, subdir };
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

export interface AddOptions {
  manifestPath: string;
  spec: string;
  dest?: string;
  name?: string;
  note?: string;
}

export interface AddResult {
  graft: Graft;
}

export async function addGraft(options: AddOptions): Promise<AddResult> {
  const root = dirname(resolve(options.manifestPath));
  const { url, ref, subdir } = parseSourceSpec(options.spec);

  const commit = await resolveRef(url, ref);

  const destRel = options.dest ?? defaultDest(url, subdir);
  if (isAbsolute(destRel)) {
    throw new Error(`destination must be relative to the project, got "${destRel}"`);
  }
  const destAbs = join(root, destRel);
  if (!(await isEmptyDir(destAbs))) {
    throw new Error(
      `destination "${destRel}" already exists and is not empty; pick another path or remove it first`,
    );
  }

  const manifest = await readManifest(options.manifestPath);
  const name = options.name ?? destRel.split("/").filter(Boolean).pop() ?? destRel;
  if (findGraft(manifest, name)) {
    throw new Error(`a graft named "${name}" already exists; pass an explicit name`);
  }

  const tree = await exportTree(url, commit, subdir);
  try {
    await replaceDir(tree, destAbs);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(join(tree, ".."), { recursive: true, force: true });
  }

  const graft: Graft = {
    name,
    dest: destRel,
    source: { url, ref, subdir },
    commit,
    notes: options.note ? [options.note] : [],
  };
  await writeManifest(options.manifestPath, upsertGraft(manifest, graft));
  return { graft };
}

export interface UpdateResult {
  graft: Graft;
  previousCommit: string;
  newCommit: string;
  upToDate: boolean;
  report?: MergeReport;
}

export async function updateGraft(manifestPath: string, name: string): Promise<UpdateResult> {
  const root = dirname(resolve(manifestPath));
  const manifest = await readManifest(manifestPath);
  const graft = findGraft(manifest, name);
  if (!graft) throw new Error(`no graft named "${name}"`);

  const { url, ref, subdir } = graft.source;
  const newCommit = await resolveRef(url, ref);
  if (newCommit === graft.commit) {
    return { graft, previousCommit: graft.commit, newCommit, upToDate: true };
  }

  const destAbs = join(root, graft.dest);
  if (!existsSync(destAbs)) {
    throw new Error(`graft directory "${graft.dest}" is missing on disk`);
  }

  const report = await withUpstreamTree(url, graft.commit, subdir, (baseDir) =>
    withUpstreamTree(url, newCommit, subdir, (upstreamDir) =>
      threeWayMerge(baseDir, destAbs, upstreamDir),
    ),
  );

  const updated: Graft = { ...graft, commit: newCommit };
  await writeManifest(manifestPath, upsertGraft(manifest, updated));

  return {
    graft: updated,
    previousCommit: graft.commit,
    newCommit,
    upToDate: false,
    report,
  };
}

export interface StatusEntry {
  graft: Graft;
  latestCommit: string;
  behind: boolean;
}

export async function status(manifestPath: string): Promise<StatusEntry[]> {
  const manifest = await readManifest(manifestPath);
  const entries: StatusEntry[] = [];
  for (const graft of manifest.grafts) {
    const latestCommit = await resolveRef(graft.source.url, graft.source.ref);
    entries.push({ graft, latestCommit, behind: latestCommit !== graft.commit });
  }
  return entries;
}

export async function addNote(manifestPath: string, name: string, note: string): Promise<Graft> {
  const manifest = await readManifest(manifestPath);
  const graft = findGraft(manifest, name);
  if (!graft) throw new Error(`no graft named "${name}"`);
  const updated: Graft = { ...graft, notes: [...graft.notes, note] };
  await writeManifest(manifestPath, upsertGraft(manifest, updated));
  return updated;
}
