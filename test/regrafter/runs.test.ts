import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listRuns, loadRun, saveRun, stateDirectory } from "../../src/regrafter/runs.js";
import type { RunRecord } from "../../src/regrafter/types.js";

function run(id: string, repository = "/repo"): RunRecord {
  const snapshot = { branch: "main", head: "abc", dirty_paths: [] };
  return {
    schema_version: 1,
    run_id: id,
    repository,
    git_common_dir: `${repository}/.git`,
    state: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    starting: snapshot,
    last_observed: snapshot,
    authority: { overlay_commits: false, push: false, pull_requests: false }
  };
}

it("stores validated run records atomically and filters by repository", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-runs-"));
  const first = run("run-11111111111111111111111111111111");
  const second = run("run-22222222222222222222222222222222", "/other");
  await saveRun(state, first);
  await saveRun(state, second);
  expect((await loadRun(state, first.run_id)).repository).toBe("/repo");
  expect((await listRuns(state, "/repo")).map((item) => item.run_id)).toEqual([first.run_id]);
});

it("uses an explicit state directory and lists an empty store", async () => {
  expect(stateDirectory({ REGRAFTER_STATE_DIR: "/custom/state" })).toBe("/custom/state");
  const state = await mkdtemp(join(tmpdir(), "regrafter-runs-"));
  expect(await listRuns(state)).toEqual([]);
});

it("rejects traversal-shaped run ids", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-runs-"));
  await expect(loadRun(state, "../lease")).rejects.toThrow("invalid run id");
});

it("enforces handed-off audit invariants", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-runs-"));
  const value = run("run-33333333333333333333333333333333");
  await expect(saveRun(state, { ...value, state: "handed_off" })).rejects.toThrow(
    "handed_off state and audit"
  );
  const digest = "a".repeat(64);
  const evidence = {
    snapshot: value.last_observed,
    status_sha256: digest,
    index_sha256: digest,
    content_sha256: digest
  };
  const handedOff: RunRecord = {
    ...value,
    state: "handed_off",
    handoff: {
      schema_version: 1,
      evidence: digest,
      actor: "operator",
      reason: "Accepted after external reconciliation.",
      accepted_at: value.updated_at,
      previous: value.last_observed,
      accepted: evidence,
      release: "released",
      released_at: value.updated_at
    }
  };
  await saveRun(state, handedOff);
  expect((await loadRun(state, handedOff.run_id)).handoff?.release).toBe("released");
  const audit = handedOff.handoff;
  if (audit === undefined) throw new Error("missing handoff fixture");
  await expect(
    saveRun(state, { ...handedOff, handoff: { ...audit, actor: "x".repeat(129) } })
  ).rejects.toThrow("actor exceeds");
  await expect(
    saveRun(state, { ...handedOff, handoff: { ...audit, reason: "x".repeat(2049) } })
  ).rejects.toThrow("reason exceeds");
  const missingReleaseTime = { ...audit };
  delete missingReleaseTime.released_at;
  await expect(saveRun(state, { ...handedOff, handoff: missingReleaseTime })).rejects.toThrow(
    "requires released_at"
  );
  await expect(
    saveRun(state, {
      ...handedOff,
      handoff: { ...audit, release: "pending" as const }
    })
  ).rejects.toThrow("pending handoff cannot include released_at");
});
