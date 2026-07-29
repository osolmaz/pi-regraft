import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects destinations inside Git metadata", async () => {
    await writeFile(join(upstream, "hook"), "malicious\n");
    await commitUpstream("v1");

    await expect(
      addGraft({
        manifestPath: join(project, "regraft.json"),
        spec: `${upstream}@main`,
        dest: ".git/hooks",
      }),
    ).rejects.toThrow("must not include a .git directory");
  });
});

describe("source selection", () => {
  it("reports upToDate when the tracked ref has not moved", async () => {
    await writeFile(join(upstream, "a.txt"), "a\n");
    await commitUpstream("v1");
    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    const result = await updateGraft(manifestPath, "a");
    expect(result.upToDate).toBe(true);
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
