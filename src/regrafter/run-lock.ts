import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createJsonExclusive, readJson } from "./atomic.js";
import { assertRunId } from "./runs.js";

export type RunLock = {
  schema_version: 1;
  run_id: string;
  nonce: string;
  pid: number;
  started_ns: string;
};

export function runLockPath(stateDir: string, runId: string, nonce = "manual"): string {
  assertRunId(runId);
  return join(stateDir, "run-locks", runId, `${nonce}.json`);
}

export async function withRunLock<T>(
  stateDir: string,
  runId: string,
  operation: () => Promise<T>
): Promise<T> {
  const lock = newRunLock(runId);
  const path = runLockPath(stateDir, runId, lock.nonce);
  await createJsonExclusive(path, lock);
  try {
    await assertOwnership(stateDir, lock);
    return await operation();
  } finally {
    await rm(path, { force: true });
  }
}

function newRunLock(runId: string): RunLock {
  return {
    schema_version: 1,
    run_id: runId,
    nonce: randomUUID(),
    pid: process.pid,
    started_ns: process.hrtime.bigint().toString()
  };
}

async function assertOwnership(stateDir: string, own: RunLock): Promise<void> {
  const directory = join(stateDir, "run-locks", own.run_id);
  const names = await readdir(directory);
  const locks = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => parseRunLock(await readJson(join(directory, name))))
  );
  const live = locks.filter((lock) => processAlive(lock.pid)).sort(compareLocks);
  const owner = live[0];
  if (owner?.nonce !== own.nonce) {
    throw new Error(
      `run ${own.run_id} is controlled by process ${owner?.pid.toString() ?? "unknown"}`
    );
  }
}

function compareLocks(left: RunLock, right: RunLock): number {
  const order = BigInt(left.started_ns) - BigInt(right.started_ns);
  if (order < 0n) return -1;
  if (order > 0n) return 1;
  return left.nonce.localeCompare(right.nonce);
}

function parseRunLock(value: unknown): RunLock {
  if (!isRecord(value)) throw new Error("run lock is invalid; inspect it manually");
  if (
    value["schema_version"] !== 1 ||
    typeof value["run_id"] !== "string" ||
    typeof value["nonce"] !== "string" ||
    !Number.isInteger(value["pid"]) ||
    typeof value["started_ns"] !== "string" ||
    !/^\d+$/u.test(value["started_ns"])
  ) {
    throw new Error("run lock is invalid; inspect it manually");
  }
  return value as RunLock;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
