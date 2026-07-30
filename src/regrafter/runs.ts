import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { runRecordSchema } from "./report-schema.js";
import type { RunRecord } from "./types.js";

export function stateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment["REGRAFTER_STATE_DIR"] ?? join(homedir(), ".local", "state", "regrafter");
}

export function assertRunId(runId: string): void {
  if (!/^run-[0-9a-f]{32}$/u.test(runId)) throw new Error(`invalid run id: ${runId}`);
}

export function runPath(stateDir: string, runId: string): string {
  assertRunId(runId);
  return join(stateDir, "runs", `${runId}.json`);
}

export function reportPath(stateDir: string, runId: string): string {
  assertRunId(runId);
  return join(stateDir, "reports", `${runId}.json`);
}

export async function saveRun(stateDir: string, run: RunRecord): Promise<void> {
  const id = run.run_id;
  if (!Value.Check(runRecordSchema, run)) throw new Error(`refusing to save invalid run ${id}`);
  await writeJsonAtomic(runPath(stateDir, run.run_id), run);
}

export async function loadRun(stateDir: string, runId: string): Promise<RunRecord> {
  const value = await readJson(runPath(stateDir, runId));
  if (!Value.Check(runRecordSchema, value)) throw new Error(`run record is invalid: ${runId}`);
  return value;
}

export async function listRuns(stateDir: string, repository?: string): Promise<RunRecord[]> {
  const directory = join(stateDir, "runs");
  const names = await readdir(directory).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  });
  const runs = await Promise.all(
    names
      .filter((name) => /^run-[0-9a-f]{32}\.json$/u.test(name))
      .map(async (name) => loadRun(stateDir, name.slice(0, -5)))
  );
  return runs
    .filter((run) => repository === undefined || run.repository === repository)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
