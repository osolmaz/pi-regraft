import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

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
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ stdout, stderr, code: code ?? -1 }));
  });
}

async function gitOrThrow(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr, code } = await git(args, cwd);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

/** Resolve a remote ref to one unambiguous commit id without cloning. */
export async function resolveRef(url: string, ref: string): Promise<string> {
  const out = await gitOrThrow(["ls-remote", "--", url, ref, `${ref}^{}`]);
  const records = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [objectId, name] = line.split(/\s+/, 2);
      return { objectId, name };
    });
  const refs = records.filter((record) => record.name && !record.name.endsWith("^{}"));
  if (refs.length === 0) throw new Error(`ref "${ref}" not found on ${url}`);
  if (refs.length > 1) {
    throw new Error(`ref "${ref}" is ambiguous on ${url}; use its full refs/... name`);
  }

  const selected = refs[0]!;
  const peeled = records.find((record) => record.name === `${selected.name}^{}`);
  const commit = peeled?.objectId ?? selected.objectId;
  if (!commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error(`could not resolve "${ref}" on ${url} to a commit`);
  }
  return commit;
}

async function assertSourceDirectory(clone: string, subdir: string): Promise<string> {
  let current = clone;
  if (subdir !== ".") {
    for (const component of subdir.split("/")) {
      current = join(current, component);
      if (!existsSync(current)) throw new Error(`source subdirectory "${subdir}" does not exist`);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`source subdirectory "${subdir}" must not traverse symlinks`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`source selection "${subdir}" must be a directory`);
      }
    }
  }
  return current;
}

async function copyTree(source: string, workspace: string): Promise<string> {
  if (!existsSync(source)) throw new Error(`tree path does not exist: ${source}`);
  const out = join(workspace, "tree");
  await cp(source, out, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes(".git"),
  });
  return out;
}

/**
 * Materialize the files at `commit`/`subdir` from `url` into a fresh temp
 * directory and return its path. Caller is responsible for removing it (or use
 * `withUpstreamTree`).
 */
export async function exportTree(url: string, commit: string, subdir: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "regraft-upstream-"));
  const clone = join(workspace, "clone");
  try {
    await gitOrThrow([
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--quiet",
      "--",
      url,
      clone,
    ]);
    await git(["fetch", "--quiet", "origin", commit], clone);
    await gitOrThrow(["-c", "core.symlinks=true", "checkout", "--quiet", "--detach", commit], clone);

    const source = await assertSourceDirectory(clone, subdir);
    return await copyTree(source, workspace);
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

/** Run `fn` with an exported upstream tree, cleaning up afterward. */
export async function withUpstreamTree<T>(
  url: string,
  commit: string,
  subdir: string,
  fn: (treeDir: string) => Promise<T>,
): Promise<T> {
  const treeDir = await exportTree(url, commit, subdir);
  const workspace = join(treeDir, "..");
  try {
    return await fn(treeDir);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Return the containing repository root, or fail with a user-facing error. */
export async function repositoryRoot(path: string): Promise<string> {
  const result = await git(["rev-parse", "--show-toplevel"], path);
  if (result.code !== 0) {
    throw new Error("regraft requires a Git repository so merge bases can be committed locally");
  }
  return resolve(result.stdout.trim());
}

/** Convert an absolute path to a slash-separated path inside `repoRoot`. */
export function repositoryPath(repoRoot: string, absolutePath: string): string {
  const rel = relative(repoRoot, resolve(absolutePath));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`path must be inside the Git repository: ${absolutePath}`);
  }
  return rel.split(sep).join("/");
}

/** Require an attached HEAD and a completely clean worktree/index. */
export async function assertRepositoryReady(repoRoot: string): Promise<void> {
  const branch = await git(["symbolic-ref", "--quiet", "HEAD"], repoRoot);
  if (branch.code !== 0) {
    throw new Error("regraft requires an attached Git branch; detached HEAD is not supported");
  }
  const status = await gitOrThrow(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
  );
  if (status.length > 0) {
    throw new Error("regraft requires a clean Git worktree and index; commit or stash changes first");
  }
}

/** Return the current commit id. */
export async function headCommit(repoRoot: string): Promise<string> {
  return (await gitOrThrow(["rev-parse", "HEAD"], repoRoot)).trim();
}

/** Refuse an update that would erase ignored, uncommitted files in a graft. */
export async function assertNoIgnoredPaths(repoRoot: string, path: string): Promise<void> {
  const output = await gitOrThrow(
    [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      path,
    ],
    repoRoot,
  );
  const ignored = output.split("\0").filter(Boolean);
  if (ignored.length === 0) return;
  const sample = ignored.slice(0, 3).join(", ");
  const remainder = ignored.length > 3 ? ` and ${ignored.length - 3} more` : "";
  throw new Error(
    `graft "${path}" contains ignored files that are not in the committed local copy: ${sample}${remainder}; move or remove them before updating`,
  );
}

function validateTrailerValue(value: string, label: string): void {
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must be a non-empty single line`);
  }
}

/**
 * Commit the pristine upstream copy and manifest as an ordinary branch commit.
 * The trailers let later updates find the local merge base after rebases.
 */
export async function commitLocalBase(
  repoRoot: string,
  paths: string[],
  name: string,
  upstreamCommit: string,
): Promise<string> {
  validateTrailerValue(name, "graft name");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(upstreamCommit)) {
    throw new Error(`invalid upstream commit: ${upstreamCommit}`);
  }
  // A pristine base must include upstream files even when consumer ignore rules
  // match their destination paths.
  const staged = await git(
    ["--literal-pathspecs", "-c", "core.fileMode=true", "add", "-f", "--", ...paths],
    repoRoot,
  );
  if (staged.code !== 0) {
    await git(["--literal-pathspecs", "reset", "--", ...paths], repoRoot);
    throw new Error(
      `could not stage the local regraft base: ${staged.stderr.trim() || staged.stdout.trim()}`,
    );
  }
  const committed = await git(
    [
      "commit",
      "-m",
      "chore(regraft): import upstream base",
      "-m",
      `Regraft-Name: ${name}\nRegraft-Upstream: ${upstreamCommit}`,
    ],
    repoRoot,
  );
  if (committed.code !== 0) {
    await git(["--literal-pathspecs", "reset", "--", ...paths], repoRoot);
    throw new Error(
      `could not commit the local regraft base: ${committed.stderr.trim() || committed.stdout.trim()}`,
    );
  }
  return headCommit(repoRoot);
}

async function exactTrailer(
  repoRoot: string,
  commit: string,
  key: "Regraft-Name" | "Regraft-Upstream",
): Promise<string | undefined> {
  const out = await gitOrThrow(
    ["show", "-s", `--format=%(trailers:key=${key},valueonly,separator=%x1f)`, commit],
    repoRoot,
  );
  const values = out.trim().split("\x1f").map((value) => value.trim()).filter(Boolean);
  return values.length === 1 ? values[0] : undefined;
}

interface StoredManifest {
  grafts?: Array<{ name?: unknown; dest?: unknown; commit?: unknown }>;
}

/**
 * Find the newest ancestor that committed the pristine copy for this graft and
 * upstream commit. The candidate is verified against its committed manifest.
 */
export async function findLocalBaseCommit(
  repoRoot: string,
  manifestGitPath: string,
  name: string,
  destGitPath: string,
  upstreamCommit: string,
): Promise<string> {
  validateTrailerValue(name, "graft name");
  const log = await gitOrThrow(
    [
      "log",
      "--format=%H",
      "--fixed-strings",
      `--grep=Regraft-Name: ${name}`,
      `--grep=Regraft-Upstream: ${upstreamCommit}`,
      "--all-match",
      "HEAD",
    ],
    repoRoot,
  );

  for (const candidate of log.split("\n").filter(Boolean)) {
    const [storedName, storedUpstream] = await Promise.all([
      exactTrailer(repoRoot, candidate, "Regraft-Name"),
      exactTrailer(repoRoot, candidate, "Regraft-Upstream"),
    ]);
    if (storedName !== name || storedUpstream !== upstreamCommit) continue;

    const manifest = await git(["show", `${candidate}:${manifestGitPath}`], repoRoot);
    if (manifest.code !== 0) continue;
    try {
      const parsed = JSON.parse(manifest.stdout) as StoredManifest;
      const graft = parsed.grafts?.find((entry) => entry.name === name);
      if (graft?.dest !== destGitPath || graft.commit !== upstreamCommit) continue;
    } catch {
      continue;
    }

    // Git does not store empty directories, so a validated base commit may
    // legitimately have no destination tree.
    return candidate;
  }

  throw new Error(
    `no committed local base found for graft "${name}" at ${upstreamCommit.slice(0, 12)}; ` +
      "restore the regraft base commit to this branch before updating",
  );
}

/** Materialize a graft from a commit in the consumer repository. */
export async function exportLocalTree(
  repoRoot: string,
  commit: string,
  gitPath: string,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "regraft-local-"));
  const clone = join(workspace, "clone");
  try {
    await gitOrThrow([
      "clone",
      "--shared",
      "--no-checkout",
      "--quiet",
      "--",
      repoRoot,
      clone,
    ]);
    await gitOrThrow(["-c", "core.symlinks=true", "checkout", "--quiet", "--detach", commit], clone);
    const source = join(clone, ...gitPath.split("/"));
    const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) {
      const empty = join(workspace, "tree");
      await mkdir(empty);
      return empty;
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `graft destination "${gitPath}" is not a directory in local commit ${commit.slice(0, 12)}`,
      );
    }
    return await copyTree(source, workspace);
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

/** Restore selected paths from HEAD after a failed base-commit attempt. */
export async function restoreHeadPaths(repoRoot: string, paths: string[]): Promise<void> {
  await gitOrThrow(["--literal-pathspecs", "reset", "--", ...paths], repoRoot);

  const trackedPaths: string[] = [];
  for (const path of paths) {
    const entries = await gitOrThrow(
      ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "HEAD", "--", path],
      repoRoot,
    );
    if (entries.length > 0) trackedPaths.push(path);
  }

  let restoreError: unknown;
  if (trackedPaths.length > 0) {
    try {
      await gitOrThrow(
        [
          "--literal-pathspecs",
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...trackedPaths,
        ],
        repoRoot,
      );
    } catch (error) {
      restoreError = error;
    }
  }

  // The update preflight rejects pre-existing ignored/untracked files, so every
  // remaining untracked path here was created by the failed upstream import.
  await gitOrThrow(["--literal-pathspecs", "clean", "-fdx", "--", ...paths], repoRoot);
  if (restoreError) throw restoreError;
}

/** Remove a newly created base commit and restore selected paths from the old HEAD. */
export async function rollbackLocalBase(
  repoRoot: string,
  previousHead: string,
  paths: string[],
): Promise<void> {
  await gitOrThrow(["reset", "--soft", previousHead], repoRoot);
  await restoreHeadPaths(repoRoot, paths);
}

/** Whether any selected path differs from HEAD after a successful base commit. */
export async function pathsDirty(repoRoot: string, paths: string[]): Promise<boolean> {
  const out = await gitOrThrow(
    [
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...paths,
    ],
    repoRoot,
  );
  return out.length > 0;
}
