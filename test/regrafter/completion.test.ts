import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { completionProblems } from "../../src/regrafter/completion.js";
import { snapshotRepository } from "../../src/regrafter/git.js";
import type { AgentReport, RunRecord } from "../../src/regrafter/types.js";

const OLD_UPSTREAM = "1".repeat(40);
const NEW_UPSTREAM = "2".repeat(40);
const BAR_OLD_UPSTREAM = "3".repeat(40);
const BAR_NEW_UPSTREAM = "4".repeat(40);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function manifest(fooUpstream: string, barUpstream = BAR_OLD_UPSTREAM): string {
  return manifestDocument([
    graft("foo", "vendor/foo", fooUpstream),
    graft("bar", "vendor/bar", barUpstream)
  ]);
}

function manifestDocument(grafts: ReadonlyArray<Record<string, unknown>>): string {
  return `${JSON.stringify({ version: 1, grafts }, null, 2)}\n`;
}

function graft(name: string, dest: string, commit: string): Record<string, unknown> {
  return {
    name,
    dest,
    source: { url: `https://example.invalid/${name}.git`, ref: "main", subdir: "." },
    commit,
    notes: []
  };
}

async function fixture(): Promise<{
  repo: string;
  oldBase: string;
  barBase: string;
  startingHead: string;
  newBase: string;
  overlay: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), "regrafter-completion-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  await mkdir(join(repo, "vendor", "bar"), { recursive: true });
  await writeFile(join(repo, "vendor", "bar", "index.ts"), "export const bar = 'old';\n");
  await writeFile(
    join(repo, "regraft.json"),
    manifestDocument([graft("bar", "vendor/bar", BAR_OLD_UPSTREAM)])
  );
  git(repo, ["add", "."]);
  git(repo, [
    "commit",
    "-m",
    "chore(regraft): import upstream base",
    "-m",
    `Regraft-Name: bar\nRegraft-Upstream: ${BAR_OLD_UPSTREAM}`
  ]);
  const barBase = git(repo, ["rev-parse", "HEAD"]);
  await mkdir(join(repo, "vendor", "foo"), { recursive: true });
  await writeFile(join(repo, "vendor", "foo", "index.ts"), "export const value = 'old';\n");
  await writeFile(join(repo, "regraft.json"), manifest(OLD_UPSTREAM));
  git(repo, ["add", "."]);
  git(repo, [
    "commit",
    "-m",
    "chore(regraft): import upstream base",
    "-m",
    `Regraft-Name: foo\nRegraft-Upstream: ${OLD_UPSTREAM}`
  ]);
  const oldBase = git(repo, ["rev-parse", "HEAD"]);
  await writeFile(join(repo, "vendor", "foo", "index.ts"), "export const value = 'local';\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fix: preserve local behavior"]);
  const startingHead = git(repo, ["rev-parse", "HEAD"]);

  await writeFile(join(repo, "vendor", "foo", "index.ts"), "export const value = 'upstream';\n");
  await writeFile(join(repo, "regraft.json"), manifest(NEW_UPSTREAM));
  git(repo, ["add", "."]);
  git(repo, [
    "commit",
    "-m",
    "chore(regraft): import upstream base",
    "-m",
    `Regraft-Name: foo\nRegraft-Upstream: ${NEW_UPSTREAM}`
  ]);
  const newBase = git(repo, ["rev-parse", "HEAD"]);
  await writeFile(join(repo, "vendor", "foo", "index.ts"), "export const value = 'merged';\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fix: restore local overlay"]);
  return {
    repo,
    oldBase,
    barBase,
    startingHead,
    newBase,
    overlay: git(repo, ["rev-parse", "HEAD"])
  };
}

function run(value: Awaited<ReturnType<typeof fixture>>): RunRecord {
  const starting = { branch: "main", head: value.startingHead, dirty_paths: [] };
  return {
    schema_version: 1,
    run_id: "run-11111111111111111111111111111111",
    repository: value.repo,
    git_common_dir: join(value.repo, ".git"),
    state: "working",
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    starting,
    last_observed: starting,
    authority: { overlay_commits: true, push: false, pull_requests: false },
    graft_baseline: {
      starting_head: value.startingHead,
      grafts: [
        {
          graft: "foo",
          dest: "vendor/foo",
          upstream: OLD_UPSTREAM,
          local_base: value.oldBase,
          local_overlay: true
        },
        {
          graft: "bar",
          dest: "vendor/bar",
          upstream: BAR_OLD_UPSTREAM,
          local_base: value.barBase,
          local_overlay: false
        }
      ]
    }
  };
}

function report(value: Awaited<ReturnType<typeof fixture>>): AgentReport {
  return {
    schema_version: 1,
    state: "completed",
    summary: "Updated foo.",
    commits: [
      { kind: "base", graft: "foo", sha: value.newBase },
      { kind: "overlay", graft: "foo", sha: value.overlay }
    ],
    checks: [{ command: "npm test", scope: "foo", outcome: "passed", exit_code: 0 }],
    updated_grafts: [{ graft: "foo", old_upstream: OLD_UPSTREAM, new_upstream: NEW_UPSTREAM }],
    next: "None."
  };
}

it("accepts an exact base and overlay completion chain", async () => {
  const value = await fixture();
  expect(
    await completionProblems(run(value), report(value), await snapshotRepository(value.repo))
  ).toEqual([]);
});

it("ignores reports that do not propose completion", async () => {
  const value = await fixture();
  const blocked: AgentReport = {
    ...report(value),
    state: "blocked",
    blocker: {
      reason: "paused",
      evidence: [],
      attempted_actions: [],
      needed: "input"
    }
  };
  expect(
    await completionProblems(run(value), blocked, await snapshotRepository(value.repo))
  ).toEqual([]);
});

it("rejects a missing required overlay and an incomplete commit report", async () => {
  const value = await fixture();
  const incomplete = report(value);
  incomplete.commits = incomplete.commits.slice(0, 1);
  const problems = await completionProblems(
    run(value),
    incomplete,
    await snapshotRepository(value.repo)
  );
  expect(problems).toContain("reported commits do not match the exact first-parent run history");
  expect(problems).toContain('updated graft "foo" requires an overlay commit');
});

it("rejects an overlay commit without controller authority", async () => {
  const value = await fixture();
  const unauthorized = run(value);
  unauthorized.authority.overlay_commits = false;
  const problems = await completionProblems(
    unauthorized,
    report(value),
    await snapshotRepository(value.repo)
  );
  expect(problems).toContain(
    'updated graft "foo" reports an overlay commit without overlay authority'
  );
});

it("rejects dirty completion after a valid commit chain", async () => {
  const value = await fixture();
  await writeFile(join(value.repo, "pending.txt"), "pending\n");
  const invalid = report(value);
  invalid.checks = [{ command: "npm test", scope: "foo", outcome: "failed", exit_code: 1 }];
  const problems = await completionProblems(
    run(value),
    invalid,
    await snapshotRepository(value.repo)
  );
  expect(problems[0]).toContain("worktree is dirty");
  expect(problems).toContain("report contains a failed check");
});

it("rejects duplicate grafts, foreign commits, and missing baselines", async () => {
  const value = await fixture();
  const invalid = report(value);
  const firstUpdated = invalid.updated_grafts[0];
  const secondCommit = invalid.commits[1];
  if (firstUpdated === undefined || secondCommit === undefined) throw new Error("invalid fixture");
  invalid.updated_grafts.push({ ...firstUpdated });
  invalid.commits[1] = { ...secondCommit, graft: "other" };
  const withoutBaseline = run(value);
  delete withoutBaseline.graft_baseline;
  const problems = await completionProblems(
    withoutBaseline,
    invalid,
    await snapshotRepository(value.repo)
  );
  expect(problems).toContain("updated grafts contain duplicate names");
  expect(problems.some((problem) => problem.includes("outside updated_grafts"))).toBe(true);
  expect(problems).toContain("run has no valid starting graft baseline");
});

it("rejects inconsistent graft revisions and missing base reports", async () => {
  const value = await fixture();
  const invalid = report(value);
  invalid.updated_grafts[0] = {
    graft: "foo",
    old_upstream: "3".repeat(40),
    new_upstream: "4".repeat(40)
  };
  invalid.commits = [];
  const problems = await completionProblems(
    run(value),
    invalid,
    await snapshotRepository(value.repo)
  );
  expect(problems.some((problem) => problem.includes("wrong old upstream"))).toBe(true);
  expect(problems.some((problem) => problem.includes("final manifest"))).toBe(true);
  expect(problems.some((problem) => problem.includes("exactly one pristine base"))).toBe(true);
});

it("rejects a final manifest change omitted from updated grafts", async () => {
  const value = await fixture();
  const record = run(value);
  await writeFile(join(value.repo, "regraft.json"), manifest(NEW_UPSTREAM, BAR_NEW_UPSTREAM));
  git(value.repo, ["add", "regraft.json"]);
  git(value.repo, ["commit", "--amend", "--no-edit"]);
  const amended = report(value);
  const finalHead = git(value.repo, ["rev-parse", "HEAD"]);
  amended.commits[1] = { kind: "overlay", graft: "foo", sha: finalHead };
  const problems = await completionProblems(record, amended, await snapshotRepository(value.repo));
  expect(problems).toContain('final manifest changes graft "bar" outside updated_grafts');
});

it("rejects a base-only update before the final run commit", async () => {
  const value = await fixture();
  const record = run(value);
  const foo = record.graft_baseline?.grafts.find((entry) => entry.graft === "foo");
  if (foo === undefined) throw new Error("missing foo baseline fixture");
  foo.local_overlay = false;
  await writeFile(join(value.repo, "vendor", "bar", "index.ts"), "export const bar = 'new';\n");
  await writeFile(join(value.repo, "regraft.json"), manifest(NEW_UPSTREAM, BAR_NEW_UPSTREAM));
  git(value.repo, ["add", "."]);
  git(value.repo, [
    "commit",
    "--amend",
    "-m",
    "chore(regraft): import upstream base",
    "-m",
    `Regraft-Name: bar\nRegraft-Upstream: ${BAR_NEW_UPSTREAM}`
  ]);
  const finalHead = git(value.repo, ["rev-parse", "HEAD"]);
  const invalid = report(value);
  invalid.commits = [
    { kind: "base", graft: "foo", sha: value.newBase },
    { kind: "base", graft: "bar", sha: finalHead }
  ];
  invalid.updated_grafts.push({
    graft: "bar",
    old_upstream: BAR_OLD_UPSTREAM,
    new_upstream: BAR_NEW_UPSTREAM
  });
  const problems = await completionProblems(record, invalid, await snapshotRepository(value.repo));
  expect(problems).toContain(
    'updated graft "foo" has a base-only commit that is not the final run commit'
  );
});

it("turns malformed final graft data into a validation problem", async () => {
  const value = await fixture();
  await writeFile(join(value.repo, "regraft.json"), "{\n");
  const problems = await completionProblems(
    run(value),
    report(value),
    await snapshotRepository(value.repo)
  );
  expect(problems.some((problem) => problem.includes("could not validate updated grafts"))).toBe(
    true
  );
});
