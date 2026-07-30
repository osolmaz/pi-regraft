import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  acquireLease,
  leasePath,
  readLease,
  releaseLease,
  updateLease
} from "../../src/regrafter/lease.js";
import type { LeaseRecord } from "../../src/regrafter/types.js";

function value(runId: string): LeaseRecord {
  return {
    schema_version: 1,
    run_id: runId,
    repository: "/repo",
    git_common_dir: "/repo/.git",
    branch: "main",
    starting_head: "abc",
    updated_at: "2026-01-01T00:00:00Z"
  };
}

it("never replaces an existing lease because time passed", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-lease-"));
  await acquireLease(state, value("run-11111111111111111111111111111111"));
  await expect(acquireLease(state, value("run-22222222222222222222222222222222"))).rejects.toThrow(
    "elapsed time does not release"
  );
  expect((await readLease(state, "/repo/.git"))?.run_id).toContain("1111");
});

it("updates and releases only for the owning run", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-lease-"));
  const owner = value("run-11111111111111111111111111111111");
  await acquireLease(state, owner);
  await expect(updateLease(state, value("run-22222222222222222222222222222222"))).rejects.toThrow(
    "does not own"
  );
  await expect(
    releaseLease(state, owner.git_common_dir, "run-22222222222222222222222222222222")
  ).rejects.toThrow("does not own");
  await releaseLease(state, owner.git_common_dir, owner.run_id);
  await releaseLease(state, owner.git_common_dir, owner.run_id);
  expect(await readLease(state, owner.git_common_dir)).toBeUndefined();
});

it("rejects a malformed persisted lease", async () => {
  const state = await mkdtemp(join(tmpdir(), "regrafter-lease-"));
  const path = leasePath(state, "/repo/.git");
  await mkdir(join(state, "leases"));
  await writeFile(path, "{}\n");
  await expect(readLease(state, "/repo/.git")).rejects.toThrow("invalid");
});
