import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { identifyRepository, sameSnapshot } from "../../src/regrafter/git.js";

it("rejects a path outside a Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-not-git-"));
  await expect(identifyRepository(root)).rejects.toThrow();
});

it("captures complete status output after Git exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-git-output-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  const names = Array.from(
    { length: 1000 },
    (_, index) => `untracked-${index.toString().padStart(4, "0")}-${"x".repeat(80)}.txt`
  );
  await Promise.all(names.map(async (name) => writeFile(join(root, name), "x\n")));
  expect((await identifyRepository(root)).snapshot.dirty_paths).toHaveLength(names.length);
});

it("canonicalizes repository aliases and records dirty paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-git-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  const alias = join(root, "alias");
  await symlink(repo, alias);
  expect((await identifyRepository(alias)).repository).toBe(
    (await identifyRepository(repo)).repository
  );
  await writeFile(join(repo, "file.txt"), "two\n");
  const current = (await identifyRepository(repo)).snapshot;
  expect(current.dirty_paths).toEqual(["file.txt"]);
  expect(sameSnapshot(current, { ...current, dirty_paths: [] })).toBe(false);
  execFileSync("git", ["restore", "file.txt"], { cwd: repo });
  execFileSync("git", ["mv", "file.txt", "renamed.txt"], { cwd: repo });
  expect((await identifyRepository(repo)).snapshot.dirty_paths).toEqual([
    "file.txt",
    "renamed.txt"
  ]);
});
