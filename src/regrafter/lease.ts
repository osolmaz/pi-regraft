import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createJsonExclusive, readJson, writeJsonAtomic } from "./atomic.js";
import { leaseRecordSchema } from "./report-schema.js";
import type { LeaseRecord } from "./types.js";

export function leasePath(stateDir: string, gitCommonDir: string): string {
  const key = createHash("sha256").update(gitCommonDir).digest("hex");
  return join(stateDir, "leases", `${key}.json`);
}

export async function readLease(
  stateDir: string,
  gitCommonDir: string
): Promise<LeaseRecord | undefined> {
  const value = await readJson(leasePath(stateDir, gitCommonDir)).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (value === undefined) return undefined;
  if (!Value.Check(leaseRecordSchema, value))
    throw new Error("repository lease is invalid; inspect it manually");
  return value;
}

export async function acquireLease(stateDir: string, lease: LeaseRecord): Promise<void> {
  try {
    await createJsonExclusive(leasePath(stateDir, lease.git_common_dir), lease);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const owner = await readLease(stateDir, lease.git_common_dir);
    throw new Error(
      `repository is leased by ${owner?.run_id ?? "an unknown run"}; elapsed time does not release the lease`
    );
  }
}

export async function updateLease(stateDir: string, lease: LeaseRecord): Promise<void> {
  const current = await readLease(stateDir, lease.git_common_dir);
  if (current?.run_id !== lease.run_id)
    throw new Error(`run ${lease.run_id} does not own the repository lease`);
  await writeJsonAtomic(leasePath(stateDir, lease.git_common_dir), lease);
}

export async function releaseLease(
  stateDir: string,
  gitCommonDir: string,
  runId: string
): Promise<void> {
  const current = await readLease(stateDir, gitCommonDir);
  if (current === undefined) return;
  if (current.run_id !== runId) throw new Error(`run ${runId} does not own the repository lease`);
  await rm(leasePath(stateDir, gitCommonDir));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
