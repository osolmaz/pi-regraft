# pi-regraft

`pi-regraft` is a Pi extension for vendoring code from Git repositories. It lets
you change the copied code in place and pull later upstream changes without
losing your work.

The vendored code stays in your repository as ordinary files. Regraft stores
pristine upstream copies in normal commits on your branch and uses them as
three-way merge bases during updates. It fetches only the new upstream commit.

## Install

Install from npm:

```bash
pi install npm:pi-regraft
```

You can also run the GitHub version without installing it:

```bash
pi -e git:github.com/osolmaz/pi-regraft
```

## First graft

Run Pi at the root of the repository that will receive the files. Add an
upstream repository, tracked ref, optional subdirectory, and destination:

```text
/regraft add https://github.com/example/tool.git@main#extensions/foo vendor/foo
```

The destination must be empty. Regraft copies the selected upstream tree into
`vendor/foo` and writes `regraft.json` before creating a commit named
`chore(regraft): import upstream base`.

Edit the copied files after that commit and commit your changes normally. If a
local change has a reason that may matter during conflict resolution, record it
in the manifest:

```text
/regraft note foo "log every failed request"
```

Commit the updated manifest before pulling from upstream.

## Updates

Check whether any tracked ref has advanced:

```text
/regraft status
```

Update one graft by name:

```text
/regraft update foo
```

Regraft reads the old pristine tree from your branch and fetches the new
upstream commit before merging these trees:

1. the old pristine upstream tree
2. your committed local tree
3. the new upstream tree

It commits the new pristine tree before restoring the merged local version in
your worktree. If you made no local changes, the worktree stays clean. If local
changes remain, run your project checks and commit the restored local version.

Text conflicts use normal Git conflict markers. Pi receives the affected file
paths and the notes from `regraft.json`, so the agent can help resolve them.
Regraft also preserves executable bits, symlinks, binary files, and
file-versus-directory changes.

## Commands

```text
/regraft add <url>[@ref][#subdir] [dest]   copy and commit an upstream tree
/regraft update <name>                     pull upstream and restore local edits
/regraft status                            show local bases and upstream status
/regraft note <name> <text>                record why a local edit exists
```

## Repository requirements

`add` and `update` require an attached Git branch, a clean worktree and index,
and a configured Git author. Git credentials must come from a credential helper
or SSH key. Regraft rejects credentials embedded in source URLs.

An update also refuses to run when ignored, uncommitted files exist inside the
graft. Move or remove those files first so they cannot be erased by the update.

Keep every `chore(regraft): import upstream base` commit in branch history.
Rebasing those commits is safe. Squashing or dropping them removes the merge
bases and blocks future updates.

Regraft fails when a required local base is missing. It never recovers the old
base by fetching the previously pinned commit from upstream.

The full commit model and merge rules are in
[the design document](docs/design.md).

## License

[MIT](LICENSE)
