import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  abortRun,
  acceptHandoff,
  inspectRun,
  prepareHandoff,
  startRun,
  type AgentLauncher,
  type ControllerOptions
} from "../../src/regrafter/controller.js";
import { acquireLease, readLease, releaseLease } from "../../src/regrafter/lease.js";
import { saveRun } from "../../src/regrafter/runs.js";
import type { HandoffCandidate, RunRecord } from "../../src/regrafter/types.js";

async function fixture(): Promise<{
  repo: string;
  stateDir: string;
  appFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "regrafter-handoff-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "regraft.json"), '{"version":1,"grafts":[]}\n');
  git(repo, ["add", "regraft.json"]);
  git(repo, ["commit", "-m", "chore: initialize fixture"]);
  const stateDir = join(root, "state");
  const appFile = join(root, "pi-factory.toml");
  await writeFile(join(root, "fake-pi.mjs"), "process.exitCode = 0;\n");
  await writeFile(
    appFile,
    `schema_version = 1\nid = "regrafter-test"\nname = "Regrafter test"\nversion = "1.0.0"\nstate_dir = ${JSON.stringify(join(root, "pi"))}\npi_command = ["node", "./fake-pi.mjs"]\ntools = ["read"]\n[provider]\nid = "test"\nbase_url = "http://127.0.0.1:1/v1"\n[model]\nid = "test"\n`
  );
  return { repo, stateDir, appFile };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function completedReport(): Record<string, unknown> {
  return {
    schema_version: 1,
    state: "completed",
    summary: "Update complete.",
    commits: [],
    checks: [],
    updated_grafts: [],
    next: "None."
  };
}

function dirtyLauncher(repo: string): AgentLauncher {
  return async (plan) => {
    await writeFile(join(repo, "overlay.txt"), "pending overlay\n");
    await writeFile(
      plan.env["REGRAFTER_REPORT_FILE"] ?? "",
      `${JSON.stringify(completedReport())}\n`
    );
    return { code: 0, signal: null, sessionId: "session-incident" };
  };
}

function options(value: { stateDir: string; appFile: string }): ControllerOptions {
  return { stateDir: value.stateDir, appFile: value.appFile };
}

async function repointGitDirectory(repository: string): Promise<void> {
  const moved = `${repository}.git-repointed`;
  await rename(join(repository, ".git"), moved);
  await writeFile(join(repository, ".git"), `gitdir: ${moved}\n`);
}

async function savePendingHandoff(
  stateDir: string,
  run: RunRecord,
  prepared: HandoffCandidate
): Promise<void> {
  const pending = { ...run, state: "handed_off" as const };
  delete pending.rejected_completion;
  await saveRun(stateDir, {
    ...pending,
    last_observed: prepared.current.snapshot,
    handoff: {
      schema_version: 1,
      evidence: prepared.evidence,
      actor: "test-operator",
      reason: "Accepted after external reconciliation.",
      accepted_at: new Date().toISOString(),
      previous: run.last_observed,
      accepted: prepared.current,
      release: "pending"
    }
  });
}

it("recovers the August dirty-completion lease through an audited handoff", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  expect(blocked.state).toBe("blocked");
  const run = await inspectRun(blocked.run_id, options(value));
  expect(run.rejected_completion?.reasons[0]).toContain("worktree is dirty");

  git(value.repo, ["add", "overlay.txt"]);
  git(value.repo, ["commit", "-m", "fix: reconcile overlay externally"]);
  await expect(abortRun(run.run_id, options(value))).rejects.toThrow("lease retained");

  const prepared = await prepareHandoff(run.run_id, options(value));
  expect(prepared.previous.head).toBe(run.last_observed.head);
  expect(prepared.current.snapshot.head).not.toBe(run.last_observed.head);
  const repositoryBefore = await readFile(join(value.repo, "overlay.txt"), "utf8");
  const accepted = await acceptHandoff(
    run.run_id,
    prepared.evidence,
    "test-operator",
    "The repository was reconciled outside Regrafter.",
    options(value)
  );
  expect(accepted.state).toBe("handed_off");
  expect(accepted.handoff?.release).toBe("released");
  expect(accepted.handoff?.previous).toEqual(run.last_observed);
  expect(await readLease(value.stateDir, run.git_common_dir)).toBeUndefined();
  expect(await readFile(join(value.repo, "overlay.txt"), "utf8")).toBe(repositoryBefore);

  const retried = await acceptHandoff(
    run.run_id,
    prepared.evidence,
    "test-operator",
    "The repository was reconciled outside Regrafter.",
    options(value)
  );
  expect(retried.handoff?.release).toBe("released");
});

it("accepts an evidence-bound handoff from detached HEAD", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  git(value.repo, ["checkout", "--detach"]);
  const prepared = await prepareHandoff(blocked.run_id, options(value));
  expect(prepared.current.snapshot.branch).toBe("(detached)");
  const accepted = await acceptHandoff(
    blocked.run_id,
    prepared.evidence,
    "test-operator",
    "Accepted detached repository state.",
    options(value)
  );
  expect(accepted.state).toBe("handed_off");
  expect(await readLease(value.stateDir, accepted.git_common_dir)).toBeUndefined();
});

it("rejects a repointed Git directory during handoff preparation", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const run = await inspectRun(blocked.run_id, options(value));
  await repointGitDirectory(value.repo);
  await expect(prepareHandoff(run.run_id, options(value))).rejects.toThrow(
    "repository identity changed"
  );
  expect((await readLease(value.stateDir, run.git_common_dir))?.run_id).toBe(run.run_id);
});

it("rejects a repointed Git directory during handoff acceptance", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const run = await inspectRun(blocked.run_id, options(value));
  const prepared = await prepareHandoff(run.run_id, options(value));
  await repointGitDirectory(value.repo);
  await expect(
    acceptHandoff(
      run.run_id,
      prepared.evidence,
      "test-operator",
      "Accept reviewed state.",
      options(value)
    )
  ).rejects.toThrow("repository identity changed");
  expect((await readLease(value.stateDir, run.git_common_dir))?.run_id).toBe(run.run_id);
});

it("binds acceptance to the prepared repository state", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const prepared = await prepareHandoff(blocked.run_id, options(value));
  await expect(
    acceptHandoff(blocked.run_id, "invalid", "test-operator", "Accept state.", options(value))
  ).rejects.toThrow("lowercase SHA-256");
  await expect(
    acceptHandoff(blocked.run_id, prepared.evidence, " ", "Accept state.", options(value))
  ).rejects.toThrow("handoff actor");
  await writeFile(join(value.repo, "overlay.txt"), "changed after prepare\n");
  await expect(
    acceptHandoff(
      blocked.run_id,
      prepared.evidence,
      "test-operator",
      "Accept reviewed state.",
      options(value)
    )
  ).rejects.toThrow("changed after handoff preparation");
  const run = await inspectRun(blocked.run_id, options(value));
  expect(run.state).toBe("blocked");
  expect((await readLease(value.stateDir, run.git_common_dir))?.run_id).toBe(run.run_id);
});

it("rejects credential-bearing handoff audit text without persisting it", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const prepared = await prepareHandoff(blocked.run_id, options(value));
  await expect(
    acceptHandoff(
      blocked.run_id,
      prepared.evidence,
      "test-operator",
      "Reviewed at https://user:super-secret@example.com/repository.git.",
      options(value)
    )
  ).rejects.toThrow("must not contain credentials");
  await expect(
    acceptHandoff(
      blocked.run_id,
      prepared.evidence,
      "test-operator",
      "Reviewed at https://example.com/repository?access_token=query-secret-abc123.",
      options(value)
    )
  ).rejects.toThrow("must not contain credentials");
  const run = await inspectRun(blocked.run_id, options(value));
  expect(JSON.stringify(run)).not.toContain("super-secret");
  expect(JSON.stringify(run)).not.toContain("query-secret-abc123");
  expect((await readLease(value.stateDir, run.git_common_dir))?.run_id).toBe(run.run_id);
});

it("finishes a durable handoff after lease release previously failed", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const run = await inspectRun(blocked.run_id, options(value));
  const prepared = await prepareHandoff(run.run_id, options(value));
  await savePendingHandoff(value.stateDir, run, prepared);

  const retried = await acceptHandoff(
    run.run_id,
    prepared.evidence,
    "test-operator",
    "Accepted after external reconciliation.",
    options(value)
  );
  expect(retried.handoff?.release).toBe("released");
  expect(await readLease(value.stateDir, run.git_common_dir)).toBeUndefined();
});

it("finishes a pending audit without touching a later lease", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const run = await inspectRun(blocked.run_id, options(value));
  const prepared = await prepareHandoff(run.run_id, options(value));
  await savePendingHandoff(value.stateDir, run, prepared);
  await releaseLease(value.stateDir, run.git_common_dir, run.run_id);
  const foreign = {
    ...prepared.lease,
    run_id: "run-99999999999999999999999999999999"
  };
  await acquireLease(value.stateDir, foreign);

  const retried = await acceptHandoff(
    run.run_id,
    prepared.evidence,
    "test-operator",
    "Accepted after external reconciliation.",
    options(value)
  );
  expect(retried.handoff?.release).toBe("released");
  expect((await readLease(value.stateDir, run.git_common_dir))?.run_id).toBe(foreign.run_id);
});

it("hands off a historical failed run without a graft baseline", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const current = await inspectRun(blocked.run_id, options(value));
  const legacy = { ...current, state: "failed" as const };
  delete legacy.graft_baseline;
  delete legacy.rejected_completion;
  delete legacy.report;
  await saveRun(value.stateDir, legacy);

  const prepared = await prepareHandoff(legacy.run_id, options(value));
  const accepted = await acceptHandoff(
    legacy.run_id,
    prepared.evidence,
    "test-operator",
    "Accepted historical failed state.",
    options(value)
  );
  expect(accepted.state).toBe("handed_off");
  expect(await readLease(value.stateDir, legacy.git_common_dir)).toBeUndefined();
});

it("rejects handoff while the controller is working", async () => {
  const value = await fixture();
  const blocked = await startRun(value.repo, "Update.", {
    ...options(value),
    launcher: dirtyLauncher(value.repo)
  });
  const run = await inspectRun(blocked.run_id, options(value));
  const working = { ...run, state: "working" as const };
  delete working.rejected_completion;
  await saveRun(value.stateDir, {
    ...working,
    process: { pid: process.pid, started_at: new Date().toISOString() }
  });
  await expect(prepareHandoff(run.run_id, options(value))).rejects.toThrow("working");
});
