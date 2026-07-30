import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { runLockPath, withRunLock } from "../../src/regrafter/run-lock.js";

const runId = "run-11111111111111111111111111111111";

it("allows only one controller process for a run", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-run-lock-"));
  let release: (() => void) | undefined;
  let markEntered: (() => void) | undefined;
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  const entered = new Promise<void>((accept) => {
    markEntered = accept;
  });
  const first = withRunLock(state, runId, async () => {
    markEntered?.();
    await gate;
  });
  await entered;
  await expect(withRunLock(state, runId, async () => undefined)).rejects.toThrow(
    `controlled by process ${process.pid.toString()}`
  );
  release?.();
  await first;
  expect(await withRunLock(state, runId, async () => "released")).toBe("released");
});

it("recovers a lock only after its owner process is gone", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-run-lock-"));
  const path = runLockPath(state, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ schema_version: 1, run_id: runId, nonce: "stale", pid: 2147483647, started_ns: "1" })}\n`
  );
  expect(await withRunLock(state, runId, async () => "recovered")).toBe("recovered");
});

it("keeps an invalid lock for manual inspection", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-run-lock-"));
  const path = runLockPath(state, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}\n");
  await expect(withRunLock(state, runId, async () => undefined)).rejects.toThrow(
    "inspect it manually"
  );
});
