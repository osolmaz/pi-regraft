import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.ts";
import { addGraft, updateGraft } from "../src/operations.ts";

let root: string;
let upstream: string;
let project: string;

async function g(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function configureRepo(path: string): Promise<void> {
  await g(["config", "user.email", "test@example.com"], path);
  await g(["config", "user.name", "Test User"], path);
}

async function commitAll(path: string, message: string): Promise<void> {
  await g(["add", "-A"], path);
  await g(["commit", "-q", "-m", message], path);
}

async function commitUpstream(message: string): Promise<void> {
  await commitAll(upstream, message);
}

async function commitProject(message: string): Promise<void> {
  await commitAll(project, message);
}

async function withGitConfig<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
  const previous = keys.map((name) => process.env[name]);
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = key;
  process.env.GIT_CONFIG_VALUE_0 = value;
  try {
    return await fn();
  } finally {
    keys.forEach((name, index) => {
      const oldValue = previous[index];
      if (oldValue === undefined) delete process.env[name];
      else process.env[name] = oldValue;
    });
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "regraft-int-"));
  upstream = join(root, "upstream");
  project = join(root, "project");
  await mkdir(upstream, { recursive: true });
  await mkdir(project, { recursive: true });
  await g(["init", "-q", "-b", "main"], upstream);
  await g(["init", "-q", "-b", "main"], project);
  await configureRepo(upstream);
  await configureRepo(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local committed merge bases", () => {
  it("commits the pristine copy during add", async () => {
    await writeFile(join(upstream, "a.txt"), "upstream v1\n");
    await commitUpstream("v1");

    const { graft, baseCommit } = await addGraft({
      manifestPath: join(project, "regraft.json"),
      spec: `${upstream}@main`,
      dest: "vendor/tool",
    });

    expect(baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
    expect(await g(["show", `${baseCommit}:vendor/tool/a.txt`], project)).toBe("upstream v1\n");
    const message = await g(["show", "-s", "--format=%B", baseCommit], project);
    expect(message).toContain(`Regraft-Name: ${graft.name}`);
    expect(message).toContain(`Regraft-Upstream: ${graft.commit}`);
  });

  it("reads the old base locally when upstream no longer has the commit", async () => {
    await writeFile(join(upstream, "greet.txt"), "hello\nworld\n");
    await commitUpstream("v1");

    const manifestPath = join(project, "regraft.json");
    const added = await addGraft({
      manifestPath,
      spec: `${upstream}@main`,
      dest: "vendor/tool",
    });
    const greetPath = join(project, "vendor/tool/greet.txt");
    await writeFile(greetPath, "hello\nworld\nLOCAL EDIT\n");
    await commitProject("feat: customize greeting");

    // Replace upstream history entirely. The old upstream commit can no longer
    // be fetched, so a successful update proves B came from the consumer repo.
    await rm(join(upstream, ".git"), { recursive: true, force: true });
    await g(["init", "-q", "-b", "main"], upstream);
    await configureRepo(upstream);
    await writeFile(join(upstream, "greet.txt"), "HELLO\nworld\n");
    await writeFile(join(upstream, "added.txt"), "new upstream file\n");
    await commitUpstream("replacement v2");

    const result = await updateGraft(manifestPath, "tool");

    expect(result.localBaseCommit).toBe(added.baseCommit);
    expect(result.newBaseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.overlayPending).toBe(true);
    expect(result.report?.conflicts).toEqual([]);
    expect(await readFile(greetPath, "utf8")).toBe("HELLO\nworld\nLOCAL EDIT\n");
    expect(await g(["show", `${result.newBaseCommit}:vendor/tool/greet.txt`], project)).toBe(
      "HELLO\nworld\n",
    );
    expect(await g(["show", `${result.newBaseCommit}:vendor/tool/added.txt`], project)).toBe(
      "new upstream file\n",
    );
  });

  it("uses each new pristine base commit for later updates", async () => {
    const v1 = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n";
    await writeFile(join(upstream, "a.txt"), v1);
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    await writeFile(join(project, "vendor/a/a.txt"), v1.replace("one", "ONE"));
    await commitProject("feat: customize first line");
    const v2 = v1.replace("twelve", "TWELVE");
    await writeFile(join(upstream, "a.txt"), v2);
    await commitUpstream("v2");

    const first = await updateGraft(manifestPath, "a");
    await commitProject("chore: apply local overlay");

    const v3 = v2.replace("seven", "SEVEN");
    await writeFile(join(upstream, "a.txt"), v3);
    await commitUpstream("v3");
    const second = await updateGraft(manifestPath, "a");

    expect(second.localBaseCommit).toBe(first.newBaseCommit);
    expect(second.report?.conflicts).toEqual([]);
    expect(await readFile(join(project, "vendor/a/a.txt"), "utf8")).toBe(
      v3.replace("one", "ONE"),
    );
  });

  it("leaves the worktree clean when there is no local overlay", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    await writeFile(join(upstream, "a.txt"), "a2\n");
    await commitUpstream("v2");
    const result = await updateGraft(manifestPath, "a");

    expect(result.overlayPending).toBe(false);
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
    expect(await readFile(join(project, "vendor/a/a.txt"), "utf8")).toBe("a2\n");
  });

  it("keeps updating after an upstream revision becomes empty", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    await rm(join(upstream, "a.txt"));
    await commitUpstream("empty v2");
    const empty = await updateGraft(manifestPath, "a");
    expect(empty.overlayPending).toBe(false);
    await rm(join(project, "vendor/a"), { recursive: true, force: true });

    await writeFile(join(upstream, "b.txt"), "b3\n");
    await commitUpstream("v3");
    const restored = await updateGraft(manifestPath, "a");

    expect(restored.localBaseCommit).toBe(empty.newBaseCommit);
    expect(restored.overlayPending).toBe(false);
    expect(await readFile(join(project, "vendor/a/b.txt"), "utf8")).toBe("b3\n");
  });

  it("leaves conflict markers over the newly committed upstream base", async () => {
    await writeFile(join(upstream, "config.txt"), "value = 1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/cfg" });

    const cfgPath = join(project, "vendor/cfg/config.txt");
    await writeFile(cfgPath, "value = 2\n");
    await commitProject("feat: customize config");
    await writeFile(join(upstream, "config.txt"), "value = 3\n");
    await commitUpstream("v2");

    const result = await updateGraft(manifestPath, "cfg");

    expect(result.report?.conflicts).toContain("config.txt");
    expect(result.overlayPending).toBe(true);
    expect(await g(["show", `${result.newBaseCommit}:vendor/cfg/config.txt`], project)).toBe(
      "value = 3\n",
    );
    const merged = await readFile(cfgPath, "utf8");
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("value = 2");
    expect(merged).toContain("value = 3");
  });
});

describe("repository safety", () => {
  it("rolls add back when the base commit fails", async () => {
    await writeFile(join(upstream, "a.txt"), "a\n");
    await commitUpstream("v1");
    await g(["config", "user.name", ""], project);

    await expect(
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main`,
        dest: "vendor/a",
      }),
    ).rejects.toThrow("could not commit the local regraft base");

    expect(existsSync(join(project, "regraft.json"))).toBe(false);
    expect(existsSync(join(project, "vendor/a"))).toBe(false);
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
  });

  it("rolls newly added upstream files back when an update commit fails", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });
    await g(["config", "user.name", ""], project);
    await writeFile(join(upstream, "a.txt"), "a2\n");
    await writeFile(join(upstream, "new.txt"), "new\n");
    await commitUpstream("v2");

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow(
      "could not commit the local regraft base",
    );

    expect(await readFile(join(project, "vendor/a/a.txt"), "utf8")).toBe("a1\n");
    expect(existsSync(join(project, "vendor/a/new.txt"))).toBe(false);
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
  });

  it("rolls the destination back when manifest writing fails", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });
    await writeFile(join(upstream, "a.txt"), "a2\n");
    await writeFile(join(upstream, "new.txt"), "new\n");
    await commitUpstream("v2");
    await chmod(manifestPath, 0o444);

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow();

    expect(await readFile(join(project, "vendor/a/a.txt"), "utf8")).toBe("a1\n");
    expect(existsSync(join(project, "vendor/a/new.txt"))).toBe(false);
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
  });

  it("cleans a newly nonempty destination when an update commit fails", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    await rm(join(upstream, "a.txt"));
    await commitUpstream("empty v2");
    await updateGraft(manifestPath, "a");

    await writeFile(join(upstream, "b.txt"), "b3\n");
    await commitUpstream("v3");
    await g(["config", "user.name", ""], project);

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow(
      "could not commit the local regraft base",
    );

    expect(existsSync(join(project, "vendor/a/b.txt"))).toBe(false);
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
  });

  it("rejects a committed replacement of the graft root with a file", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    await rm(join(project, "vendor/a"), { recursive: true, force: true });
    await writeFile(join(project, "vendor/a"), "local root file\n");
    await commitProject("feat: replace graft root");
    await writeFile(join(upstream, "a.txt"), "a2\n");
    await commitUpstream("v2");

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow(
      "is not a directory in local commit",
    );
    expect((await g(["status", "--porcelain"], project)).trim()).toBe("");
  });

  it("refuses update while local edits are uncommitted", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });
    await writeFile(join(project, "vendor/a/a.txt"), "dirty\n");

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow("clean Git worktree");
  });

  it("refuses update when the local base commit is absent from ancestry", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    await g(["checkout", "--orphan", "without-base"], project);
    await g(["add", "-A"], project);
    await g(["commit", "-q", "-m", "chore: squash imported files"], project);
    await writeFile(join(upstream, "a.txt"), "a2\n");
    await commitUpstream("v2");

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow("no committed local base");
  });

  it("rejects credential-bearing source URLs without echoing the secret", async () => {
    let message = "";
    try {
      await addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: "https://user:super-secret@example.com/repo.git@main",
        dest: "vendor/a",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("must not contain credentials");
    expect(message).not.toContain("super-secret");
    expect(existsSync(join(project, "regraft.json"))).toBe(false);
  });

  it("rejects destinations outside the repository", async () => {
    await writeFile(join(upstream, "a.txt"), "a\n");
    await commitUpstream("v1");

    await expect(
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main`,
        dest: "../outside",
      }),
    ).rejects.toThrow("destination must stay inside its root");
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  it("rejects destinations inside Git metadata, including filesystem aliases", async () => {
    await writeFile(join(upstream, "hook"), "malicious\n");
    await commitUpstream("v1");

    for (const dest of [".git/hooks", ".GIT/hooks", ".git./hooks", ".git /hooks"]) {
      await expect(
        addGraft({
          manifestPath: join(project, "regraft.json"),
          spec: `${upstream}@main`,
          dest,
        }),
      ).rejects.toThrow("must not include a .git directory");
    }
  });

  it("rejects destination parents that are symlinks", async () => {
    await writeFile(join(upstream, "a.txt"), "a\n");
    await commitUpstream("v1");
    const external = join(root, "external");
    await mkdir(external);
    await symlink(external, join(project, "vendor"), "dir");
    await commitProject("chore: link vendor directory");

    await expect(
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main`,
        dest: "vendor/tool",
      }),
    ).rejects.toThrow("passes through symlink");
    expect(existsSync(join(external, "tool"))).toBe(false);
  });

  it("refuses to erase ignored files inside a graft", async () => {
    await writeFile(join(upstream, "a.txt"), "a1\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });
    await writeFile(join(project, ".gitignore"), "vendor/a/generated.log\n");
    await commitProject("chore: ignore generated graft output");
    const ignored = join(project, "vendor/a/generated.log");
    await writeFile(ignored, "keep me\n");
    await writeFile(join(upstream, "a.txt"), "a2\n");
    await commitUpstream("v2");

    await expect(updateGraft(manifestPath, "a")).rejects.toThrow("contains ignored files");
    expect(await readFile(ignored, "utf8")).toBe("keep me\n");
  });
});

describe("source selection", () => {
  it("supports SHA-256 upstream repositories", async () => {
    await rm(join(upstream, ".git"), { recursive: true, force: true });
    await g(["init", "-q", "-b", "main", "--object-format=sha256"], upstream);
    await configureRepo(upstream);
    await writeFile(join(upstream, "a.txt"), "sha256\n");
    await commitUpstream("v1");

    const { graft, baseCommit } = await addGraft({
      manifestPath: join(project, "regraft.json"),
      spec: `${upstream}@main`,
      dest: "vendor/a",
    });

    expect(graft.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(await g(["show", `${baseCommit}:vendor/a/a.txt`], project)).toBe("sha256\n");
  });

  it("preserves symlinks when Git defaults core.symlinks to false", async () => {
    await writeFile(join(upstream, "target.txt"), "target\n");
    await symlink("target.txt", join(upstream, "link.txt"));
    await commitUpstream("v1");

    const { baseCommit } = await withGitConfig("core.symlinks", "false", () =>
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main`,
        dest: "vendor/a",
      }),
    );

    expect((await lstat(join(project, "vendor/a/link.txt"))).isSymbolicLink()).toBe(true);
    expect(await g(["ls-tree", baseCommit, "vendor/a/link.txt"], project)).toMatch(/^120000 /);
  });

  it("rejects file selections that cannot be updated as trees", async () => {
    await writeFile(join(upstream, "only.txt"), "one\n");
    await commitUpstream("v1");

    await expect(
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main#only.txt`,
        dest: "vendor/only",
      }),
    ).rejects.toThrow("must be a directory");
  });

  it("rejects source subdirectories that traverse symlinks", async () => {
    const external = join(root, "upstream-external");
    await mkdir(external);
    await writeFile(join(external, "secret.txt"), "secret\n");
    await symlink(external, join(upstream, "escape"), "dir");
    await commitUpstream("add escaping symlink");

    await expect(
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main#escape/secret.txt`,
        dest: "vendor/exfil",
      }),
    ).rejects.toThrow("must not traverse symlinks");
    expect(existsSync(join(project, "vendor/exfil"))).toBe(false);
  });

  it("force-stages upstream files matched by consumer ignore rules", async () => {
    await mkdir(join(upstream, "dist"));
    await writeFile(join(upstream, "dist/bundle.js"), "bundle\n");
    await commitUpstream("v1");
    await writeFile(join(project, ".gitignore"), "vendor/tool/dist/\n");
    await commitProject("chore: ignore generated distributions");

    const { baseCommit } = await addGraft({
      manifestPath: join(project, "regraft.json"),
      spec: `${upstream}@main`,
      dest: "vendor/tool",
    });

    expect(await g(["show", `${baseCommit}:vendor/tool/dist/bundle.js`], project)).toBe(
      "bundle\n",
    );
    expect((await g(["status", "--porcelain", "--ignored"], project))).not.toContain(
      "vendor/tool/dist",
    );
  });

  it("reports upToDate when the tracked ref has not moved", async () => {
    await writeFile(join(upstream, "a.txt"), "a\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    const result = await updateGraft(manifestPath, "a");
    expect(result.upToDate).toBe(true);
  });

  it("preserves upstream executable-bit changes", async () => {
    const script = join(upstream, "run.sh");
    await writeFile(script, "#!/bin/sh\necho ok\n");
    await chmod(script, 0o644);
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/tool" });
    await g(["config", "core.fileMode", "false"], project);

    await chmod(script, 0o755);
    await commitUpstream("make executable");
    const result = await updateGraft(manifestPath, "tool");

    expect(result.overlayPending).toBe(false);
    expect((await lstat(join(project, "vendor/tool/run.sh"))).mode & 0o111).not.toBe(0);
    expect(await g(["ls-tree", result.newBaseCommit!, "vendor/tool/run.sh"], project)).toMatch(
      /^100755 /,
    );
  });

  it("vendors only a subdirectory when requested", async () => {
    await mkdir(join(upstream, "pkg/inner"), { recursive: true });
    await writeFile(join(upstream, "pkg/inner/x.txt"), "x\n");
    await writeFile(join(upstream, "top.txt"), "top\n");
    await commitUpstream("v1");

    const { graft } = await addGraft({
      manifestPath: join(project, "regraft.json"),
      spec: `${upstream}@main#pkg`,
      dest: "vendor/pkg",
    });

    expect(graft.source.subdir).toBe("pkg");
    expect(existsSync(join(project, "vendor/pkg/inner/x.txt"))).toBe(true);
    expect(existsSync(join(project, "vendor/pkg/top.txt"))).toBe(false);
  });
});
