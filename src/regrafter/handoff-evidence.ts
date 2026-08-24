import { createHash, type Hash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import spawn from "cross-spawn";
import { parseDirtyPaths, sameSnapshot, snapshotRepository } from "./git.js";
import type { HandoffCandidate, LeaseRecord, RepositoryEvidence, RunRecord } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CAPTURED_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

type NestedRepositoryKind = "submodule" | "embedded_repository";
type NestedRepositoryState = {
  head: string;
  status: string;
  statusSha256: string;
  indexSha256: string;
};

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
  await consumeGitOutput(repository, args, (chunk) => hash.update(chunk));
  return hash.digest("hex");
}

async function readGitOutput(repository: string, args: readonly string[]): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  await consumeGitOutput(repository, args, (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_CAPTURED_GIT_OUTPUT_BYTES) chunks.push(chunk);
  });
  if (bytes > MAX_CAPTURED_GIT_OUTPUT_BYTES) {
    throw new Error("Git output exceeds the handoff evidence capture limit");
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function consumeGitOutput(
  repository: string,
  args: readonly string[],
  consume: (chunk: Buffer) => void
): Promise<void> {
  const child = spawn("git", args, {
    cwd: repository,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stdout?.on("data", consume);
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
}

async function hashPaths(repository: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  await updatePaths(hash, repository, paths);
  return hash.digest("hex");
}

async function updatePaths(
  hash: Hash,
  repository: string,
  paths: readonly string[]
): Promise<void> {
  for (const path of [...paths].sort()) await hashPath(hash, repository, path);
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
  const nestedKind = before.isDirectory()
    ? await nestedRepositoryKind(repository, path, absolute)
    : undefined;
  if (nestedKind === undefined) await hashPathContents(hash, absolute, before);
  else await hashNestedRepository(hash, absolute, nestedKind);
  const after = await readStats(absolute);
  if (after === undefined || metadata(before) !== metadata(after)) {
    throw new Error(`repository path changed while Regrafter captured evidence: ${path}`);
  }
}

async function nestedRepositoryKind(
  repository: string,
  path: string,
  absolute: string
): Promise<NestedRepositoryKind | undefined> {
  const output = await readGitOutput(repository, ["ls-files", "--stage", "-z", "--", path]);
  if (output.split("\0").some((entry) => entry.startsWith("160000 "))) return "submodule";
  if ((await readStats(resolve(absolute, ".git"))) === undefined) return undefined;
  const topLevel = resolve(
    (await readGitOutput(absolute, ["rev-parse", "--show-toplevel"])).trim()
  );
  if (topLevel !== absolute) {
    throw new Error(`embedded Git repository has an unexpected worktree root: ${path}`);
  }
  return "embedded_repository";
}

async function hashNestedRepository(
  hash: Hash,
  repository: string,
  kind: NestedRepositoryKind
): Promise<void> {
  updateField(hash, "kind", kind);
  const before = await readNestedRepositoryState(repository);
  updateField(hash, "nested_head", before.head);
  updateField(hash, "nested_status_sha256", before.statusSha256);
  updateField(hash, "nested_index_sha256", before.indexSha256);
  await updatePaths(hash, repository, parseDirtyPaths(before.status));
  const after = await readNestedRepositoryState(repository);
  if (!sameNestedRepositoryState(before, after)) {
    throw new Error("nested Git repository changed while Regrafter captured handoff evidence");
  }
}

async function readNestedRepositoryState(repository: string): Promise<NestedRepositoryState> {
  const [head, status, indexSha256] = await Promise.all([
    readGitOutput(repository, ["rev-parse", "HEAD"]),
    readGitOutput(repository, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none"
    ]),
    hashGitOutput(repository, ["ls-files", "--stage", "-z"])
  ]);
  return {
    head: head.trim(),
    status,
    statusSha256: createHash("sha256").update(status).digest("hex"),
    indexSha256
  };
}

function sameNestedRepositoryState(
  left: NestedRepositoryState,
  right: NestedRepositoryState
): boolean {
  return (
    left.head === right.head &&
    left.status === right.status &&
    left.indexSha256 === right.indexSha256
  );
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
