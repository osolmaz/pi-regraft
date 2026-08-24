---
title: Regrafter lease recovery plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-24
tags: [regrafter, recovery, leases]
---

# Regrafter lease recovery plan

Regrafter 0.5.1 can retain a repository lease with no supported release path. The failure starts when the agent reports `completed` with a dirty worktree. The controller changes the run to `failed` and keeps the lease. If another process later changes the branch, HEAD, or worktree, `abort` rejects the new state and the run cannot resume.

The fix belongs in the Regrafter controller. The controller will validate completion, preserve expected protocol violations as resumable blocked work, and provide an explicit ownership handoff for repositories reconciled outside Regrafter.

The [Regrafter specification](regrafter-spec.md) defines the lasting contract. This plan records the implementation, tests, delivery work, and boundaries for pi-regraft 0.6.0.

## Selected design

The controller will capture a local graft baseline before a new run starts. A `completed` report remains a proposal until the controller checks the clean worktree, reported checks, starting baseline, final manifest, and exact Git commit chain.

A report that fails this contract will produce a controller-authored `blocked` state. The blocked run keeps its Pi session and rejected report together with its evidence, baseline, snapshot, and lease. A driver can grant overlay-commit authority and resume the same session while the saved repository state still matches.

A repository changed outside Regrafter needs a separate handoff. The operator will first prepare evidence for one run and one repository state, then accept responsibility for that exact evidence. The controller will record the accepted handoff before it releases the lease. Handoff will not modify or validate repository work.

## State and data contracts

The strict run schema stays at version 1. New runs gain a graft baseline. Historical version-1 records remain directly readable for inspection and ownership handoff. No parallel state format or fallback parser will be added.

The implementation will add these types:

- `GraftBaseline` records the graft name, destination, pinned upstream commit, local pristine base commit, and whether the starting HEAD has a committed local overlay under the destination.
- `RejectedCompletion` stores the agent report, controller reasons, observed repository state, and next action.
- `RepositoryEvidence` stores bounded repository metadata and hashes without file contents.
- `HandoffCandidate` binds a run, lease, prior snapshot, and current evidence to one digest.
- `HandoffAudit` records the actor and reason together with the time, prior snapshot, accepted evidence, digest, and release status.

`RunState` gains terminal state `handed_off`. Semantic validation will require a complete handoff audit for this state and reject handoff fields on incompatible states.

Actor is an audit label of 1 to 128 UTF-8 bytes. Reason is read from a file and contains 1 to 2048 UTF-8 bytes. Evidence digests use lowercase 64-character SHA-256 values. Actor identifies the stated operator or automation source; it does not authenticate that identity.

## Starting graft baseline

`startRun` will capture the baseline before it invokes Pi. The controller will parse `regraft.json` and use local Regraft and Git helpers to find each graft's current pristine base. It will compare that base with the starting HEAD under the graft destination to determine whether a committed local overlay exists.

Baseline capture must remain network-free and non-mutating. A missing or invalid local base will use the existing blocked or error behavior. The controller will not fetch an old base or infer local intent.

A historical run without this baseline can still be inspected, aborted from its saved snapshot, or handed off. It cannot use an inferred completion check. Such work must restart from a clean state or use explicit ownership handoff.

## Completion validation

The dirty-worktree check will become a full completion validator. The controller will accept `completed` only when all required facts agree.

The validator will require:

- A clean observed worktree and index.
- No failed reported check.
- Existing commit objects for every reported SHA.
- An exact first-parent chain from the run's starting HEAD to its observed HEAD.
- No missing, reordered, squashed, or extra run commit.
- A matching base or overlay role and graft name for every reported commit.
- Old and new upstream revisions that agree with the starting baseline and final manifest.
- Every pristine Regraft base commit preserved in branch ancestry.
- An overlay commit after the new base when the starting baseline contained a local overlay.

A base-only update is valid when the baseline had no local overlay and the new base is the final run commit. The validator may confirm Git structure and authority along with the reported checks. It will not judge whether the merged behavior is correct.

## Recoverable protocol rejection

An expected completion-contract violation will no longer call the unrecoverable failure path. The controller will create a `blocked` report and run record with:

- The verified Pi session id.
- The original rejected report.
- The starting graft baseline.
- The observed repository snapshot.
- The controller's reasons.
- The exact next action.
- The repository lease.

If overlay work remains and commit authority is absent, the driver can resume with `--allow commits`. The same Pi session will finish the overlay, run checks, and submit a new report. `sendRun` will keep its existing lease and snapshot checks.

Changes made outside Regrafter can invalidate direct resume. In that case, `send` and `abort` will stop. The operator can restore the saved state or use the evidence-bound handoff.

Unexpected launcher errors, malformed reports, persistence failures, and controller defects will remain `failed`.

## Handoff evidence

Evidence will bind acceptance to the reviewed state. Its canonical digest will include:

- The evidence schema tag.
- Run id, canonical repository path, and Git common directory.
- The exact lease record and run update identity.
- The prior verified snapshot.
- Current branch and HEAD.
- Raw index state, status codes, and paths.
- File type, mode, symlink target, and content hashes for changed and untracked paths.

File data will stream through the hash function with bounded memory. The run record will store metadata and hashes only. It will not store repository file contents.

Evidence capture will read Git state before and after hashing. A change during capture makes the candidate invalid. The controller will report that the repository changed and require a new prepare step.

## Public handoff interface

The controller will export:

```ts
prepareHandoff(runId);
acceptHandoff(runId, evidence, actor, reason);
```

The CLI will expose:

```bash
regrafter handoff prepare <run-id> --json
regrafter handoff accept <run-id> \
  --evidence <sha256> \
  --actor <id> \
  --reason-file <path> \
  --json
```

`prepareHandoff` will run under the existing run lock. It will inspect a dead working process through the normal transition, reject a live process, verify that the named run owns the lease, and accept only documented leased recovery states. The result will include a non-secret digest, prior snapshot, and current evidence.

`acceptHandoff` will reacquire the run lock and repeat the state and process checks before it verifies lease ownership. It will compute the evidence again and require the supplied digest to match. It will reject a wrong run, wrong or absent lease, unsupported state, and changed repository evidence.

Neither operation will reset, clean, commit, edit, validate, or endorse repository work. Handoff grants no commit, push, pull-request, merge, or release authority. The CLI will provide no force, unlock, expiry, or lease-file command.

## Durable lease release

Handoff acceptance and lease deletion cannot share one filesystem transaction. The controller will use durable-before-release ordering and make every partial state retryable.

The order is:

1. Save `handed_off` with actor, reason, acceptance time, prior snapshot, accepted evidence, digest, and release status `pending`.
2. Read the lease again and verify that the same run still owns it.
3. Release only that run's lease.
4. Save release completion and time.

Failure before the first save leaves the old lease intact. Failure during release leaves a durable pending handoff and the old lease. Failure after release can leave a pending audit with no old lease. Repeating acceptance with the same digest will finish the pending work.

A retry will never remove a lease owned by a later run. If another run acquired the repository after the old lease was removed, the retry may finish the old audit but must leave the new lease unchanged.

## Agent protocol

`regrafter/system.md` will state the completion rules in plain terms. A completed update requires clean Git status, exact base and overlay commit reporting, passed checks, and preserved pristine bases.

When `regraft update --json` reports `overlay_pending` and commit authority is absent, Regrafter must return `needs_decision` or `blocked`. It must not report `completed` with an uncommitted overlay. It must not suggest deleting a lease file.

The controller will enforce the contract even when the model does not follow the prompt.

## Implementation sequence

Work will proceed in this order:

1. Update `docs/regrafter-spec.md` with the state and completion contracts together with handoff behavior.
2. Add strict types, schemas, state-specific validation, and the `handed_off` state.
3. Capture the local graft baseline for new runs.
4. Add stable repository evidence and streamed hashing.
5. Add completion and commit-chain validation.
6. Route invalid completion to resumable `blocked` state.
7. Add handoff prepare, accept, durable release, and retry handling.
8. Export the API and add the CLI command family.
9. Tighten the Regrafter system prompt.
10. Add focused tests and the August 24 regression.
11. Update README and other normative documents to match the shipped behavior.
12. Prepare package metadata for version 0.6.0 and run the release-candidate checks.

## Test coverage

Completion tests will cover clean no-op work, a valid base-only update, a valid base-plus-overlay update, and several base and overlay pairs. Rejection tests will cover a dirty overlay, missing required overlay, missing or dropped base, squashed commits, wrong role or order, unreported commit, final HEAD mismatch, failed checks, and inconsistent upstream revisions.

Blocked-run tests will prove that the session, rejected report, baseline, evidence, and lease remain available. One test will grant commit authority, resume the same session, create a valid overlay, and complete with one lease release. A changed snapshot will prevent resume.

Evidence tests will cover changes to branch, HEAD, staged index, tracked contents, an unchanged dirty path with new bytes, untracked contents, mode, symlink target, deletion, and rename. They will cover stable repeated reads, bounded-memory hashing, absent file contents in saved JSON, and a repository change during capture.

Handoff tests will cover eligible recovery states, wrong run, wrong repository, wrong or missing lease, live process, stale digest, changed evidence, unsupported state, invalid actor or reason, and no repository mutation. Concurrency tests will race prepare and accept with `send`, `abort`, another accept, and a new start.

Failure injection will cover the first audit save, lease release, and final audit save. Each test will retry and confirm one terminal audit, no old lease, and no change to a later run's lease.

The August 24 regression will recreate these facts:

1. A run starts without overlay-commit authority.
2. Regraft creates pristine base `afb476b` and restores a dirty overlay.
3. Regrafter submits an invalid `completed` report.
4. The controller preserves the run as `blocked` on the new contract.
5. External work changes the branch, HEAD, or worktree.
6. Resume and exact-snapshot `abort` refuse the changed state.
7. The operator prepares and accepts matching handoff evidence.
8. The durable audit remains and the named lease is released.

Existing clean completion and exact-snapshot `abort` behavior must remain unchanged.

## Documentation and public contract

README will document the shipped commands after implementation. It will distinguish resume, exact-snapshot `abort`, and accepted handoff. It will warn that handoff transfers responsibility and does not prove correctness. It will explain that actor is only an audit label and provides no authentication. A pending release can be retried.

The public API gains handoff functions and evidence types. The CLI gains the `handoff` command family. JSON schema version stays at 1 and gains the documented `handed_off` terminal state. Exhaustive consumers must handle that state.

Pi session entries and schemas will not change. A blocked completion retains the existing Regrafter session id. Pi core and private Pi APIs remain untouched.

## Verification and review

Development will use focused Vitest runs where useful. Final local verification will run:

```bash
npm run check
git diff --check
npm pack --dry-run --json
```

The packed artifact must contain the controller, CLI, exported types, documentation, and Regrafter prompt. It must not contain credentials, repository files, or local Regrafter state.

Mutation tests will remain available and will not run as this task's local normal verification.

Pi Reviewer will compare the implementation with `main`. All P0 and P1 findings must be fixed. Valid and proportionate P2 findings will also be addressed. The final pull-request head must pass CI before merge.

## Version and delivery

This change adds a public command family, exported APIs, JSON output, and a persistent terminal state. The package and lockfile will be prepared as pi-regraft 0.6.0.

Implementation may create Conventional Commits, push the task branch, open or update one pull request, respond to review comments, and rebase-merge after review and CI pass. The task will not publish npm, create a tag or GitHub Release, or deploy anything.

## Boundaries

The implementation stays inside `osolmaz/pi-regraft`. It will not add lease expiry, elapsed-time cleanup, PID-only cleanup, unconditional force unlock, or direct lease-file deletion. It will not reset, clean, commit, rewrite, validate, or endorse repository work during handoff.

The fix will not add an isolated run worktree, private run ref, transaction manifest, journal service, remote promotion, or narrower lease. Those changes belong to a larger transaction design.

No work will change Pi core, Pi private APIs, external services, credentials, authentication, repository policy, CI policy, or mutation-test policy.

## Follow-on work

OnurPi adoption starts only after pi-regraft 0.6.0 is released and the unrelated OnurPi restart work has a clean handoff. That later task will pull OnurPi with `git pull --ff-only`, update the reviewed Regrafter driver pin and provenance, and run its required checks.

The historical run `run-47ac0bee92202627315637a05af4cc3d` can then use the released handoff command after an operator reviews its evidence. Clearing that lease and regrafting unified-exec remain separate tasks. This implementation will not modify OnurPi, its Regrafter state, or unified-exec.
