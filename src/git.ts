import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git with an argument array (never a shell string, so nothing in a URL or
 * ref can be interpreted by a shell).
 */
export function git(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function gitOrThrow(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr, code } = await git(args, cwd);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

/** Resolve a ref on a remote to a full commit id without cloning. */
export async function resolveRef(url: string, ref: string): Promise<string> {
  const out = await gitOrThrow(["ls-remote", url, ref]);
  const line = out.split("\n").find((l) => l.trim().length > 0);
  if (!line) throw new Error(`ref "${ref}" not found on ${url}`);
  const sha = line.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not resolve "${ref}" on ${url} to a commit`);
  }
  return sha;
}

/**
 * Materialize the files at `commit`/`subdir` from `url` into a fresh temp
 * directory and return its path. Caller is responsible for removing it (or use
 * `withUpstreamTree`). Uses a blobless partial clone so arbitrary commits are
 * reachable without downloading full history blobs up front.
 */
export async function exportTree(url: string, commit: string, subdir: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "regraft-"));
  const clone = join(workspace, "clone");
  try {
    await gitOrThrow(["clone", "--filter=blob:none", "--no-checkout", "--quiet", url, clone]);
    // A pinned commit may no longer be at any branch tip; fetch it explicitly so
    // it is reachable. Ignore failure here: the blobless clone usually already
    // has the object, and the checkout below reports the real error if it does not.
    await git(["fetch", "--quiet", "origin", commit], clone);
    await gitOrThrow(["checkout", "--quiet", "--detach", commit], clone);

    const source = subdir === "." ? clone : join(clone, subdir);
    if (!existsSync(source)) {
      throw new Error(`subdir "${subdir}" does not exist in ${url} at ${commit.slice(0, 12)}`);
    }
    const out = join(workspace, "tree");
    await cp(source, out, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).includes(".git"),
    });
    return out;
  } catch (err) {
    await rm(workspace, { recursive: true, force: true });
    throw err;
  }
}

/** Run `fn` with an exported upstream tree, cleaning up the temp dir afterward. */
export async function withUpstreamTree<T>(
  url: string,
  commit: string,
  subdir: string,
  fn: (treeDir: string) => Promise<T>,
): Promise<T> {
  const treeDir = await exportTree(url, commit, subdir);
  // The temp workspace is the parent of the returned tree dir.
  const workspace = join(treeDir, "..");
  try {
    return await fn(treeDir);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
