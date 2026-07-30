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
