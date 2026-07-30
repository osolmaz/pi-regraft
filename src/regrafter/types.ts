export const SCHEMA_VERSION = 1 as const;

export type RunState =
  | "ready"
  | "working"
  | "needs_decision"
  | "blocked"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export type CommitEntry = { kind: "base" | "overlay"; graft: string; sha: string };
export type CheckEntry = {
  command: string;
  scope: string;
  outcome: "passed" | "failed" | "skipped";
  exit_code: number | null;
};
export type DecisionOption = {
  id: string;
  label: string;
  effect: string;
  files: string[];
  reversible: boolean;
};
export type DecisionPacket = {
  id: string;
  graft: string;
  question: string;
  context: string;
  options: DecisionOption[];
  recommendation?: { option: string; reason: string };
  evidence: string[];
  repository: { branch: string; head: string; dirty_paths: string[] };
};
export type ReportState = "needs_decision" | "blocked" | "completed" | "failed";
export type AgentReport = {
  schema_version: 1;
  state: ReportState;
  summary: string;
  decision?: DecisionPacket;
  commits: CommitEntry[];
  checks: CheckEntry[];
  updated_grafts: Array<{ graft: string; old_upstream: string; new_upstream: string }>;
  blocker?: {
    reason: string;
    evidence: string[];
    attempted_actions: string[];
    needed: string;
  };
  recovery?: { status: string; current_head: string; dirty_paths: string[]; next_step: string };
  next: string;
};
export type RunAuthority = {
  overlay_commits: boolean;
  push: boolean;
  pull_requests: boolean;
};
export type RepositorySnapshot = {
  branch: string;
  head: string;
  dirty_paths: string[];
};
export type RunRecord = {
  schema_version: 1;
  run_id: string;
  repository: string;
  git_common_dir: string;
  state: RunState;
  session_id?: string;
  created_at: string;
  updated_at: string;
  starting: RepositorySnapshot;
  last_observed: RepositorySnapshot;
  authority: RunAuthority;
  report?: AgentReport;
  process?: { pid: number; started_at: string };
  interruption?: { reason: string; at: string };
};
export type LeaseRecord = {
  schema_version: 1;
  run_id: string;
  repository: string;
  git_common_dir: string;
  branch: string;
  starting_head: string;
  process_id?: number;
  updated_at: string;
};
export type ControllerResult = AgentReport & {
  run_id: string;
  repository: string;
  session_id: string;
};
