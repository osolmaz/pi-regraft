# pi-regraft design

## Problem

Vendored code often needs local changes. A plain copy loses its connection to
upstream, while a fork or submodule adds another repository to manage.
`pi-regraft` keeps the code as ordinary project files and records enough local
Git history to merge later upstream versions into those files.

## Three-way merge

An update needs three trees:

- **Base (B):** the pristine upstream tree used by the current local version.
- **Local (L):** the files at the consumer repository's current `HEAD`.
- **Upstream (U):** the new tree at the tracked upstream ref.

The merge applies the B-to-U changes to L. Upstream changes to untouched files
apply directly. Changes that overlap local edits may need conflict resolution.

B always comes from a commit in the consumer repository. The update fetches U
from upstream and never tries to fetch B from the old upstream commit.

## Local base commits

Every base is an ordinary commit in the consumer branch history. The commit
contains the pristine graft tree and the matching `regraft.json` pin. It uses a
fixed subject and two trailers:

```text
chore(regraft): import upstream base

Regraft-Name: review
Regraft-Upstream: 8ec8146b0f...
```

The trailers let the tool find the base after a rebase changes the consumer
commit ID. A candidate commit is accepted only when its committed manifest also
contains the same graft name, destination, and upstream commit.

The base commit is part of normal branch ancestry, so ordinary pushes and clones
carry it. Git garbage collection keeps it reachable. No hidden ref, side branch,
or snapshot directory is needed.

Squashing or dropping a base commit removes the pristine copy from ancestry.
The next update then stops with an error instead of falling back to upstream.

## Add flow

`regraft add` requires an attached branch and a clean worktree and index. It
then:

1. Resolves the tracked ref and exports its selected tree.
2. Writes the destination and manifest.
3. Stages only those paths.
4. Creates the first local base commit.

A failed commit restores the previous destination and manifest contents. Local
edits begin after the base commit and are committed through the project's normal
workflow.

## Update flow

`regraft update` also requires an attached branch and a clean worktree and
index. The clean-state rule ensures L is fully represented by `HEAD` and stops
the tool from committing unrelated changes.

The update runs these steps:

1. Find the newest matching local base commit for the manifest's current pin.
2. Export B and L from the consumer repository into temporary directories.
3. Resolve and export the new U from upstream.
4. Merge B, L, and U in the temporary L copy.
5. Put pristine U and the new manifest pin in the worktree and commit them as
   the next local base.
6. Replace the destination with the merged temporary L copy.

After step 5, the new base is safely in branch history. Step 6 leaves only the
local overlay relative to U in the worktree. If the overlay is empty, the
worktree stays clean. Otherwise, the user resolves conflicts, runs project
checks, and commits the overlay.

This produces an auditable sequence:

```text
base U1 -> local edits -> base U2 -> reapplied local edits -> base U3
```

## Manifest

`regraft.json` lives at the consumer repository root:

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

`commit` identifies the upstream revision represented by the latest local base
commit. `notes` explain why local edits exist. Pi receives them when an update
needs conflict resolution.

## Merge behavior

For each path across B, L, and U:

| Base | Local | Upstream | Result |
|---|---|---|---|
| same as upstream | any | unchanged | Keep local |
| same as local | unchanged | edited | Take upstream |
| same as local | unchanged | deleted | Delete locally |
| absent | absent | added | Add upstream file |
| edited | edited | edited text | Run `git merge-file` |
| present | edited | deleted | Keep local and flag a conflict |
| any | edited binary | edited binary | Keep local and flag a conflict |

Overlapping text changes use `<<<<<<< local`, `=======`, and `>>>>>>> upstream`
markers. Delete/edit and binary conflicts are listed for manual or agent review
even when a marker cannot represent the choice.

## Pi extension boundary

The implementation stays inside the public extension API:

- **Deterministic core:** reads and writes files, runs Git, finds local bases,
  creates base commits, and performs the merge.
- **Pi extension:** registers `/regraft`, shows notifications, and sends a
  follow-up message when the agent should resolve or verify an update.

Contract impact:

- **Session state:** no custom session entries or schema changes.
- **Other persistent data:** vendored files, `regraft.json`, and ordinary Git
  commits in the consumer repository.
- **Pi internals:** none.
- **Public API:** `registerCommand`, `sendUserMessage`, and `ctx.ui.notify`.

## Commands

- `/regraft add <url>[@ref][#subdir] [dest]`
- `/regraft update <name>`
- `/regraft status`
- `/regraft note <name> <text>`

## Scope

The first release supports Git sources, one tracked ref per graft, whole
repositories or subdirectories, exact upstream pins, local base commits,
three-way text merges, conflict reporting, status, and intent notes.

Package-manager lockfile updates, npm-specific sources, Git LFS, submodules,
binary merging, and reused conflict resolutions remain outside this release.
