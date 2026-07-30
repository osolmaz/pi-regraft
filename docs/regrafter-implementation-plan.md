# Regrafter implementation plan

This plan implements the [Regrafter specification](regrafter-spec.md) across `pi-regraft`, `pi-factory`, a new Regrafter app bundle, and an optional driver integration for OnurPi. Each repository keeps its existing ownership boundary. The work finishes with a real multi-step update in which a main Pi agent receives a decision request, supplies the answer, and resumes the same Regrafter run.

## Starting state

`pi-regraft` already provides the merge core and the `/regraft` command. It does not ship an executable for ordinary shell use.

Pi Factory already resolves app bundles and launches Pi with the app root as `cwd`. It does not accept a separate target working directory or provide launch overrides for a headless app controller.

OnurPi tracks four packages in `regraft.json` and preserves their pristine base commits. It installs `pi-regraft@0.1.0` from npm.

## Repository changes

### `pi-regraft`

Add a compiled `regraft` executable that calls the current operation functions. Keep the extension and command as thin adapters over the same result format.

The command work includes:

- parse `status`, `add`, `update`, and `note` without accepting shell fragments
- locate `regraft.json` from the canonical Git root when invoked below the root
- add `--json` with a versioned output schema
- define stable exit behavior for success, expected conflict resolution, blocked input, and operational failure
- keep conflict details, notes, old and new upstream commits, base commits, and overlay state in the JSON result
- send diagnostics to stderr so stdout contains one JSON value
- add a repository-level operation lock that composes with Git's own locks
- preserve the current transaction and rollback behavior
- bundle compiled JavaScript so the executable does not depend on TypeScript execution from `node_modules`

The existing `/regraft` command should call the same application service and format results for the TUI. It should stop owning update-specific logic once the shared result formatter exists.

### `pi-factory`

Separate the app root from the Pi process working directory.

Add:

```text
pi-factory run <app> --cwd <target>
pi-factory plan <app> --cwd <target>
```

The manifest and extension paths still resolve from the app root. The launch plan uses the target path for `cwd`. The generated Pi configuration remains under the app state directory.

Add a typed launch override to the JavaScript API. It must let an app-specific controller select a target `cwd`, Pi run mode, initial message, and session without rebuilding the shell command or environment itself. Keep argument construction as arrays until the final spawn boundary.

Validate the target path before writing runtime configuration. `plan` must show both `appRoot` and `cwd` so callers can review the separation.

### Regrafter app

Create a separate repository for the Regrafter Pi Factory app. Apply the normal repository defaults, MIT license, TypeScript Slophammer checks, and release-published npm workflow if the controller is published as a package.

The app contains:

```text
regrafter/
├── pi-factory.toml
├── prompts/
│   └── system.md
├── extensions/
│   └── report.ts
├── src/
│   ├── cli.ts
│   ├── controller.ts
│   ├── lease.ts
│   ├── reports.ts
│   └── runs.ts
└── tests/
```

The system prompt defines the update sequence, decision boundaries, Git rules, and direct-versus-driven behavior. It tells Regrafter to use the `regraft` executable for merge steps and forbids ad hoc replacements.

The reporting extension registers only `regrafter_report`. The tool has a strict schema for `needs_decision`, `completed`, `blocked`, and `failed`, and it returns `terminate: true`. It does not edit files or call another model.

The controller provides `start`, `send`, `inspect`, `list`, `attach`, and `abort`. It resolves the app through Pi Factory and runs Pi in a bounded headless mode. It opens or resumes the saved Pi session before printing the last valid report. `attach` opens the same session in Pi's TUI after checking that no controller process is working. The controller rejects a run that ends without a report.

The run index and lease records live under the Regrafter app state directory. Writes use temporary files, atomic rename, restrictive permissions, and schema validation. The index stores paths and ids but no prompt copies, credentials, or repository file contents.

### OnurPi driver integration

After the standalone flow works, add a small optional Regrafter driver skill to OnurPi. Its description should match requests to delegate vendored-package maintenance to Regrafter.

The skill teaches the main agent to:

- start a Regrafter run through the controller
- treat the target worktree as read-only while leased
- relay a decision when existing user instructions answer it
- ask the user when the choice exceeds the main agent's authority
- resume with the matching run and decision ids
- report Regrafter's commits and checks without claiming work it did not verify

The skill must not duplicate the Regrafter system prompt or Regraft merge rules. OnurPi should not register a Regraft model tool.

## Delivery sequence

### Shared contracts

Write the JSON schemas and TypeScript types for Regraft command results and Regrafter controller reports first. Add examples for clean completion, expected conflicts, decisions, blocked work, and failed recovery.

Freeze these fixtures for the cross-repository tests. The producer and consumer suites must read the same checked-in examples or a versioned package so field drift fails CI.

### Regraft command

Implement the command and route it through the existing core. Test it against temporary SHA-1 and SHA-256 repositories, annotated tags, symlinks, executable files, binary conflicts, moved source paths, missing bases, and rollback failures already covered by the library tests.

Add command-level tests for stdout/stderr separation, JSON schema versioning, exit codes, invocation below the repository root, and concurrent lock rejection.

Run:

```bash
npm run typecheck
npm test
npm pack --dry-run --json
```

Install the generated tarball into a temporary project and run the compiled executable there. Do not publish until the Pi Factory and Regrafter integration tests consume the tarball successfully.

### Pi Factory target directory

Implement `--cwd` and the launch override in Pi Factory. Test relative paths, absolute paths, spaces, missing directories, symlink aliases, and explicit app files. Use fake Pi commands and temporary directories as required by the repository.

Verify that app resources still resolve from the app root while Pi receives the target repository as its working directory. Ensure `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` remain controlled by Pi Factory.

Run the full Pi Factory gate:

```bash
npm run check
```

Run mutation tests before merge if the changed launch and CLI code is in the configured mutation scope.

### Controller and reports

Build the Regrafter app against local tarballs or worktrees for the two dependencies. Start with a fake Pi child process that emits known report events. Cover session creation and resume, malformed output, missing terminal reports, process interruption, and exit signal forwarding.

Implement the run index and repository lease. Test two path spellings for the same Git common directory, linked worktrees, an active competing run, an interrupted owner process, explicit abort, and a repository changed outside Regrafter while paused.

The controller should mark a run `working` before launch and write the terminal state only after Pi settles and the report validates. An abrupt exit leaves enough data for `inspect` to classify the run as `interrupted`. `list --repo` must recover active and paused runs without scanning or parsing Pi session contents.

### Decision workflow

Create a real Git fixture in which local and upstream code implement incompatible versions of one feature. Record a Regraft note that makes both resolution options understandable.

Drive this sequence through the controller:

1. Start a broad update request.
2. Let Regraft create the new pristine base and conflicted overlay.
3. Require Regrafter to emit `needs_decision` with repository evidence.
4. End the controller process.
5. Inspect the paused run from a new process.
6. Send the selected option with the matching decision id.
7. Reopen the same Pi session.
8. Resolve the files and run fixture checks.
9. Commit the overlay.
10. Return `completed` with the base and overlay commits.

Add a second fixture that asks two decisions in one run. Confirm that the first answer remains in context and that the lease stays active across both pauses.

Model-independent CI should use a scripted provider or deterministic fake session. Run one live-model smoke test before release to verify that the system prompt produces the expected report tool calls. Keep live credentials and transcripts out of the repository.

### Direct TUI workflow

Launch the bundle through Pi Factory with a temporary repository as `--cwd`. Confirm that context files come from the target repository, bundle prompts come from the app root, `/session` uses the Regrafter session directory, and a person can answer a decision in a later TUI message. Attach to a controller-created run and verify that the TUI opens the same session and preserves the repository lease.

No TUI-only state may be required for controller-driven resume.

### Main-agent delegation

Install the candidate Regrafter bundle and driver skill into an OnurPi test checkout. Ask the main agent to delegate the update to Regrafter.

Verify that the main agent:

- starts Regrafter with the intended repository and scope
- does not edit the leased worktree
- reads a `needs_decision` packet
- asks the user when the supplied instructions do not decide the issue
- sends the answer to the same run
- receives and checks the final report

The final test should include an explicit push request. Regrafter may push only when that authority appears in the initial task or a later answer.

## Review gates

Each repository change needs its own review because the ownership boundaries differ.

For `pi-regraft`, review the command as another adapter over the merge core. Reject duplicated merge logic or any fallback that fetches an old upstream base.

For Pi Factory, review the change as generic target-directory and launch-plan support. Reject Regraft-specific fields, prompts, or run states in Pi Factory.

For the Regrafter app, review decision quality, session resume, lease behavior, and report validation. Reject hidden product choices, automatic stale-lock deletion, and controller code that edits the target repository.

For OnurPi, review only the delegation skill and pinned package changes. Confirm that no Regraft tool schema appears in ordinary sessions.

## Release order

Release the dependencies before the app:

1. Publish the Pi Factory version that supports target working directories and launch overrides.
2. Publish the `pi-regraft` version that includes the compiled command and JSON contract.
3. Pin both versions in the Regrafter app and publish or install the first app release.
4. Add the optional driver skill and pinned Regrafter version to OnurPi.

Both existing projects are pre-1.0. These additions create new automation surfaces, so their release changes should follow each repository's pre-1.0 minor-version convention unless that convention changes before implementation.

Use GitHub Release publication and trusted npm publishing. Verify each registry artifact and provenance statement. Test both the executable and Pi Factory installation before updating downstream pins.

## Completion evidence

The implementation is complete when the following evidence is linked from the final Regrafter release:

- passing local and CI quality gates in every changed repository
- packed-artifact tests for both executables
- Pi Factory launch plans showing separate app and target roots
- controller logs for clean and decision runs, plus blocked, interrupted, and failed runs
- a two-decision resume test using one Pi session
- a real OnurPi delegation smoke test
- exact base and overlay commits for the real vendored-package update
- final `regraft status --json` output showing the updated grafts current

The release notes must state the remaining model-dependent limitation. The driving agent decides when to delegate unless the user explicitly names Regrafter. The controller and decision protocol are deterministic once delegation begins.
