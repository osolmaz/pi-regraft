import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import spawn from "cross-spawn";
import type { RepositorySnapshot } from "./types.js";

async function git(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0]
): Promise<string> {
  const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((accept, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (signal !== null) reject(new Error(`git terminated by ${signal}`));
      else accept(exitCode ?? 1);
    });
  });
  if (!allowedExitCodes.includes(code)) {
    throw new Error(
      Buffer.concat(stderr).toString("utf8").trim() || `git exited with ${code.toString()}`
    );
  }
  return Buffer.concat(stdout).toString("utf8");
}

export async function identifyRepository(input: string): Promise<{
  repository: string;
  gitCommonDir: string;
  snapshot: RepositorySnapshot;
}> {
  const directory = await realpath(resolve(input));
  const repository = await realpath(
    (await git(directory, ["rev-parse", "--show-toplevel"])).trim()
  );
  const rawCommon = (await git(repository, ["rev-parse", "--git-common-dir"])).trim();
  const gitCommonDir = await realpath(resolve(repository, rawCommon));
  return { repository, gitCommonDir, snapshot: await snapshotRepository(repository) };
}

export async function snapshotRepository(repository: string): Promise<RepositorySnapshot> {
  const [branch, head, status] = await Promise.all([
    currentBranch(repository),
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ]);
  return {
    branch,
    head: head.trim(),
    dirty_paths: parseDirtyPaths(status)
  };
}

async function currentBranch(repository: string): Promise<string> {
  const branch = await git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]);
  return branch.trim() || "(detached)";
}

export function parseDirtyPaths(status: string): string[] {
  const entries = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry === "") continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/u.test(code)) {
      const source = entries[index + 1];
      if (source !== undefined && source !== "") paths.push(source);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export function sameSnapshot(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  return (
    left.branch === right.branch &&
    left.head === right.head &&
    JSON.stringify(left.dirty_paths) === JSON.stringify(right.dirty_paths)
  );
}

export async function firstParentCommits(
  repository: string,
  start: string,
  end: string
): Promise<string[]> {
  if (start === end) return [];
  const output = await git(repository, [
    "rev-list",
    "--first-parent",
    "--ancestry-path",
    "--reverse",
    `${start}..${end}`
  ]);
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}
