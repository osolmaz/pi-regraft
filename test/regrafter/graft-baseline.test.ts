import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { captureGraftBaseline } from "../../src/regrafter/graft-baseline.js";

const UPSTREAM = "1".repeat(40);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

it("records a committed local overlay without network access or mutation", async () => {
  const repo = await mkdtemp(join(tmpdir(), "regrafter-baseline-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  await mkdir(join(repo, "vendor", "foo"), { recursive: true });
  await writeFile(join(repo, "vendor", "foo", "index.ts"), "export const value = 'base';\n");
  await writeFile(
    join(repo, "regraft.json"),
    `${JSON.stringify({
      version: 1,
      grafts: [
        {
          name: "foo",
          dest: "vendor/foo",
          source: { url: "https://example.invalid/foo.git", ref: "main", subdir: "." },
          commit: UPSTREAM,
          notes: []
        }
      ]
    })}\n`
  );
  git(repo, ["add", "."]);
  git(repo, [
    "commit",
    "-m",
    "chore(regraft): import upstream base",
    "-m",
    `Regraft-Name: foo\nRegraft-Upstream: ${UPSTREAM}`
  ]);
  const localBase = git(repo, ["rev-parse", "HEAD"]);
  await writeFile(join(repo, "vendor", "foo", "index.ts"), "export const value = 'local';\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fix: add local overlay"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const before = git(repo, ["status", "--porcelain=v1"]);
  const baseline = await captureGraftBaseline(repo, head);
  expect(baseline).toEqual({
    starting_head: head,
    grafts: [
      {
        graft: "foo",
        dest: "vendor/foo",
        upstream: UPSTREAM,
        local_base: localBase,
        local_overlay: true
      }
    ]
  });
  expect(git(repo, ["status", "--porcelain=v1"])).toBe(before);
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
});
