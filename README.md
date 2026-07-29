# pi-regraft

Vendor code from an upstream Git repository into your project, edit it locally,
and pull later upstream changes without losing your work.

`pi-regraft` keeps the vendored files as ordinary files in your repository. It
also commits each pristine upstream version to your branch. Updates read the old
merge base from that local commit and fetch only the new upstream version. Git
handles the three-way merge. When a conflict needs judgment, the Pi agent in the
current session gets the affected files and your intent notes.

There is no second repository, hidden Git ref, or snapshot directory.

## Install

```bash
pi install git:github.com/osolmaz/pi-regraft
```

Or try it without installing:

```bash
pi -e git:github.com/osolmaz/pi-regraft
```

## Requirements

Run `pi-regraft` at the root of a Git repository. `add` and `update` require:

- an attached branch
- a clean worktree and index
- a configured Git author for the base commits

Keep the base commits in branch history. Rebasing them is fine, but squashing or
dropping them removes the local merge base and blocks later updates.

## Use

```text
/regraft add <url>[@ref][#subdir] [dest]   copy and commit an upstream tree
/regraft update <name>                     pull upstream and restore local edits
/regraft status                            show local bases and upstream status
/regraft note <name> <text>                record why a local edit exists
```

### Add a graft

```text
/regraft add https://github.com/example/tool.git@main#extensions/foo vendor/foo
```

This command:

1. Resolves `main` to an upstream commit.
2. Copies `extensions/foo` into `vendor/foo`.
3. Writes `regraft.json`.
4. Creates a `chore(regraft): import upstream base` commit containing the
   pristine files and manifest.

Make your local edits after that commit and commit them normally. Record the
reason for an edit when it may matter during a future conflict:

```text
/regraft note foo "log every failed request"
```

Commit the changed manifest before updating.

### Update a graft

```text
/regraft update foo
```

The command finds the matching base commit in local branch history, reads the
old pristine tree from it, and fetches the new tracked upstream commit. It then:

1. Merges the old base, the current committed files, and the new upstream tree
   in temporary directories.
2. Creates the next pristine upstream base commit.
3. Restores the merged local overlay into the worktree.

If there are no local changes to reapply, the new base commit is the complete
update and the worktree stays clean. Otherwise, run the project checks and
commit the restored overlay. Conflicting text edits contain normal Git conflict
markers. Pi receives the affected file list and your intent notes so it can help
resolve them.

The update never fetches the old pinned commit from upstream. It fails if the
matching local base commit is missing.

## Development

```bash
npm install
npm run typecheck
npm test
```

See [docs/design.md](docs/design.md) for the commit model and merge rules.

## License

[MIT](LICENSE)
