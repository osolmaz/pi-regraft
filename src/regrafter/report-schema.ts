import { Type } from "@sinclair/typebox";

const Commit = Type.Object(
  {
    kind: Type.Union([Type.Literal("base"), Type.Literal("overlay")]),
    graft: Type.String(),
    sha: Type.String()
  },
  { additionalProperties: false }
);
const Check = Type.Object(
  {
    command: Type.String(),
    scope: Type.String(),
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
    exit_code: Type.Union([Type.Integer(), Type.Null()])
  },
  { additionalProperties: false }
);
const Option = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
    effect: Type.String(),
    files: Type.Array(Type.String()),
    reversible: Type.Boolean()
  },
  { additionalProperties: false }
);
export const repositorySnapshotSchema = Type.Object(
  { branch: Type.String(), head: Type.String(), dirty_paths: Type.Array(Type.String()) },
  { additionalProperties: false }
);
const Decision = Type.Object(
  {
    id: Type.String(),
    graft: Type.String(),
    question: Type.String(),
    context: Type.String(),
    options: Type.Array(Option, { minItems: 2 }),
    recommendation: Type.Optional(
      Type.Object({ option: Type.String(), reason: Type.String() }, { additionalProperties: false })
    ),
    evidence: Type.Array(Type.String()),
    repository: repositorySnapshotSchema
  },
  { additionalProperties: false }
);
const Blocker = Type.Object(
  {
    reason: Type.String(),
    evidence: Type.Array(Type.String()),
    attempted_actions: Type.Array(Type.String()),
    needed: Type.String()
  },
  { additionalProperties: false }
);
const Recovery = Type.Object(
  {
    status: Type.String(),
    current_head: Type.String(),
    dirty_paths: Type.Array(Type.String()),
    next_step: Type.String()
  },
  { additionalProperties: false }
);
const UpdatedGraft = Type.Object(
  { graft: Type.String(), old_upstream: Type.String(), new_upstream: Type.String() },
  { additionalProperties: false }
);
export const agentReportSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    state: Type.Union([
      Type.Literal("needs_decision"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
      Type.Literal("failed")
    ]),
    summary: Type.String(),
    decision: Type.Optional(Decision),
    commits: Type.Array(Commit),
    checks: Type.Array(Check),
    updated_grafts: Type.Array(UpdatedGraft),
    blocker: Type.Optional(Blocker),
    recovery: Type.Optional(Recovery),
    next: Type.String()
  },
  { additionalProperties: false }
);
const runStateSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("working"),
  Type.Literal("needs_decision"),
  Type.Literal("blocked"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("interrupted")
]);
export const runRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: Type.String(),
    repository: Type.String(),
    git_common_dir: Type.String(),
    state: runStateSchema,
    session_id: Type.Optional(Type.String()),
    created_at: Type.String(),
    updated_at: Type.String(),
    starting: repositorySnapshotSchema,
    last_observed: repositorySnapshotSchema,
    authority: Type.Object(
      { overlay_commits: Type.Boolean(), push: Type.Boolean(), pull_requests: Type.Boolean() },
      { additionalProperties: false }
    ),
    report: Type.Optional(agentReportSchema),
    process: Type.Optional(
      Type.Object(
        { pid: Type.Integer(), started_at: Type.String() },
        { additionalProperties: false }
      )
    ),
    interruption: Type.Optional(
      Type.Object({ reason: Type.String(), at: Type.String() }, { additionalProperties: false })
    )
  },
  { additionalProperties: false }
);
export const leaseRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: Type.String(),
    repository: Type.String(),
    git_common_dir: Type.String(),
    branch: Type.String(),
    starting_head: Type.String(),
    process_id: Type.Optional(Type.Integer()),
    updated_at: Type.String()
  },
  { additionalProperties: false }
);
