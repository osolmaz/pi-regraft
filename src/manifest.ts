import { lstat, readFile, writeFile } from "node:fs/promises";

export const MANIFEST_FILE = "regraft.json";
export const MANIFEST_VERSION = 1 as const;

/** Where a graft's files come from upstream. */
export interface GraftSource {
  /** Any git URL that `git ls-remote`/`git clone` accepts. */
  url: string;
  /** The ref tracked for updates, e.g. "main" or "v2". Resolved to a commit on each update. */
  ref: string;
  /** Path within the upstream repo to vendor. "." means the whole repo. */
  subdir: string;
}

/** One vendored directory tree copied from upstream. */
export interface Graft {
  /** Stable name used to address the graft in commands. */
  name: string;
  /** Destination path, relative to the manifest's directory. */
  dest: string;
  source: GraftSource;
  /**
   * The upstream revision represented by the latest pristine base commit in
   * the consumer repository. The files for this revision are read from that
   * local commit during the next update, never fetched from old upstream state.
   */
  commit: string;
  /**
   * Why local edits exist, in the author's words. Read back to the agent when a
   * merge conflicts so it can preserve intent rather than guess from a diff.
   */
  notes: string[];
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  grafts: Graft[];
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, grafts: [] };
}

async function manifestExists(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return false;
  if (metadata.isSymbolicLink()) {
    throw new Error(`${MANIFEST_FILE} must not be a symbolic link`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${MANIFEST_FILE} must be a regular file`);
  }
  return true;
}

export async function readManifest(path: string): Promise<Manifest> {
  if (!(await manifestExists(path))) return emptyManifest();
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Manifest;
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(
      `unsupported ${MANIFEST_FILE} version ${parsed.version}; this tool understands version ${MANIFEST_VERSION}`,
    );
  }
  if (!Array.isArray(parsed.grafts)) {
    throw new Error(`malformed ${MANIFEST_FILE}: "grafts" must be an array`);
  }
  return parsed;
}

export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await manifestExists(path);
  const sorted: Manifest = {
    version: manifest.version,
    grafts: [...manifest.grafts].sort((a, b) => a.name.localeCompare(b.name)),
  };
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

export function findGraft(manifest: Manifest, name: string): Graft | undefined {
  return manifest.grafts.find((g) => g.name === name);
}

export function upsertGraft(manifest: Manifest, graft: Graft): Manifest {
  const grafts = manifest.grafts.filter((g) => g.name !== graft.name);
  grafts.push(graft);
  return { ...manifest, grafts };
}
