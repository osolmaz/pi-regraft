# pi-regraft design

## Problem

You want to use a piece of code from someone else's git repo — a Pi extension,
a helper module, a config directory — and you want to change it to fit your
project. Later, upstream improves that code and you want those improvements too,
without throwing away your edits and without hand-porting them every time.

A plain copy loses the connection to upstream. A git submodule or a fork keeps
the connection but makes the code a second repository you have to manage, and it
resists local edits. `pi-regraft` takes the middle path: the vendored code lives
in your project as ordinary files, and a small manifest remembers exactly where
each tree came from so updates can be merged in.

## Model

An update is a three-way merge. It needs three trees:

- **base (B)** — the upstream tree your current copy was taken from.
- **local (L)** — your current files on disk, including your edits.
- **upstream (U)** — the new upstream tree you want to move to.

`pi-regraft` recovers B by fetching the pinned commit recorded in the manifest,
takes L from the destination directory, and fetches U at the tracked ref. It
then merges B→U changes into L. This is the same operation git performs for a
branch merge, so upstream changes to files you never touched apply cleanly, and
only genuinely overlapping edits conflict.

There is no second git repository and no snapshot store. The manifest plus the
files on disk are the entire state.

### Recovering the base

The pinned commit in the manifest is the primary way to obtain B — it is fetched
from upstream on demand. Because that depends on upstream still having the
commit, the recommended workflow also keeps B in your own history:

1. `regraft add ...` copies the pristine upstream files in.
2. You commit those pristine files.
3. You make your edits and commit them separately.

Now your project's own history holds the original copy, so an upstream
force-push or repository deletion cannot strand you. The tool does not create
these commits for you; keeping the pristine-first discipline is a project
convention, and the extension reminds you after `add`.

## Manifest

`regraft.json` at the project root:

```json
{
  "version": 1,
  "grafts": [
    {
      "name": "review",
      "dest": "vendor/review",
      "source": {
        "url": "https://github.com/example/review.git",
        "ref": "main",
        "subdir": "extensions/review"
      },
      "commit": "8ec8146b0f...",
      "notes": ["log every failed request", "removed telemetry"]
    }
  ]
}
```

- `commit` is the merge base for the next update, advanced only after a
  successful update.
- `notes` capture *why* your edits exist, in your words. They are read back to
  the resolving agent on a conflict, so intent survives even when the original
  lines no longer apply textually.

## Merge behavior

For each path across the union of the three trees:

| base | local | upstream | result |
|------|-------|----------|--------|
| upstream == base | — | — | keep local, no change |
| local == base | — | changed | take upstream |
| local == base | — | deleted | delete locally |
| local == base | absent | added | add upstream file |
| diverged | edited | edited (text) | `git merge-file`; conflict markers if overlapping |
| diverged | edited | deleted | conflict (keep local, flag) |
| diverged | edited | edited (binary) | conflict (keep local, flag) |

Conflicts are written with standard `<<<<<<< local / ======= / >>>>>>> upstream`
markers, so any git conflict tooling — and the Pi agent — resolves them the same
way it resolves a branch merge.

## Who does what

- **Deterministic core** (`src/`): resolve refs, fetch trees, run the merge,
  write markers, update the manifest. No LLM. Independent of Pi and unit-tested.
- **Pi extension** (`extensions/regraft.ts`): the `/regraft` command surface.
  On a conflicting update it sends the agent a brief listing the conflicted
  files and the graft's intent notes; the agent resolves the markers and you run
  the project's own tests. On a clean update it reminds you to run those tests.

Pi is the resolver, and only for judgment. It is never the source of truth for
package state or for the merge result — git is.

## Commands

- `/regraft add <url>[@ref][#subdir] [dest]` — resolve the ref to a commit, copy
  the tree in, record the graft. Refuses a non-empty destination.
- `/regraft update <name>` — re-resolve the ref; if it moved, merge B→U into the
  destination and advance the pinned commit.
- `/regraft status` — show which grafts are behind their tracked ref.
- `/regraft note <name> <text>` — append an intent note.

## Scope

In scope for the first version: git sources, a single tracked ref, exact commit
pinning, whole-repo or subdirectory or single-file trees, three-way merge with
markers, agent-driven conflict resolution, status, and notes.

Deliberately out of scope for now, and left for later: npm sources,
package-manager-aware lockfile regeneration, an isolated resolver session with a
restricted toolset, learned/reused conflict resolutions (git rerere style),
and submodule or Git LFS handling. Binary conflicts are flagged for manual
selection rather than merged.

## Pi contract impact

- Session state: no writes.
- Other persistent data: only `regraft.json`, the tool's own manifest.
- Pi internals: none.
- Public API used: `pi.registerCommand`, `pi.exec` is not required (the core
  shells out to git directly), `pi.sendUserMessage`, and `ctx.ui.*`.

Pi loads the vendored directory as a normal local package; nothing Pi-owned is
touched.
