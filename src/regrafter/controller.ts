import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import {
  createPiLaunchPlan,
  loadPiApp,
  manifestToDefinition,
  writePiRuntimeConfig,
  type PiLaunchPlan
} from "@osolmaz/pi-factory";
import { resolveAppProfile } from "./ambient.js";
import { completionProblems } from "./completion.js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { captureGraftBaseline } from "./graft-baseline.js";
import { identifyRepository, sameSnapshot, snapshotRepository } from "./git.js";
import {
  assertEvidenceDigest,
  captureRepositoryEvidence,
  createHandoffCandidate
} from "./handoff-evidence.js";
import { acquireLease, readLease, releaseLease, updateLease } from "./lease.js";
import { controllerResult, readAgentReport } from "./reports.js";
import { withRunLock } from "./run-lock.js";
import { listRuns, loadRun, reportPath, saveRun, stateDirectory } from "./runs.js";
import type {
  AgentReport,
  ControllerResult,
  HandoffCandidate,
  LeaseRecord,
  RepositorySnapshot,
  RunAuthority,
  RunRecord
} from "./types.js";

export type LaunchResult = { code: number; signal: NodeJS.Signals | null; sessionId?: string };
export type AgentLauncher = (plan: PiLaunchPlan, logPath: string) => Promise<LaunchResult>;
export type ControllerOptions = {
  stateDir?: string;
  appFile?: string;
  configFile?: string;
  launcher?: AgentLauncher;
};
export type StartOptions = ControllerOptions & { authority?: RunAuthority };
export type SendOptions = ControllerOptions & { grant?: RunAuthority };

function now(): string {
  return new Date().toISOString();
}
function packageRoot(): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const buildRoot = dirname(sourceDirectory);
  return dirname(buildRoot);
}
function defaultAppFile(): string {
  return join(packageRoot(), "pi-factory.toml");
}
function runId(): string {
  return `run-${randomBytes(16).toString("hex")}`;
}

export async function startRun(
  repositoryInput: string,
  request: string,
  options: StartOptions = {}
): Promise<ControllerResult> {
  if (request.trim() === "") throw new Error("request must not be empty");
  const stateDir = options.stateDir ?? stateDirectory();
  const identified = await identifyRepository(repositoryInput);
  const graftBaseline = await captureGraftBaseline(identified.repository, identified.snapshot.head);
  const id = runId();
  const timestamp = now();
  const run: RunRecord = {
    schema_version: 1,
    run_id: id,
    repository: identified.repository,
    git_common_dir: identified.gitCommonDir,
    state: "ready",
    created_at: timestamp,
    updated_at: timestamp,
    starting: identified.snapshot,
    last_observed: identified.snapshot,
    authority: options.authority ?? noAuthority(),
    graft_baseline: graftBaseline
  };
  const lease = leaseFor(run);
  await acquireLease(stateDir, lease);
  try {
    await saveRun(stateDir, run);
    return await invoke(run, initialMessage(request, run.authority), stateDir, options);
  } catch (error) {
    if (await runExists(stateDir, id)) throw error;
    await releaseLease(stateDir, run.git_common_dir, id);
    throw error;
  }
}

export async function sendRun(
  id: string,
  message: string,
  decisionId: string | undefined,
  options: SendOptions = {}
): Promise<ControllerResult> {
  if (message.trim() === "") throw new Error("message must not be empty");
  const stateDir = options.stateDir ?? stateDirectory();
  return await withRunLock(stateDir, id, async () => {
    const run = await loadRun(stateDir, id);
    await assertResumable(run, decisionId, stateDir);
    const authorized = { ...run, authority: mergeAuthority(run.authority, options.grant) };
    return await invoke(
      authorized,
      resumeMessage(message, decisionId, authorized.authority),
      stateDir,
      options
    );
  });
}

export async function inspectRun(id: string, options: ControllerOptions = {}): Promise<RunRecord> {
  const stateDir = options.stateDir ?? stateDirectory();
  const run = await loadRun(stateDir, id);
  if (run.state !== "working") return run;
  if (run.process !== undefined && processAlive(run.process.pid)) return run;
  const idle = withoutProcess(run);
  const reason = "controller process is no longer running";
  const observed = await interruptedSnapshot(run, reason);
  const interrupted: RunRecord = {
    ...idle,
    state: "interrupted",
    updated_at: now(),
    last_observed: observed.snapshot,
    interruption: { reason: observed.reason, at: now() }
  };
  await saveRun(stateDir, interrupted);
  return interrupted;
}

export async function findRuns(
  repository: string | undefined,
  options: ControllerOptions = {}
): Promise<RunRecord[]> {
  const stateDir = options.stateDir ?? stateDirectory();
  if (repository === undefined) return await listRuns(stateDir);
  const identified = await identifyRepository(repository);
  return await listRuns(stateDir, identified.repository);
}

export async function attachRun(id: string, options: ControllerOptions = {}): Promise<RunRecord> {
  const stateDir = options.stateDir ?? stateDirectory();
  return await withRunLock(stateDir, id, async () => attachRunLocked(id, stateDir, options));
}

async function attachRunLocked(
  id: string,
  stateDir: string,
  options: ControllerOptions
): Promise<RunRecord> {
  const run = await inspectRun(id, options);
  const sessionId = attachSession(run, id);
  await assertLeaseAndSnapshot(run, stateDir);
  const working: RunRecord = {
    ...withoutReportAndInterruption(run),
    state: "working",
    process: { pid: process.pid, started_at: now() },
    updated_at: now()
  };
  await saveRun(stateDir, working);
  await updateLease(stateDir, { ...leaseFor(working), process_id: process.pid });
  const outputPath = reportPath(stateDir, id);
  await rm(outputPath, { force: true });
  const loaded = await loadPiApp({ appFile: options.appFile ?? defaultAppFile() });
  const base = await manifestToDefinition(loaded.manifest, loaded.appRoot);
  const config = await loadConfig(options.configFile ?? defaultConfigPath());
  const { app, profile } = resolveAppProfile(base, config);
  const runtime = await writePiRuntimeConfig(app);
  const plan = await createPiLaunchPlan(app, runtime, {
    cwd: run.repository,
    mode: "interactive",
    session: sessionId,
    name: `Regrafter ${id}`,
    profile
  });
  const launch = await launchInteractive({
    ...plan,
    env: { ...plan.env, REGRAFTER_REPORT_FILE: outputPath }
  });
  if (launch.signal !== null)
    return await interrupt(working, stateDir, `TUI terminated by ${launch.signal}`);
  if (launch.code !== 0)
    return await failWithoutReport(working, stateDir, `TUI exited with ${launch.code.toString()}`);
  const observed = await snapshotRepository(run.repository);
  const report = await readAgentReport(outputPath).catch(() => undefined);
  return await finishAttachment(run, working, report, observed, stateDir);
}

function attachSession(run: RunRecord, id: string): string {
  if (new Set(["working", "completed", "aborted", "handed_off"]).has(run.state)) {
    throw new Error(`run ${id} cannot attach from ${run.state}`);
  }
  if (run.session_id === undefined) throw new Error(`run ${id} has no Pi session`);
  return run.session_id;
}

async function finishAttachment(
  original: RunRecord,
  working: RunRecord,
  report: AgentReport | undefined,
  observed: RepositorySnapshot,
  stateDir: string
): Promise<RunRecord> {
  if (report !== undefined) {
    const sessionId = working.session_id;
    if (sessionId === undefined) throw new Error(`run ${working.run_id} has no Pi session`);
    return await finishReportedRun(working, report, observed, sessionId, stateDir);
  }
  const finished: RunRecord = {
    ...withoutProcess(working),
    state: original.state,
    ...(original.report === undefined ? {} : { report: original.report }),
    updated_at: now(),
    last_observed: observed
  };
  await saveRun(stateDir, finished);
  await updateLease(stateDir, leaseFor(finished));
  return finished;
}

export async function abortRun(id: string, options: ControllerOptions = {}): Promise<RunRecord> {
  const stateDir = options.stateDir ?? stateDirectory();
  return await withRunLock(stateDir, id, async () => abortRunLocked(id, stateDir, options));
}

async function abortRunLocked(
  id: string,
  stateDir: string,
  options: ControllerOptions
): Promise<RunRecord> {
  const run = await inspectRun(id, options);
  if (run.state === "working") throw new Error(`run ${id} is working and cannot be aborted`);
  const lease = await readLease(stateDir, run.git_common_dir);
  if (lease?.run_id !== id) throw new Error(`run ${id} does not own its repository lease`);
  const current = await snapshotRepository(run.repository);
  if (!sameSnapshot(current, run.last_observed)) {
    throw new Error("repository changed since the last verified Regrafter state; lease retained");
  }
  const aborted: RunRecord = {
    ...run,
    state: "aborted",
    updated_at: now(),
    last_observed: current
  };
  await saveRun(stateDir, aborted);
  await releaseLease(stateDir, run.git_common_dir, id);
  return aborted;
}

export async function prepareHandoff(
  id: string,
  options: ControllerOptions = {}
): Promise<HandoffCandidate> {
  const stateDir = options.stateDir ?? stateDirectory();
  return await withRunLock(stateDir, id, async () => {
    const run = await inspectRun(id, options);
    assertHandoffSource(run);
    const lease = await ownedLease(run, stateDir);
    const current = await captureRepositoryEvidence(run.repository);
    return createHandoffCandidate(run, lease, current);
  });
}

export async function acceptHandoff(
  id: string,
  evidence: string,
  actor: string,
  reason: string,
  options: ControllerOptions = {}
): Promise<RunRecord> {
  assertEvidenceDigest(evidence);
  assertAuditText(actor, reason);
  const stateDir = options.stateDir ?? stateDirectory();
  return await withRunLock(stateDir, id, async () => {
    let run = await loadRun(stateDir, id);
    if (run.state === "handed_off") {
      assertMatchingHandoff(run, evidence, actor, reason);
      return await finishHandoffRelease(run, stateDir);
    }
    run = await inspectRun(id, options);
    assertHandoffSource(run);
    const lease = await ownedLease(run, stateDir);
    const current = await captureRepositoryEvidence(run.repository);
    const candidate = createHandoffCandidate(run, lease, current);
    if (candidate.evidence !== evidence) {
      throw new Error("repository or lease changed after handoff preparation");
    }
    const acceptedAt = now();
    const idle = withoutProcess(run);
    delete idle.rejected_completion;
    const accepted: RunRecord = {
      ...idle,
      state: "handed_off",
      updated_at: acceptedAt,
      last_observed: current.snapshot,
      handoff: {
        schema_version: 1,
        evidence,
        actor,
        reason,
        accepted_at: acceptedAt,
        previous: run.last_observed,
        accepted: current,
        release: "pending"
      }
    };
    await saveRun(stateDir, accepted);
    return await finishHandoffRelease(accepted, stateDir);
  });
}

async function finishHandoffRelease(run: RunRecord, stateDir: string): Promise<RunRecord> {
  const handoff = run.handoff;
  if (handoff === undefined) throw new Error(`run ${run.run_id} has no handoff audit`);
  if (handoff.release === "released") return run;
  const lease = await readLease(stateDir, run.git_common_dir);
  if (lease?.run_id === run.run_id) {
    await releaseLease(stateDir, run.git_common_dir, run.run_id);
  }
  const finished: RunRecord = {
    ...run,
    updated_at: now(),
    handoff: { ...handoff, release: "released", released_at: now() }
  };
  await saveRun(stateDir, finished);
  return finished;
}

function assertHandoffSource(run: RunRecord): void {
  if (run.state === "working") throw new Error(`run ${run.run_id} is working and cannot hand off`);
  if (!new Set(["needs_decision", "blocked", "failed", "interrupted"]).has(run.state)) {
    throw new Error(`run ${run.run_id} cannot hand off from ${run.state}`);
  }
}

async function ownedLease(run: RunRecord, stateDir: string): Promise<LeaseRecord> {
  const lease = await readLease(stateDir, run.git_common_dir);
  if (lease?.run_id !== run.run_id) {
    throw new Error(`run ${run.run_id} does not own its repository lease`);
  }
  return lease;
}

function assertAuditText(actor: string, reason: string): void {
  if (actor.trim() === "" || Buffer.byteLength(actor, "utf8") > 128) {
    throw new Error("handoff actor must contain 1 to 128 UTF-8 bytes");
  }
  if (reason.trim() === "" || Buffer.byteLength(reason, "utf8") > 2048) {
    throw new Error("handoff reason must contain 1 to 2048 UTF-8 bytes");
  }
}

function assertMatchingHandoff(
  run: RunRecord,
  evidence: string,
  actor: string,
  reason: string
): void {
  const handoff = run.handoff;
  if (
    handoff === undefined ||
    handoff.evidence !== evidence ||
    handoff.actor !== actor ||
    handoff.reason !== reason
  ) {
    throw new Error(`run ${run.run_id} has a different accepted handoff`);
  }
}

async function invoke(
  original: RunRecord,
  message: string,
  stateDir: string,
  options: ControllerOptions
): Promise<ControllerResult> {
  const idle = withoutReportAndInterruption(original);
  const working: RunRecord = {
    ...idle,
    state: "working",
    process: { pid: process.pid, started_at: now() },
    updated_at: now()
  };
  await saveRun(stateDir, working);
  await updateLease(stateDir, { ...leaseFor(working), process_id: process.pid });
  const outputPath = reportPath(stateDir, working.run_id);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await rm(outputPath, { force: true });
  const logPath = join(stateDir, "logs", `${working.run_id}.log`);
  const launch = await (async (): Promise<LaunchResult> => {
    try {
      const plan = await launchPlan(working, message, outputPath, options);
      return await (options.launcher ?? launchAgent)(plan, logPath);
    } catch (error) {
      return await failWithoutReport(working, stateDir, errorMessage(error));
    }
  })();
  if (launch.signal !== null)
    return await interrupt(working, stateDir, `agent terminated by ${launch.signal}`);
  if (launch.code !== 0)
    return await failWithoutReport(
      working,
      stateDir,
      `agent exited with ${launch.code.toString()}`
    );
  const report = await readAgentReport(outputPath).catch(async (error: unknown) => {
    await failWithoutReport(working, stateDir, errorMessage(error));
    throw error;
  });
  const sessionId = await verifiedSessionId(working, launch, stateDir);
  const observed = await snapshotRepository(working.repository);
  const finished = await finishReportedRun(working, report, observed, sessionId, stateDir);
  return controllerResult(finished);
}

async function launchPlan(
  run: RunRecord,
  message: string,
  outputPath: string,
  options: ControllerOptions
): Promise<PiLaunchPlan> {
  const loaded = await loadPiApp({ appFile: options.appFile ?? defaultAppFile() });
  const base = await manifestToDefinition(loaded.manifest, loaded.appRoot);
  const config = await loadConfig(options.configFile ?? defaultConfigPath());
  const { app, profile } = resolveAppProfile(base, config);
  const runtime = await writePiRuntimeConfig(app);
  await mkdir(app.sessionDir, { recursive: true });
  const plan = await createPiLaunchPlan(app, runtime, {
    cwd: run.repository,
    mode: "json",
    name: `Regrafter ${run.run_id}`,
    messages: [message],
    profile,
    ...(run.session_id === undefined ? {} : { session: run.session_id })
  });
  return { ...plan, env: { ...plan.env, REGRAFTER_REPORT_FILE: outputPath } };
}

function isStreamingDeltaLine(line: string): boolean {
  return line.startsWith('{"type":"message_update"');
}

async function launchInteractive(plan: PiLaunchPlan): Promise<LaunchResult> {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    shell: false,
    env: { ...process.env, ...plan.env },
    stdio: "inherit"
  });
  return await new Promise<LaunchResult>((accept, reject) => {
    const cleanup = forwardSignals(child);
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      accept({ code: code ?? 1, signal });
    });
  });
}

export async function launchAgent(plan: PiLaunchPlan, logPath: string): Promise<LaunchResult> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    shell: false,
    env: { ...process.env, ...plan.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let sessionId: string | undefined;
  const secrets = sensitiveValues({ ...process.env, ...plan.env });
  const stdout = lineSink((line) => {
    sessionId ??= sessionFromLine(line);
    if (isStreamingDeltaLine(line)) return;
    log.write(`${redactText(line, secrets)}\n`);
  });
  const stderr = lineSink((line) => {
    const safe = `${redactText(line, secrets)}\n`;
    log.write(safe);
    process.stderr.write(safe);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  return await new Promise<LaunchResult>((accept, reject) => {
    let settled = false;
    const cleanupSignals = forwardSignals(child);
    function cleanupErrors(): void {
      child.stdout?.off("error", fail);
      child.stderr?.off("error", fail);
      child.off("error", fail);
      log.off("error", fail);
    }
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      cleanupSignals();
      cleanupErrors();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      log.destroy();
      reject(error);
    }
    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      void waitForOutput(child.stdout, child.stderr).then(
        () => {
          if (settled) return;
          cleanupSignals();
          child.stdout?.off("error", fail);
          child.stderr?.off("error", fail);
          child.off("error", fail);
          stdout.flush();
          stderr.flush();
          log.end(() => {
            if (settled) return;
            settled = true;
            log.off("error", fail);
            accept({ code: code ?? 1, signal, ...(sessionId === undefined ? {} : { sessionId }) });
          });
        },
        (error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      );
    }
    child.stdout?.once("error", fail);
    child.stderr?.once("error", fail);
    child.once("error", fail);
    log.once("error", fail);
    child.once("exit", finish);
  });
}

async function waitForOutput(stdout: Readable | null, stderr: Readable | null): Promise<void> {
  const timeout = new Promise<false>((accept) => {
    const timer = setTimeout(() => {
      accept(false);
    }, 250);
    timer.unref();
  });
  const ended = Promise.all([streamEnd(stdout), streamEnd(stderr)]).then(() => true as const);
  if (!(await Promise.race([ended, timeout]))) {
    stdout?.destroy();
    stderr?.destroy();
  }
}

async function streamEnd(stream: Readable | null): Promise<void> {
  if (stream === null || stream.readableEnded || stream.destroyed) return;
  await new Promise<void>((accept, reject) => {
    const cleanup = (): void => {
      stream.off("end", done);
      stream.off("close", done);
      stream.off("error", fail);
    };
    const done = (): void => {
      cleanup();
      accept();
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", fail);
  });
}

type LineSink = { push(text: string): void; flush(): void };

function lineSink(consume: (line: string) => void): LineSink {
  let pending = "";
  return {
    push(text) {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    flush() {
      if (pending !== "") consume(pending);
      pending = "";
    }
  };
}

function sensitiveValues(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/iu.test(key) &&
        value !== undefined &&
        value.length >= 6
    )
    .map(([, value]) => value ?? "");
}

function redactText(text: string, secrets: readonly string[]): string {
  let safe = text.replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[redacted]@");
  for (const secret of secrets) safe = safe.replaceAll(secret, "[redacted]");
  return safe;
}

function forwardSignals(child: ChildProcess): () => void {
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  const onInterrupt = (): void => {
    forward("SIGINT");
  };
  const onTerminate = (): void => {
    forward("SIGTERM");
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
}

function sessionFromLine(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (isRecord(value) && value["type"] === "session" && typeof value["id"] === "string")
      return value["id"];
  } catch {
    return undefined;
  }
  return undefined;
}

async function assertResumable(
  run: RunRecord,
  decisionId: string | undefined,
  stateDir: string
): Promise<void> {
  if (["completed", "aborted", "failed", "working", "handed_off"].includes(run.state))
    throw new Error(`run ${run.run_id} cannot resume from ${run.state}`);
  const expected = run.report?.decision?.id;
  if (expected !== undefined && decisionId !== expected)
    throw new Error(`run expects decision ${expected}`);
  if (expected === undefined && decisionId !== undefined)
    throw new Error(`run has no pending decision ${decisionId}`);
  await assertLeaseAndSnapshot(run, stateDir);
}

async function assertLeaseAndSnapshot(run: RunRecord, stateDir: string): Promise<void> {
  const lease = await readLease(stateDir, run.git_common_dir);
  if (lease?.run_id !== run.run_id)
    throw new Error(`run ${run.run_id} does not own its repository lease`);
  const current = await snapshotRepository(run.repository);
  if (!sameSnapshot(current, run.last_observed))
    throw new Error("repository changed while Regrafter was paused");
}

function mergeAuthority(current: RunAuthority, grant: RunAuthority | undefined): RunAuthority {
  return {
    overlay_commits: permission(current.overlay_commits, grant?.overlay_commits),
    push: permission(current.push, grant?.push),
    pull_requests: permission(current.pull_requests, grant?.pull_requests)
  };
}

function permission(current: boolean, granted: boolean | undefined): boolean {
  return current || granted === true;
}

function noAuthority(): RunAuthority {
  return { overlay_commits: false, push: false, pull_requests: false };
}

function initialMessage(request: string, authority: RunAuthority): string {
  return `${authorityLine(authority)} Pristine Regraft base commits remain implicit.\n\nRequest:\n${request}`;
}

function resumeMessage(
  message: string,
  decisionId: string | undefined,
  authority: RunAuthority
): string {
  const instruction = decisionId === undefined ? message : `Decision ${decisionId}: ${message}`;
  return `${authorityLine(authority)}\n\n${instruction}`;
}

function authorityLine(authority: RunAuthority): string {
  const allowed = [
    authority.overlay_commits ? "overlay commits" : undefined,
    authority.push ? "pushes" : undefined,
    authority.pull_requests ? "pull requests" : undefined
  ].filter((value) => value !== undefined);
  return `Controller authority: ${allowed.length === 0 ? "none" : allowed.join(", ")}.`;
}
function leaseFor(run: RunRecord): LeaseRecord {
  return {
    schema_version: 1,
    run_id: run.run_id,
    repository: run.repository,
    git_common_dir: run.git_common_dir,
    branch: run.starting.branch,
    starting_head: run.starting.head,
    updated_at: now()
  };
}
async function interrupt(run: RunRecord, stateDir: string, reason: string): Promise<never> {
  const idle = withoutProcess(run);
  const observed = await interruptedSnapshot(run, reason);
  const value: RunRecord = {
    ...idle,
    state: "interrupted",
    updated_at: now(),
    last_observed: observed.snapshot,
    interruption: { reason: observed.reason, at: now() }
  };
  await saveRun(stateDir, value);
  await updateLease(stateDir, leaseFor(value));
  throw new Error(reason);
}
async function finishReportedRun(
  working: RunRecord,
  report: AgentReport,
  observed: RepositorySnapshot,
  sessionId: string,
  stateDir: string
): Promise<RunRecord> {
  const problems = await completionProblems(working, report, observed);
  const selectedReport =
    problems.length === 0 ? report : blockedCompletionReport(report, problems, working.authority);
  const finished: RunRecord = {
    ...withoutProcess(working),
    state: selectedReport.state,
    session_id: sessionId,
    report: selectedReport,
    ...(problems.length === 0
      ? {}
      : { rejected_completion: { report, reasons: problems, observed } }),
    updated_at: now(),
    last_observed: observed
  };
  await saveRun(stateDir, finished);
  await updateLease(stateDir, leaseFor(finished));
  if (finished.state === "completed") {
    await releaseLease(stateDir, finished.git_common_dir, finished.run_id);
  }
  return finished;
}

function blockedCompletionReport(
  report: AgentReport,
  problems: readonly string[],
  authority: RunAuthority
): AgentReport {
  const needed = authority.overlay_commits
    ? "Resume the same run and correct the reported completion while preserving every base commit."
    : "Grant overlay-commit authority, then resume the same run and commit the restored overlay.";
  return {
    ...report,
    state: "blocked",
    summary: `Controller rejected completion: ${problems[0] ?? "completion contract failed"}`,
    blocker: {
      reason: "proposed completion failed the controller contract",
      evidence: [...problems],
      attempted_actions: [],
      needed
    },
    next: needed
  };
}

async function verifiedSessionId(
  run: RunRecord,
  launch: LaunchResult,
  stateDir: string
): Promise<string> {
  if (
    run.session_id !== undefined &&
    launch.sessionId !== undefined &&
    launch.sessionId !== run.session_id
  ) {
    return await failWithoutReport(
      run,
      stateDir,
      `agent resumed unexpected Pi session ${launch.sessionId}`
    );
  }
  const sessionId = run.session_id ?? launch.sessionId;
  if (sessionId === undefined) {
    return await failWithoutReport(run, stateDir, "agent did not identify its Pi session");
  }
  return sessionId;
}

async function interruptedSnapshot(
  run: RunRecord,
  reason: string
): Promise<{ snapshot: RepositorySnapshot; reason: string }> {
  try {
    return { snapshot: await snapshotRepository(run.repository), reason };
  } catch (error) {
    return {
      snapshot: run.last_observed,
      reason: `${reason}; repository snapshot failed: ${errorMessage(error)}`
    };
  }
}

async function failWithoutReport(run: RunRecord, stateDir: string, reason: string): Promise<never> {
  const observed = await snapshotRepository(run.repository);
  const idle = withoutReportAndInterruption(withoutProcess(run));
  const value: RunRecord = {
    ...idle,
    state: "failed",
    updated_at: now(),
    last_observed: observed,
    interruption: { reason, at: now() }
  };
  await saveRun(stateDir, value);
  await updateLease(stateDir, leaseFor(value));
  throw new Error(reason);
}
function withoutProcess(run: RunRecord): RunRecord {
  const copy: RunRecord = { ...run };
  delete copy.process;
  return copy;
}

function withoutReportAndInterruption(run: RunRecord): RunRecord {
  const copy: RunRecord = { ...run };
  delete copy.report;
  delete copy.rejected_completion;
  delete copy.interruption;
  return copy;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}
async function runExists(stateDir: string, id: string): Promise<boolean> {
  return await loadRun(stateDir, id).then(
    () => true,
    () => false
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
