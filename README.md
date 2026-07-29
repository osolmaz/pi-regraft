# pi-regraft

Vendor code from an upstream git repo into your project as plain files, then
re-pull upstream changes later without losing your local edits.

`pi-regraft` copies an upstream tree (a whole repo, a subdirectory, or a file
tree) into your project and records where it came from in a small `regraft.json`
manifest. When upstream moves on, it runs a three-way merge so upstream changes
land on top of your edits. Git does the mechanical merge; when something
genuinely conflicts, the Pi agent in your current session resolves it using the
intent notes you recorded, and then you run your own tests.

There is no second git repository and no snapshot store. The vendored files are
ordinary files in your own repo. The only added state is the manifest.

## Install

```bash
pi install git:github.com/osolmaz/pi-regraft
```

Or try it without installing:

```bash
pi -e git:github.com/osolmaz/pi-regraft
```

## Use

```
/regraft add <url>[@ref][#subdir] [dest]   copy an upstream tree in and track it
/regraft update <name>                     re-pull upstream, merging your edits
/regraft status                            show which grafts are behind upstream
/regraft note <name> <text>                record why a local edit exists
```

### Adding

```
/regraft add https://github.com/example/tool.git@main#extensions/foo vendor/foo
```

This resolves `main` to a commit, copies `extensions/foo` into `vendor/foo`, and
records the graft. Commit the pristine files first, then make your edits as a
separate commit — that keeps the original copy recoverable from your own git
history even if upstream rewrites or deletes it.

Record why each edit exists:

```
/regraft note foo "log every failed request"
```

### Updating

```
/regraft update foo
```

If the tracked ref moved, `pi-regraft` merges the upstream changes into your
edited copy. A clean merge just asks you to run your tests. A conflicting merge
leaves standard conflict markers in the files and hands the agent a brief with
the conflicted files and your intent notes, so it can resolve them while keeping
your intent — after which you run your tests and commit.

## How it works

An update is a three-way merge between the base you started from, your current
files, and the new upstream. See [docs/design.md](docs/design.md) for the model,
the per-file merge rules, and what is intentionally out of scope.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
