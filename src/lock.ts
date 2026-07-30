import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { git } from "./git.ts";

interface LockOwner {
  pid: number;
  cwd: string;
  started_at: string;
}

async function gitCommonDir(repoRoot: string): Promise<string> {
  const result = await git(["rev-parse", "--git-common-dir"], repoRoot);
  if (result.code !== 0) {
    throw new Error(
      `could not locate Git common directory: ${result.stderr || result.stdout}`,
    );
  }
  const raw = result.stdout.trim();
  const absolute = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  return realpath(absolute);
}

async function existingOwner(lockDir: string): Promise<string> {
  try {
    const raw = await readFile(join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as Partial<LockOwner>;
    const pid =
      typeof owner.pid === "number" ? `pid ${owner.pid}` : "unknown process";
    const cwd = typeof owner.cwd === "string" ? ` from ${owner.cwd}` : "";
    return `${pid}${cwd}`;
  } catch {
    return "an unknown process";
  }
}

export async function withRepositoryLock<T>(
  repoRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const commonDir = await gitCommonDir(repoRoot);
  const lockDir = join(commonDir, "regraft.lock");
  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await existingOwner(lockDir);
    throw new Error(
      `another regraft operation holds ${lockDir} (${owner}); inspect that process and repository before removing a stale lock`,
    );
  }

  const owner: LockOwner = {
    pid: process.pid,
    cwd: process.cwd(),
    started_at: new Date().toISOString(),
  };
  try {
    await writeFile(
      join(lockDir, "owner.json"),
      `${JSON.stringify(owner, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    return await operation();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
