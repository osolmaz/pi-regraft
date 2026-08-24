# Regrafter specification

Regrafter is the dedicated Pi agent shipped with `pi-regraft` for maintaining code tracked by Regraft. It runs inside a target repository and uses the `regraft` command for mechanical updates. It handles the judgment needed to interpret local intent, resolve conflicts, run checks, and prepare commits.

A person may work with Regrafter directly. A main Pi agent may also drive Regrafter through a resumable command interface. The same Regrafter run can stop for a decision, receive an answer later, and continue in its original Pi session and repository state.

## User experience

A direct session starts the Regrafter pi-factory app in the repository being updated:

```bash
pi-factory run regrafter --cwd /path/to/repository
```

The user can then ask:

```text
Update the vendored packages and commit the results.
```

A main agent uses the Regrafter controller instead:

```bash
regrafter start --repo /path/to/repository --request-file task.md --json
regrafter send <run-id> --decision <decision-id> --message-file answer.md --json
regrafter inspect <run-id> --json
regrafter list [--repo /path/to/repository] --json
regrafter attach <run-id>
regrafter abort <run-id> --json
regrafter handoff prepare <run-id> --json
regrafter handoff accept <run-id> --evidence <sha256> --actor <id> --reason-file <path> --json
```

Each controller command is a bounded process. Regrafter does not require a daemon or background service. Pi session files and a small run index under the Regrafter state directory preserve the conversation and the link to the target repository.

## Components

Regrafter has four parts with separate jobs.

### Regraft core and command

`pi-regraft` owns the deterministic vendoring operations. Its `regraft` executable provides human-readable output by default and JSON output for agents.

The command supports:

```text
regraft status [--json]
regraft add <source> [destination] [--json]
regraft update <name> [--json]
regraft note <name> <text> [--json]
```

`regraft update` processes one graft. It finds the old pristine base in local Git history, fetches the new upstream revision, creates the new pristine base commit, and restores the merged local overlay. It reports file changes, conflicts, notes, commit ids, and whether work remains in the worktree.

The command never makes semantic choices. It can produce conflict markers and return a successful `needs_resolution` result when the mechanical merge completed but the overlay needs an agent.

### pi-factory app bundle

The Regrafter app bundle ships inside `pi-regraft`. It owns its system prompt, enabled tools, extensions, model settings, and isolated Pi state. It uses Pi's normal session implementation and extension SDK.

The bundle enables the standard tools needed for repository work. The first version uses `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. It does not add Regraft operations as model tools. The agent invokes the `regraft` executable through `bash`.

The bundle includes one reporting extension. Its `regrafter_report` tool records a structured terminal state such as `needs_decision`, `completed`, or `blocked`. This tool reports state and does not modify repository files.

### Regrafter controller

The `regrafter` executable starts and resumes headless Regrafter runs. It resolves the pi-factory app, launches Pi against the target repository, waits until the agent reports a terminal state, and prints one JSON result. It can also list runs or attach a TUI to an idle run.

The controller owns:

- run ids and the run index
- the association between a run, Pi session, and canonical repository path
- repository leases
- process exit and interruption recovery
- validation of decision ids when a run resumes
- capture of the starting graft baseline
- validation of proposed completion reports and their Git commit chains
- evidence-bound ownership handoff and lease release
- conversion of the final report tool result into controller JSON

The controller does not interpret merge conflicts or edit files.

### Driving agent

A driving agent may be the main Pi agent in an interactive user session. It invokes `regrafter` through its existing shell tool, reads the returned state, and sends later instructions to the same run.

The driving agent owns the conversation with the user. When Regrafter asks a question, the driving agent may answer from instructions it already has. If the answer would exceed its authority or change user-visible behavior, it presents the decision to the user and relays the answer to Regrafter. The controller's `list` command lets a resumed or compacted driving session recover the active run id by repository.

A small optional driver skill may teach a main agent the controller commands and delegation rules. It contains no Regraft implementation and adds no custom model tool. Pi bundles that do not delegate to Regrafter do not need the skill.

## Working directory separation

A pi-factory app has an app root that contains its manifest and prompt files along with its extensions. Regrafter also needs a target repository where its tools run. These paths have different meanings and must remain separate.

pi-factory must support a launch working-directory override:

```bash
pi-factory run regrafter --cwd /path/to/repository
pi-factory plan regrafter --cwd /path/to/repository
```

Bundle resources continue to resolve relative to the app root. Pi's `cwd`, context-file discovery, built-in tools, project trust, and session identity use the target repository.

The pi-factory library must expose the same override through its launch-plan API so the Regrafter controller can launch headless sessions without reconstructing pi-factory behavior.

## Run lifecycle

A run has one stable id and one Pi session. It moves through these states:

| State            | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `ready`          | The run exists and may accept its first or next instruction.                                            |
| `working`        | A controller process currently owns the run.                                                            |
| `needs_decision` | Regrafter reached a safe pause and needs an answer.                                                     |
| `blocked`        | Work cannot continue without an external change or missing input.                                       |
| `completed`      | The controller accepted a clean report with a valid commit chain and released the lease.                |
| `failed`         | Regrafter could not complete or restore a safe state after an unexpected failure.                       |
| `aborted`        | The driver ended the run from its last verified repository snapshot and released the lease.             |
| `interrupted`    | A controller process exited before recording a terminal report.                                         |
| `handed_off`     | An operator accepted responsibility for a named repository state and the controller released the lease. |

`start` creates the run and sends the initial request. Before Pi starts, the controller records a network-free graft baseline from local Git and `regraft.json`. The baseline names each graft, destination, pinned upstream commit, local pristine base commit, and whether the starting HEAD contains a committed local overlay under that destination. `send` reopens the same Pi session and supplies a decision or further instruction. A run may pass through `needs_decision` several times.

The controller waits until Pi settles and Regrafter emits a terminal report. The report proposes the next run state. The controller decides whether the proposal satisfies the completion contract before it writes a terminal state. A controller invocation exits after it records the accepted or corrected state. No agent process remains running between steps.

An interrupted run must be inspected before it resumes. The controller compares the saved repository state with the current HEAD and branch, then checks the worktree, index, and Regraft manifest. It resumes only when the state still matches or Regraft's recovery checks prove that continuation is safe.

## Repository lease

Only one active Regrafter run may own a repository. The controller keys the lease by the canonical Git common directory so linked worktrees and path aliases cannot acquire the same lease accidentally.

The lease remains held while a run waits for a decision. Other processes may inspect the repository, but the driving agent must not edit it until Regrafter completes, aborts, or reports that it has released ownership.

A lease records the run id, repository path, branch, starting HEAD, process id while working, and last update time. Lease records live in the Regrafter state directory, outside the target repository. A stale lease is never removed solely because time passed. Lease release requires accepted clean completion, an `abort` from the last verified snapshot, or an evidence-bound ownership handoff.

Git's own index locks remain authoritative during Git operations. The Regrafter lease prevents higher-level workflows from passing the clean-worktree check concurrently and then changing the same paths.

## Update workflow

For a broad request, Regrafter follows this sequence:

1. Read repository instructions and `regraft.json`.
2. Confirm that the branch and author configuration are safe and that the worktree and index are clean.
3. Run `regraft status --json` and identify grafts in scope.
4. Update one graft with `regraft update <name> --json`.
5. Inspect the result and recorded notes.
6. Resolve mechanical conflicts that have one intent-preserving answer.
7. Stop for a decision when several defensible outcomes remain.
8. Run the graft's tests or checks.
9. Commit the restored overlay when the task authorizes commits.
10. Repeat only after the worktree is clean.
11. Run repository-wide checks and a final Regraft status.
12. Report the commits, checks, remaining risks, and upstream revisions.

The pristine base commit created by Regraft is never amended, squashed, or dropped. Regrafter keeps observed upstream state, its recommendation, and the driver's approved choice separate.

## Completion validation

A `completed` report is a proposal. The controller accepts it only when the repository is clean and the report agrees with the run's starting graft baseline and current Git history.

The controller checks all of the following facts:

- No reported check failed.
- Every reported commit exists and has the reported base or overlay role.
- The reported commits form the exact first-parent chain from the starting HEAD to the observed HEAD. The chain contains no missing, reordered, squashed, or extra run commit.
- Each updated graft reports upstream revisions that agree with the starting baseline and final manifest.
- Every pristine base commit remains in branch ancestry.
- A graft that had a committed local overlay at the start has an overlay commit after its new pristine base. A base-only result is valid only when no local overlay was required and the base is the final run commit.

These checks establish repository structure and authority. They do not decide whether the merged behavior is correct.

## Protocol rejection

An invalid completion report produces a controller-authored `blocked` state. The controller keeps the verified Pi session, rejected report, starting baseline, observed repository snapshot, protocol reasons, next action, and repository lease. It does not turn an expected completion-contract violation into an unresumable `failed` state.

When overlay work remains and the run lacks commit authority, the next action may grant `commits` authority and resume the same session. Regrafter must report `needs_decision` or `blocked` while `overlay_pending` is true and commit authority is absent. The controller still checks the result because prompt compliance is not a safety boundary.

Changes made outside Regrafter can make direct resume unsafe. The controller then rejects `send` and `abort` until the repository returns to the saved snapshot or an operator accepts ownership through the handoff command.

## Ownership handoff

Ownership handoff lets an operator take responsibility for repository work that changed after Regrafter's last verified snapshot. Handoff does not verify, commit, reset, clean, or endorse that work. It grants no Git or hosting authority.

The public controller API has two operations:

```ts
prepareHandoff(runId);
acceptHandoff(runId, evidence, actor, reason);
```

The CLI exposes the same operations:

```bash
regrafter handoff prepare <run-id> --json
regrafter handoff accept <run-id> \
  --evidence <sha256> \
  --actor <id> \
  --reason-file <path> \
  --json
```

`prepareHandoff` runs under the existing run lock. It rejects a live controller process, verifies that the named run owns the lease, and accepts only documented leased recovery states. It returns a non-secret candidate digest together with the prior verified snapshot and current repository evidence.

The evidence binds the schema tag, run id, canonical repository and Git common directory, exact lease record, run update identity, prior snapshot, current branch and HEAD, index state, status codes and paths, and type, mode, symlink-target, and content hashes for changed and untracked paths. File contents are streamed into hashes and are never stored in the run index. Evidence capture compares Git state before and after hashing and stops if the repository changes during capture.

`acceptHandoff` reacquires the run lock and repeats the process and lease checks. It computes the evidence again and requires an exact digest match. Actor is a nonempty audit label of at most 128 UTF-8 bytes. Reason comes from a file and contains at most 2048 UTF-8 bytes. These values record operator intent; they do not provide authentication.

## Durable handoff release

An accepted handoff is written before its lease is removed. The controller uses this order:

1. Save `handed_off` with the actor, reason, acceptance time, prior snapshot, accepted evidence, digest, and release status `pending`.
2. Read the lease again and verify that the same run still owns it.
3. Release only that run's lease.
4. Save the release completion and time.

A retry with the same accepted digest completes a pending lease release or final audit write. Failure before the first audit write leaves the lease intact. Failure during release leaves a durable pending handoff and the old lease. Failure after release can repair the audit without touching a lease owned by a later run. No handoff path uses lease age, process age, a force flag, or direct lease-file deletion.

## August 24 recovery case

The recovery contract covers the run that exposed the missing handoff operation. That run had no overlay-commit authority. Regraft created pristine base commit `afb476b`, restored a dirty local overlay, and Regrafter reported `completed`. The controller rejected the dirty completion and kept the lease. Later repository work changed the branch and HEAD, so exact-snapshot `abort` refused to release it.

The regression test recreates that sequence. It proves that the invalid completion becomes resumable `blocked` work on new runs, that changed repository evidence prevents resume and abort, and that a reviewed handoff records responsibility before it releases the named lease.

## Decision boundaries

Regrafter resolves routine text conflicts when the recorded intent and surrounding code point to one clear result. It pauses when an update requires a product or maintenance choice.

A decision is required for cases such as:

- upstream and local code provide competing versions of the same feature
- preserving local behavior would require a new API or a larger redesign
- upstream removed or relocated the tracked source
- a local patch appears obsolete but removing it changes user-visible behavior
- the update adds a runtime dependency, permission, credential requirement, or license concern
- tests reveal a behavior difference that cannot be classified as a mechanical regression
- the requested resolution conflicts with repository instructions or recorded notes
- completing the update would discard unrelated work or rewrite published history

Regrafter may ask before mutation when it can detect the choice early. A three-way merge may reveal the choice only after the new base commit and conflicted overlay exist. That is a valid pause state because the base is committed and the overlay is recoverable.

Silence never approves a recommendation. Regrafter waits for a matching decision response.

## Decision packet

A `needs_decision` report contains one decision packet:

```json
{
  "id": "decision-7",
  "graft": "goal",
  "question": "Which run-safety behavior should the merged package keep?",
  "context": "Upstream replaced the execution guard that the local overlay extends.",
  "options": [
    {
      "id": "preserve-local",
      "label": "Port the local guard to the new upstream runner",
      "effect": "Keeps the current OnurPi safety behavior and adopts the new runner.",
      "files": ["packages/goal/runtime.ts"],
      "reversible": true
    },
    {
      "id": "take-upstream",
      "label": "Remove the local guard",
      "effect": "Matches upstream but removes the existing OnurPi safety behavior.",
      "files": ["packages/goal/runtime.ts"],
      "reversible": true
    }
  ],
  "recommendation": {
    "option": "preserve-local",
    "reason": "The manifest note requires the run-safety behavior and the new runner exposes an equivalent hook."
  },
  "evidence": [
    "regraft note: preserve autonomous run boundaries",
    "upstream commit abc123 moved execution into Runner.start"
  ],
  "repository": {
    "branch": "update-vendors",
    "head": "def456",
    "dirty_paths": ["packages/goal/runtime.ts"]
  }
}
```

Each option states its effect and affected files. The recommendation cites repository evidence or user instructions. The packet avoids invented certainty scores.

The driver answers with the decision id and a message:

```bash
regrafter send run-42 \
  --decision decision-7 \
  --message "Choose preserve-local. Keep the existing public behavior." \
  --json
```

The controller rejects stale or unknown decision ids. Regrafter records the answer in the same Pi session before it edits the conflicted files. A later conflict may produce another packet.

## Controller output

Every controller command writes one JSON object to stdout when `--json` is set. Logs and model streaming go to stderr or a referenced log file.

A terminal result has this common shape:

```json
{
  "schema_version": 1,
  "run_id": "run-42",
  "state": "needs_decision",
  "repository": "/path/to/repository",
  "session_id": "pi-session-id",
  "summary": "The goal update is paused at a behavior conflict.",
  "decision": {},
  "commits": [
    {
      "kind": "base",
      "graft": "goal",
      "sha": "def456"
    }
  ],
  "checks": [],
  "next": "Answer decision-7 to continue."
}
```

`decision` is present only for `needs_decision`. Each commit entry names its `base` or `overlay` role and associated graft. Each check entry names the command, scope, outcome, and exit code. `completed` includes updated grafts and their old and new upstream commits. `blocked` includes the blocker, evidence gathered, attempted safe actions, and the input or external change needed. A controller-authored completion block also preserves the rejected report and starting baseline. `failed` describes recovery after an unexpected failure. `handed_off` includes the bounded audit record and release state.

Unknown top-level fields are rejected for controller input. Consumers must reject unsupported `schema_version` values. The strict run schema remains version 1. Existing version-1 run records remain directly readable for inspection and handoff. New runs include the graft baseline. An existing run without that baseline cannot use inferred completion evidence; it must restart from a clean state or use explicit handoff.

## Direct and driven sessions

Direct TUI sessions and controller-driven sessions use the same Regrafter prompt and repository rules. They differ only in who answers.

In a TUI session, Regrafter asks the person directly and continues after their next message. In a driven session, the reporting extension emits `needs_decision`, the process exits, and the main agent later resumes the session with `regrafter send`.

A run cannot switch between direct and driven modes while a controller process is working. An idle driven run may be opened interactively only through an explicit attach command that keeps the same session and lease. Detaching returns it to a controller-readable terminal state.

## Authority and Git operations

The initial request defines the allowed scope. The controller records whether Regrafter may create overlay commits, push branches, or open pull requests.

Regraft's pristine base commits are part of every successful update and do not require a separate approval after the update itself is approved. Overlay commits are required between multiple graft updates, so a driver that requests several updates must either permit those commits or expect a decision after each graft.

Pushing, opening a pull request, merging, changing a public API, removing local behavior, or copying credentials requires explicit authority from the request or a later decision. Regrafter uses existing Git and hosting credentials in place and never copies them into its app state.

## Failure and recovery

Regrafter reports `blocked` for expected conditions such as a dirty starting worktree, detached HEAD, missing base, moved source directory, unavailable credentials, a failing test that needs an owner decision, or a proposed completion that fails the controller contract. A controller-authored completion block remains resumable while its saved repository snapshot and lease still match.

It reports `failed` when an operation ends in an unexpected state or rollback cannot restore the repository. The report must name the current HEAD, dirty paths, created commits, attempted recovery, and the next manual inspection step. Existing failed and interrupted runs may use ownership handoff when their repository changed outside Regrafter.

`abort` does not reset repository changes. It records `aborted` only when the current branch, HEAD, and dirty paths match the last verified Regrafter snapshot and the named lease is released. `handoff prepare` and `handoff accept` cover external reconciliation. The accepted audit transfers responsibility for the bound state and then releases the lease. Manual lease deletion, force unlock, time-based cleanup, and PID-only cleanup are unsupported.

## Security and trust

Regrafter runs only in repositories trusted through Pi's normal project-trust rules. It loads the target repository's context files and project resources under those rules.

Source URLs cannot contain credentials. Git authentication comes from the existing credential helper or SSH configuration. Controller JSON and Pi sessions must redact credential-bearing environment values. Reports and logs must also redact remote URLs with user information.

The controller treats app bundle files and target repository files as separate trust inputs. Paths supplied through `--repo`, `--request-file`, or `--message-file` are resolved before launch. Git determines repository identity, independent of how the path was spelled.

## Boundaries

Regrafter does not replace Regraft's merge implementation. It does not fetch missing historical bases, invent local intent, run multiple updates against a dirty worktree, choose a product direction because one option is easier, or modify repository work during ownership handoff.

pi-factory continues to own app resolution and launch preparation. Pi owns the agent runtime and sessions. Within the `pi-regraft` package, Regraft owns vendoring state and merge behavior while Regrafter owns its prompt, controller, decision protocol, and repository lease. This code boundary does not require a separate repository or package.

## Acceptance criteria

The first release is complete when all of these behaviors are demonstrated:

- A person can launch the Regrafter bundle against a repository chosen with `--cwd`.
- A main Pi agent can start a headless run without receiving a Regraft model tool.
- A clean update completes, runs checks, and reports exact commits and upstream revisions.
- A semantic conflict returns `needs_decision` with evidence and at least two defensible options.
- A later controller command resumes the same Pi session, applies the selected option, and finishes the update.
- One run can request more than one decision without losing context or repository ownership.
- A killed controller process produces an inspectable `interrupted` run that can be safely resumed or aborted.
- A second run cannot acquire the same repository while the first run is active.
- A false `completed` report with a dirty or invalid commit chain becomes a resumable controller-authored `blocked` state.
- Missing overlay-commit authority leads to `needs_decision` or `blocked`, and later explicit authority resumes the same Pi session.
- Handoff evidence changes when the branch, HEAD, index, status, file type, mode, symlink target, or changed content changes.
- Handoff rejects a live process, wrong run, wrong lease, stale evidence, and unsupported state.
- An accepted handoff records its audit before lease release and retries safely across each partial-failure boundary.
- The August 24 run sequence ends with one durable `handed_off` audit and no old lease.
- Existing clean completion and exact-snapshot `abort` behavior remain unchanged.
- Unrelated Pi sessions receive no Regraft tool schema or Regrafter prompt text.
- No change to Pi core, Pi session schemas, or Regraft's committed-base format is required.
