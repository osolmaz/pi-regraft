import type { Graft } from "./manifest.ts";
import type { AddResult, StatusEntry, UpdateResult } from "./operations.ts";

export const CLI_SCHEMA_VERSION = 1 as const;

export interface CliGraft {
  name: string;
  dest: string;
  source: Graft["source"];
  commit: string;
  notes: string[];
}

export interface StatusCommandResult {
  schema_version: typeof CLI_SCHEMA_VERSION;
  command: "status";
  state: "completed";
  repository: string;
  grafts: Array<{
    name: string;
    dest: string;
    current_commit: string;
    latest_commit: string;
    local_base_commit: string;
    behind: boolean;
    notes: string[];
  }>;
}

export interface AddCommandResult {
  schema_version: typeof CLI_SCHEMA_VERSION;
  command: "add";
  state: "completed";
  repository: string;
  graft: CliGraft;
  base_commit: string;
}

export interface UpdateCommandResult {
  schema_version: typeof CLI_SCHEMA_VERSION;
  command: "update";
  state: "up_to_date" | "completed" | "needs_resolution";
  repository: string;
  graft: CliGraft;
  previous_commit: string;
  new_commit: string;
  local_base_commit: string;
  new_base_commit?: string;
  overlay_pending: boolean;
  changed: string[];
  added: string[];
  removed: string[];
  conflicts: string[];
}

export interface NoteCommandResult {
  schema_version: typeof CLI_SCHEMA_VERSION;
  command: "note";
  state: "completed";
  repository: string;
  graft: CliGraft;
}

export interface ErrorCommandResult {
  schema_version: typeof CLI_SCHEMA_VERSION;
  command: "status" | "add" | "update" | "note" | "unknown";
  state: "error";
  error: {
    kind: "usage" | "blocked" | "failed";
    message: string;
  };
}

export type RegraftCommandResult =
  | StatusCommandResult
  | AddCommandResult
  | UpdateCommandResult
  | NoteCommandResult
  | ErrorCommandResult;

function graftResult(graft: Graft): CliGraft {
  return {
    name: graft.name,
    dest: graft.dest,
    source: { ...graft.source },
    commit: graft.commit,
    notes: [...graft.notes],
  };
}

export function statusCommandResult(
  repository: string,
  entries: StatusEntry[],
): StatusCommandResult {
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command: "status",
    state: "completed",
    repository,
    grafts: entries.map((entry) => ({
      name: entry.graft.name,
      dest: entry.graft.dest,
      current_commit: entry.graft.commit,
      latest_commit: entry.latestCommit,
      local_base_commit: entry.localBaseCommit,
      behind: entry.behind,
      notes: [...entry.graft.notes],
    })),
  };
}

export function addCommandResult(
  repository: string,
  result: AddResult,
): AddCommandResult {
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command: "add",
    state: "completed",
    repository,
    graft: graftResult(result.graft),
    base_commit: result.baseCommit,
  };
}

export function updateCommandResult(
  repository: string,
  result: UpdateResult,
): UpdateCommandResult {
  const report = result.report;
  const state = result.upToDate
    ? "up_to_date"
    : (report?.conflicts.length ?? 0) > 0
      ? "needs_resolution"
      : "completed";
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command: "update",
    state,
    repository,
    graft: graftResult(result.graft),
    previous_commit: result.previousCommit,
    new_commit: result.newCommit,
    local_base_commit: result.localBaseCommit,
    ...(result.newBaseCommit ? { new_base_commit: result.newBaseCommit } : {}),
    overlay_pending: result.overlayPending,
    changed: [...(report?.changed ?? [])],
    added: [...(report?.added ?? [])],
    removed: [...(report?.removed ?? [])],
    conflicts: [...(report?.conflicts ?? [])],
  };
}

export function noteCommandResult(
  repository: string,
  graft: Graft,
): NoteCommandResult {
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command: "note",
    state: "completed",
    repository,
    graft: graftResult(graft),
  };
}
