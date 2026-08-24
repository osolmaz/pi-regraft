import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { PiLaunchPlan } from "@osolmaz/pi-factory";
import {
  abortRun,
  attachRun,
  findRuns,
  inspectRun,
  launchAgent,
  sendRun,
  startRun,
  type AgentLauncher,
  type ControllerOptions
} from "../../src/regrafter/controller.js";
import { readLease } from "../../src/regrafter/lease.js";
import { saveRun } from "../../src/regrafter/runs.js";

async function fixture(): Promise<{
  repo: string;
  stateDir: string;
  appFile: string;
  configFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "regrafter-test-"));
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
  await writeFile(appFile, manifest(join(root, "pi")));
  return { repo, stateDir, appFile, configFile: join(root, "config.json") };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function manifest(stateDir: string): string {
  return `schema_version = 1\nid = "regrafter-test"\nname = "Regrafter test"\nversion = "1.0.0"\nstate_dir = ${JSON.stringify(stateDir)}\npi_command = ["node", "./fake-pi.mjs"]\ntools = ["read"]\n[provider]\nid = "test"\nbase_url = "http://127.0.0.1:1/v1"\n[model]\nid = "test"\n`;
}
function report(state: "completed" | "needs_decision" = "completed"): Record<string, unknown> {
  return {
    schema_version: 1,
    state,
    summary: state === "completed" ? "Update complete." : "A choice is required.",
    ...(state === "needs_decision"
      ? {
          decision: {
            id: "decision-1",
            graft: "goal",
            question: "Which behavior?",
            context: "Both are valid.",
            options: [
              {
                id: "local",
                label: "Keep local",
                effect: "Preserves behavior.",
                files: ["goal.ts"],
                reversible: true
              },
              {
                id: "upstream",
                label: "Take upstream",
                effect: "Changes behavior.",
                files: ["goal.ts"],
                reversible: true
              }
            ],
            recommendation: { option: "local", reason: "The note requires it." },
            evidence: ["regraft note"],
            repository: { branch: "main", head: "abc", dirty_paths: ["goal.ts"] }
          }
        }
      : {}),
    commits: [],
    checks: [],
    updated_grafts: [],
    next: state === "completed" ? "None." : "Answer decision-1."
  };
}
function launcherFor(value: Record<string, unknown>, sessionId = "session-1"): AgentLauncher {
  return async (plan) => {
    const path = plan.env["REGRAFTER_REPORT_FILE"];
    if (path === undefined) throw new Error("missing report path");
    await writeFile(path, `${JSON.stringify(value)}\n`);
    return { code: 0, signal: null, sessionId };
  };
}
function options(
  base: { stateDir: string; appFile: string },
  launcher: AgentLauncher
): ControllerOptions {
  return { ...base, launcher };
}

it("completes a run and releases the repository lease", async () => {
  const value = await fixture();
  let authoritySent = false;
  const launcher: AgentLauncher = async (plan) => {
    authoritySent = plan.args.some((arg) => arg.includes("Controller authority: overlay commits"));
    return await launcherFor(report())(plan, "unused.log");
  };
  const result = await startRun(value.repo, "Update all grafts.", {
    ...options(value, launcher),
    authority: { overlay_commits: true, push: false, pull_requests: false }
  });
  expect(result.state).toBe("completed");
  const run = await inspectRun(result.run_id, value);
  expect(run.session_id).toBe("session-1");
  expect(run.authority.overlay_commits).toBe(true);
  expect(authoritySent).toBe(true);
  expect(await readLease(value.stateDir, run.git_common_dir)).toBeUndefined();
});

it("launches the ambient profile when a model is configured", async () => {
  const value = await fixture();
  await writeFile(
    value.configFile,
    `${JSON.stringify({ version: 1, auth: "pi", model: "huggingface/moonshotai/Kimi-K3:fireworks-ai" })}\n`
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/host-pi-agent");
  try {
    let seen: PiLaunchPlan | undefined;
    const launcher: AgentLauncher = async (plan, logPath) => {
      seen = plan;
      return await launcherFor(report())(plan, logPath);
    };
    const result = await startRun(value.repo, "Update all grafts.", options(value, launcher));
    expect(result.state).toBe("completed");
    expect(seen?.env["PI_CODING_AGENT_DIR"]).toBe("/tmp/host-pi-agent");
    expect(seen?.env["PI_CODING_AGENT_SESSION_DIR"]).toContain("sessions");
    const args = seen?.args ?? [];
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-prompt-templates");
    expect(args).toContain("--no-themes");
    const providerIndex = args.indexOf("--provider");
    expect(args[providerIndex + 1]).toBe("huggingface");
    const modelIndex = args.indexOf("--model");
    expect(args[modelIndex + 1]).toBe("moonshotai/Kimi-K3:fireworks-ai");
    expect(args.some((arg) => arg.includes("pi-huggingface-oauth"))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps the isolated profile without a config file", async () => {
  const value = await fixture();
  let seen: PiLaunchPlan | undefined;
  const launcher: AgentLauncher = async (plan, logPath) => {
    seen = plan;
    return await launcherFor(report())(plan, logPath);
  };
  const result = await startRun(value.repo, "Update all grafts.", options(value, launcher));
  expect(result.state).toBe("completed");
  expect(seen?.env["PI_CODING_AGENT_DIR"]).toContain("pi-config-runtime");
  expect(seen?.args).not.toContain("--no-extensions");
});

it("fails with guidance when the config has no model", async () => {
  const value = await fixture();
  await writeFile(value.configFile, '{"version":1,"auth":"pi"}\n');
  await expect(
    startRun(value.repo, "Update all grafts.", options(value, launcherFor(report())))
  ).rejects.toThrow("regrafter config set model");
});

it("resumes one Pi session after a matching decision", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update goal.",
    options(value, launcherFor(report("needs_decision")))
  );
  expect(paused.state).toBe("needs_decision");
  await expect(
    sendRun(paused.run_id, "Choose local.", "wrong", options(value, launcherFor(report())))
  ).rejects.toThrow("expects decision decision-1");
  let resumed = false;
  const launcher: AgentLauncher = async (plan) => {
    resumed =
      plan.args.includes("session-1") && plan.args.some((arg) => arg.includes("decision-1"));
    const path = plan.env["REGRAFTER_REPORT_FILE"] ?? "";
    await writeFile(path, JSON.stringify(report()));
    return { code: 0, signal: null, sessionId: "session-1" };
  };
  const completed = await sendRun(paused.run_id, "Choose local.", "decision-1", {
    ...options(value, launcher),
    grant: { overlay_commits: false, push: true, pull_requests: false }
  });
  expect(completed.state).toBe("completed");
  expect((await inspectRun(paused.run_id, value)).authority.push).toBe(true);
  expect(resumed).toBe(true);
});

it("rejects a fresh Pi session when resuming", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update.",
    options(value, launcherFor(report("needs_decision")))
  );
  const wrongSession = launcherFor(report(), "session-other");
  await expect(
    sendRun(paused.run_id, "Keep local.", "decision-1", options(value, wrongSession))
  ).rejects.toThrow("unexpected Pi session session-other");
  expect((await inspectRun(paused.run_id, value)).state).toBe("failed");
});

it("drives a two-step decision through a bounded fake Pi process", async () => {
  const value = await fixture();
  const script = join(dirname(value.appFile), "fake-pi.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";\nconst resumed = process.argv.includes("--session");\nwriteFileSync(process.env.REGRAFTER_REPORT_FILE, JSON.stringify(resumed ? ${JSON.stringify(report())} : ${JSON.stringify(report("needs_decision"))}));\nprocess.stdout.write(JSON.stringify({type:"session",id:"session-process"}));\n`
  );
  const paused = await startRun(value.repo, "Update.", value);
  expect(paused.state).toBe("needs_decision");
  const completed = await sendRun(paused.run_id, "Keep local.", "decision-1", value);
  expect(completed.state).toBe("completed");
  expect(completed.session_id).toBe("session-process");
});

it("keeps a lease across a pause and rejects a competing run", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update goal.",
    options(value, launcherFor(report("needs_decision")))
  );
  await expect(
    startRun(value.repo, "Competing update.", options(value, launcherFor(report())))
  ).rejects.toThrow(`leased by ${paused.run_id}`);
  const runs = await findRuns(value.repo, value);
  expect(runs.map((run) => run.run_id)).toEqual([paused.run_id]);
});

it("blocks resume and abort after an outside repository change", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update goal.",
    options(value, launcherFor(report("needs_decision")))
  );
  await writeFile(join(value.repo, "outside.txt"), "changed\n");
  await expect(
    sendRun(paused.run_id, "Choose local.", "decision-1", options(value, launcherFor(report())))
  ).rejects.toThrow("repository changed");
  await expect(abortRun(paused.run_id, value)).rejects.toThrow("lease retained");
});

it("aborts only from the last verified repository state", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update goal.",
    options(value, launcherFor(report("needs_decision")))
  );
  const aborted = await abortRun(paused.run_id, value);
  expect(aborted.state).toBe("aborted");
  expect(await readLease(value.stateDir, aborted.git_common_dir)).toBeUndefined();
});

describe("interruption recovery", () => {
  it("records an interrupted process and resumes only from the same snapshot", async () => {
    const value = await fixture();
    const dirtyPath = join(value.repo, "interrupted.txt");
    const interruptedLauncher: AgentLauncher = async () => {
      await writeFile(dirtyPath, "partial work\n");
      return { code: 1, signal: "SIGTERM" };
    };
    await expect(
      startRun(value.repo, "Update.", options(value, interruptedLauncher))
    ).rejects.toThrow("SIGTERM");
    const [run] = await findRuns(value.repo, value);
    expect(run?.state).toBe("interrupted");
    expect(run?.last_observed.dirty_paths).toEqual(["interrupted.txt"]);
    const resumeLauncher: AgentLauncher = async (plan, logPath) => {
      await rm(dirtyPath);
      return await launcherFor(report())(plan, logPath);
    };
    const completed = await sendRun(
      run?.run_id ?? "",
      "Continue safely.",
      undefined,
      options(value, resumeLauncher)
    );
    expect(completed.state).toBe("completed");
  });

  it("records a nonzero exit and a missing session as failed", async () => {
    const exited = await fixture();
    const nonzero: AgentLauncher = async () => ({ code: 2, signal: null });
    await expect(startRun(exited.repo, "Update.", options(exited, nonzero))).rejects.toThrow(
      "exited with 2"
    );
    expect((await findRuns(exited.repo, exited))[0]?.state).toBe("failed");

    const missing = await fixture();
    const noSession: AgentLauncher = async (plan) => {
      await writeFile(plan.env["REGRAFTER_REPORT_FILE"] ?? "", JSON.stringify(report()));
      return { code: 0, signal: null };
    };
    await expect(startRun(missing.repo, "Update.", options(missing, noSession))).rejects.toThrow(
      "did not identify"
    );
    expect((await findRuns(missing.repo, missing))[0]?.state).toBe("failed");
  });
});

it("attaches the TUI to an idle session without releasing its lease", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update.",
    options(value, launcherFor(report("needs_decision")))
  );
  const attached = await attachRun(paused.run_id, value);
  expect(attached.state).toBe("needs_decision");
  expect((await readLease(value.stateDir, attached.git_common_dir))?.run_id).toBe(paused.run_id);
});

it("records a nonzero attached TUI as failed", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update.",
    options(value, launcherFor(report("needs_decision")))
  );
  await writeFile(join(dirname(value.appFile), "fake-pi.mjs"), "process.exitCode = 2;\n");
  await expect(attachRun(paused.run_id, value)).rejects.toThrow("TUI exited with 2");
  expect((await inspectRun(paused.run_id, value)).state).toBe("failed");
});

it("classifies a dead working controller during inspection", async () => {
  const value = await fixture();
  const result = await startRun(value.repo, "Done.", options(value, launcherFor(report())));
  const completed = await inspectRun(result.run_id, value);
  const working = {
    ...completed,
    state: "working" as const,
    process: { pid: 2147483647, started_at: new Date().toISOString() }
  };
  await saveRun(value.stateDir, working);
  await writeFile(join(value.repo, "dead-controller.txt"), "partial work\n");
  const interrupted = await inspectRun(working.run_id, value);
  expect(interrupted.state).toBe("interrupted");
  expect(interrupted.last_observed.dirty_paths).toEqual(["dead-controller.txt"]);
});

it("rejects invalid lifecycle transitions before launch", async () => {
  const value = await fixture();
  await expect(startRun(value.repo, " ", options(value, launcherFor(report())))).rejects.toThrow(
    "must not be empty"
  );
  const result = await startRun(value.repo, "Done.", options(value, launcherFor(report())));
  await expect(
    sendRun(result.run_id, "Again.", undefined, options(value, launcherFor(report())))
  ).rejects.toThrow("cannot resume");
  await expect(
    sendRun(result.run_id, " ", undefined, options(value, launcherFor(report())))
  ).rejects.toThrow("must not be empty");
  await expect(attachRun(result.run_id, value)).rejects.toThrow("cannot attach");
  await expect(abortRun(result.run_id, value)).rejects.toThrow("does not own");

  const complete = await inspectRun(result.run_id, value);
  const working = {
    ...complete,
    state: "working" as const,
    process: { pid: process.pid, started_at: new Date().toISOString() }
  };
  await saveRun(value.stateDir, working);
  expect((await inspectRun(result.run_id, value)).state).toBe("working");

  const noSession = { ...complete, state: "blocked" as const };
  delete noSession.session_id;
  await saveRun(value.stateDir, noSession);
  await expect(attachRun(result.run_id, value)).rejects.toThrow("has no Pi session");
  expect(await findRuns(undefined, value)).toHaveLength(1);
});

it("records launch and report failures without releasing the lease", async () => {
  const thrown = await fixture();
  const throws: AgentLauncher = async () => {
    throw new Error("launcher unavailable");
  };
  await expect(startRun(thrown.repo, "Update.", options(thrown, throws))).rejects.toThrow(
    "launcher unavailable"
  );
  expect((await findRuns(thrown.repo, thrown))[0]?.state).toBe("failed");

  const absent = await fixture();
  const noReport: AgentLauncher = async () => ({ code: 0, signal: null, sessionId: "session-1" });
  await expect(startRun(absent.repo, "Update.", options(absent, noReport))).rejects.toThrow(
    "ENOENT"
  );
  expect((await findRuns(absent.repo, absent))[0]?.state).toBe("failed");

  const malformed = await fixture();
  const badReport: AgentLauncher = async (plan) => {
    await writeFile(plan.env["REGRAFTER_REPORT_FILE"] ?? "", "{}\n");
    return { code: 0, signal: null, sessionId: "session-1" };
  };
  await expect(startRun(malformed.repo, "Update.", options(malformed, badReport))).rejects.toThrow(
    "invalid Regrafter report"
  );
});

it("keeps invalid dirty completion resumable and leased", async () => {
  const value = await fixture();
  const dirtyCompletion: AgentLauncher = async (plan, logPath) => {
    await writeFile(join(value.repo, "uncommitted.txt"), "not done\n");
    return await launcherFor(report())(plan, logPath);
  };
  const result = await startRun(value.repo, "Update.", options(value, dirtyCompletion));
  expect(result.state).toBe("blocked");
  expect(result.blocker?.reason).toContain("completion failed");
  const [run] = await findRuns(value.repo, value);
  expect(run).toBeDefined();
  if (run === undefined) throw new Error("missing blocked run");
  expect(run.state).toBe("blocked");
  expect(run.session_id).toBe("session-1");
  expect(run.rejected_completion?.reasons[0]).toContain("worktree is dirty");
  expect((await readLease(value.stateDir, run.git_common_dir))?.run_id).toBe(run.run_id);

  let authoritySent = false;
  const resumeLauncher: AgentLauncher = async (plan, logPath) => {
    authoritySent = plan.args.some((arg) => arg.includes("Controller authority: overlay commits"));
    await rm(join(value.repo, "uncommitted.txt"));
    return await launcherFor(report())(plan, logPath);
  };
  const completed = await sendRun(run.run_id, "Finish the authorized overlay.", undefined, {
    ...options(value, resumeLauncher),
    grant: { overlay_commits: true, push: false, pull_requests: false }
  });
  expect(completed.state).toBe("completed");
  expect(authoritySent).toBe(true);
  expect(await readLease(value.stateDir, run.git_common_dir)).toBeUndefined();
});

it("aborts a rejected completion from its exact verified snapshot", async () => {
  const value = await fixture();
  const dirtyCompletion: AgentLauncher = async (plan, logPath) => {
    await writeFile(join(value.repo, "uncommitted.txt"), "not done\n");
    return await launcherFor(report())(plan, logPath);
  };
  const blocked = await startRun(value.repo, "Update.", options(value, dirtyCompletion));
  const aborted = await abortRun(blocked.run_id, value);
  expect(aborted.state).toBe("aborted");
  expect(aborted.rejected_completion).toBeUndefined();
  expect(await readLease(value.stateDir, aborted.git_common_dir)).toBeUndefined();
  expect(await readFile(join(value.repo, "uncommitted.txt"), "utf8")).toBe("not done\n");
});

it("clears rejected completion state before an attached retry", async () => {
  const value = await fixture();
  const dirtyCompletion: AgentLauncher = async (plan, logPath) => {
    await writeFile(join(value.repo, "uncommitted.txt"), "not done\n");
    return await launcherFor(report())(plan, logPath);
  };
  const blocked = await startRun(value.repo, "Update.", options(value, dirtyCompletion));
  await writeFile(
    join(dirname(value.appFile), "fake-pi.mjs"),
    `import { rmSync, writeFileSync } from "node:fs"; rmSync("uncommitted.txt"); writeFileSync(process.env.REGRAFTER_REPORT_FILE, ${JSON.stringify(JSON.stringify(report()))});\n`
  );
  const completed = await attachRun(blocked.run_id, value);
  expect(completed.state).toBe("completed");
  expect(completed.rejected_completion).toBeUndefined();
});

it("preserves rejected completion evidence when an attached retry has no report", async () => {
  const value = await fixture();
  const dirtyCompletion: AgentLauncher = async (plan, logPath) => {
    await writeFile(join(value.repo, "uncommitted.txt"), "not done\n");
    return await launcherFor(report())(plan, logPath);
  };
  const blocked = await startRun(value.repo, "Update.", options(value, dirtyCompletion));
  const original = await inspectRun(blocked.run_id, value);
  const attached = await attachRun(blocked.run_id, value);
  expect(attached.state).toBe("blocked");
  expect(attached.report).toEqual(original.report);
  expect(attached.rejected_completion).toEqual(original.rejected_completion);
});

it("rejects stale decisions and aborting a working run", async () => {
  const value = await fixture();
  const paused = await startRun(
    value.repo,
    "Update.",
    options(value, launcherFor(report("needs_decision")))
  );
  const pausedRecord = await inspectRun(paused.run_id, value);
  const noDecision = { ...pausedRecord };
  delete noDecision.report;
  await saveRun(value.stateDir, noDecision);
  await expect(
    sendRun(paused.run_id, "Answer.", "decision-old", options(value, launcherFor(report())))
  ).rejects.toThrow("no pending decision");

  const working = {
    ...noDecision,
    state: "working" as const,
    process: { pid: process.pid, started_at: new Date().toISOString() }
  };
  await saveRun(value.stateDir, working);
  await expect(abortRun(paused.run_id, value)).rejects.toThrow("is working");
});

it("captures a Pi JSON session header and complete log", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-launch-"));
  const script = join(root, "child.mjs");
  await writeFile(
    script,
    'import { spawn } from "node:child_process"; const background = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "inherit" }); background.unref(); process.stdout.write("not-json\\n" + JSON.stringify({type:"other"}) + "\\n" + JSON.stringify({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"draft"}}) + "\\n" + JSON.stringify({type:"session",id:"session-json"})); process.stderr.write("diagnostic " + process.env.TEST_SECRET_TOKEN);\n'
  );
  const plan: PiLaunchPlan = {
    appId: "test",
    appName: "Test",
    command: process.execPath,
    args: [script],
    env: { TEST_SECRET_TOKEN: "super-secret-value" },
    cwd: root,
    runtimeConfig: {
      configDir: root,
      modelsPath: join(root, "models.json"),
      settingsPath: join(root, "settings.json")
    },
    warnings: []
  };
  const log = join(root, "agent.log");
  const started = Date.now();
  const result = await launchAgent(plan, log);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(result.sessionId).toBe("session-json");
  const content = await readFile(log, "utf8");
  expect(content).toContain("diagnostic [redacted]");
  expect(content).not.toContain("super-secret-value");
  expect(content).toContain('"type":"other"');
  expect(content).not.toContain("message_update");
  expect(result.sessionId).toBe("session-json");
});
