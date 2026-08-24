import { createHash, type Hash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import spawn from "cross-spawn";
import { sameSnapshot, snapshotRepository } from "./git.js";
import type { HandoffCandidate, LeaseRecord, RepositoryEvidence, RunRecord } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export async function captureRepositoryEvidence(repository: string): Promise<RepositoryEvidence> {
  const before = await snapshotRepository(repository);
  const [statusBefore, indexBefore] = await Promise.all([
    hashGitOutput(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    hashGitOutput(repository, ["ls-files", "--stage", "-z"])
  ]);
  const content = await hashPaths(repository, before.dirty_paths);
  const [statusAfter, indexAfter, after] = await Promise.all([
    hashGitOutput(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    hashGitOutput(repository, ["ls-files", "--stage", "-z"]),
    snapshotRepository(repository)
  ]);
  if (!sameSnapshot(before, after) || statusBefore !== statusAfter || indexBefore !== indexAfter) {
    throw new Error("repository changed while Regrafter captured handoff evidence");
  }
  return {
    snapshot: after,
    status_sha256: statusAfter,
    index_sha256: indexAfter,
    content_sha256: content
  };
}

export function createHandoffCandidate(
  run: RunRecord,
  lease: LeaseRecord,
  current: RepositoryEvidence
): HandoffCandidate {
  const payload = {
    schema_version: 1 as const,
    run_id: run.run_id,
    repository: run.repository,
    git_common_dir: run.git_common_dir,
    run_updated_at: run.updated_at,
    lease: {
      schema_version: lease.schema_version,
      run_id: lease.run_id,
      repository: lease.repository,
      git_common_dir: lease.git_common_dir,
      branch: lease.branch,
      starting_head: lease.starting_head,
      ...(lease.process_id === undefined ? {} : { process_id: lease.process_id }),
      updated_at: lease.updated_at
    },
    previous: run.last_observed,
    current
  };
  return {
    ...payload,
    evidence: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  };
}

export function assertEvidenceDigest(value: string): void {
  if (!SHA256.test(value)) throw new Error("handoff evidence must be a lowercase SHA-256 digest");
}

async function hashGitOutput(repository: string, args: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  const child = spawn("git", args, {
    cwd: repository,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => hash.update(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
  });
  const code = await new Promise<number>((accept, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (signal !== null) reject(new Error(`git terminated by ${signal}`));
      else accept(exitCode ?? 1);
    });
  });
  if (code !== 0) throw new Error(stderr.trim() || `git exited with ${code.toString()}`);
  return hash.digest("hex");
}

async function hashPaths(repository: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) await hashPath(hash, repository, path);
  return hash.digest("hex");
}

async function hashPath(hash: Hash, repository: string, path: string): Promise<void> {
  const absolute = resolve(repository, path);
  const inside = relative(repository, absolute);
  if (inside === ".." || inside.startsWith(`..${sep}`)) {
    throw new Error(`handoff evidence path escapes repository: ${path}`);
  }
  updateField(hash, "path", path);
  const before = await readStats(absolute);
  if (before === undefined) {
    updateField(hash, "kind", "missing");
    return;
  }
  updateField(hash, "metadata", metadata(before));
  await hashPathContents(hash, absolute, before);
  const after = await readStats(absolute);
  if (after === undefined || metadata(before) !== metadata(after)) {
    throw new Error(`repository path changed while Regrafter captured evidence: ${path}`);
  }
}

async function hashPathContents(
  hash: Hash,
  path: string,
  metadataValue: BigIntStats
): Promise<void> {
  if (metadataValue.isSymbolicLink()) {
    updateField(hash, "symlink", await readlink(path));
    return;
  }
  if (metadataValue.isFile()) {
    await hashFile(hash, path);
    return;
  }
  updateField(hash, "kind", metadataValue.isDirectory() ? "directory" : "special");
}

async function hashFile(hash: Hash, path: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", accept);
  });
}

async function readStats(path: string): Promise<BigIntStats | undefined> {
  return await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
}

function metadata(value: BigIntStats): string {
  return [
    value.mode,
    value.size,
    value.ino,
    value.mtimeNs,
    value.ctimeNs,
    value.isFile()
      ? "file"
      : value.isSymbolicLink()
        ? "symlink"
        : value.isDirectory()
          ? "dir"
          : "other"
  ].join(":");
}

function updateField(hash: Hash, name: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${name}:${bytes.length.toString()}:`);
  hash.update(bytes);
  hash.update("\0");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
