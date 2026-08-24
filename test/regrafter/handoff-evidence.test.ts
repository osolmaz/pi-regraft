import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { captureRepositoryEvidence } from "../../src/regrafter/handoff-evidence.js";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "regrafter-evidence-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "tracked.txt"), "first\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "chore: initialize fixture"]);
  return repo;
}

it("produces stable evidence without persisting file contents", async () => {
  const repo = await repository();
  await writeFile(join(repo, "tracked.txt"), "private-content-one\n");
  const first = await captureRepositoryEvidence(repo);
  const second = await captureRepositoryEvidence(repo);
  expect(second).toEqual(first);
  expect(JSON.stringify(first)).not.toContain("private-content-one");
  expect(first.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
});

it("changes evidence when bytes change under the same dirty path", async () => {
  const repo = await repository();
  await writeFile(join(repo, "tracked.txt"), "same-size-a\n");
  const first = await captureRepositoryEvidence(repo);
  await writeFile(join(repo, "tracked.txt"), "same-size-b\n");
  const second = await captureRepositoryEvidence(repo);
  expect(second.snapshot.dirty_paths).toEqual(first.snapshot.dirty_paths);
  expect(second.content_sha256).not.toBe(first.content_sha256);
});

it("binds staged, untracked, and symlink state", async () => {
  const repo = await repository();
  await writeFile(join(repo, "tracked.txt"), "staged\n");
  git(repo, ["add", "tracked.txt"]);
  const staged = await captureRepositoryEvidence(repo);
  await writeFile(join(repo, "untracked.txt"), "untracked\n");
  const untracked = await captureRepositoryEvidence(repo);
  expect(untracked.status_sha256).not.toBe(staged.status_sha256);
  expect(untracked.content_sha256).not.toBe(staged.content_sha256);
  if (process.platform !== "win32") {
    await symlink("untracked.txt", join(repo, "link.txt"));
    const linked = await captureRepositoryEvidence(repo);
    expect(linked.content_sha256).not.toBe(untracked.content_sha256);
  }
});
