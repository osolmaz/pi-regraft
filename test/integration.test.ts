import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.ts";
import { addGraft, updateGraft } from "../src/operations.ts";

let root: string;
let upstream: string;
let project: string;

async function g(args: string[], cwd: string): Promise<void> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function commitUpstream(message: string): Promise<void> {
  await g(["add", "-A"], upstream);
  await g(["commit", "-q", "-m", message], upstream);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "regraft-int-"));
  upstream = join(root, "upstream");
  project = join(root, "project");
  await mkdir(upstream, { recursive: true });
  await mkdir(project, { recursive: true });
  await g(["init", "-q", "-b", "main"], upstream);
  await g(["config", "user.email", "t@t"], upstream);
  await g(["config", "user.name", "t"], upstream);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("add + update against a real git repo", () => {
  it("vendors a tree and merges a later upstream change over a local edit", async () => {
    await writeFile(join(upstream, "greet.txt"), "hello\nworld\n");
    await writeFile(join(upstream, "keep.txt"), "unchanged\n");
    await commitUpstream("v1");

    const manifestPath = join(project, "regraft.json");
    const { graft } = await addGraft({
      manifestPath,
      spec: `${upstream}@main`,
      dest: "vendor/tool",
    });
    expect(graft.dest).toBe("vendor/tool");
    expect(existsSync(join(project, "vendor/tool/greet.txt"))).toBe(true);

    // Local edit on a line upstream will not touch.
    const greetPath = join(project, "vendor/tool/greet.txt");
    await writeFile(greetPath, "hello\nworld\nLOCAL EDIT\n");

    // Upstream advances on a different line and adds a file.
    await writeFile(join(upstream, "greet.txt"), "HELLO\nworld\n");
    await writeFile(join(upstream, "added.txt"), "new upstream file\n");
    await commitUpstream("v2");

    const res = await updateGraft(manifestPath, "tool");
    expect(res.upToDate).toBe(false);
    expect(res.report?.conflicts).toEqual([]);
    expect(res.report?.added).toContain("added.txt");
    expect(await readFile(greetPath, "utf8")).toBe("HELLO\nworld\nLOCAL EDIT\n");
  });

  it("reports upToDate when the tracked ref has not moved", async () => {
    await writeFile(join(upstream, "a.txt"), "a\n");
    await commitUpstream("v1");

    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/a" });

    const res = await updateGraft(manifestPath, "a");
    expect(res.upToDate).toBe(true);
  });

  it("leaves conflict markers when edits overlap", async () => {
    await writeFile(join(upstream, "config.txt"), "value = 1\n");
    await commitUpstream("v1");

    const manifestPath = join(project, "regraft.json");
    await addGraft({ manifestPath, spec: `${upstream}@main`, dest: "vendor/cfg" });

    const cfgPath = join(project, "vendor/cfg/config.txt");
    await writeFile(cfgPath, "value = 2\n");

    await writeFile(join(upstream, "config.txt"), "value = 3\n");
    await commitUpstream("v2");

    const res = await updateGraft(manifestPath, "cfg");
    expect(res.report?.conflicts).toContain("config.txt");
    const merged = await readFile(cfgPath, "utf8");
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("value = 2");
    expect(merged).toContain("value = 3");
  });

  it("vendors only a subdirectory when requested", async () => {
    await mkdir(join(upstream, "pkg/inner"), { recursive: true });
    await writeFile(join(upstream, "pkg/inner/x.txt"), "x\n");
    await writeFile(join(upstream, "top.txt"), "top\n");
    await commitUpstream("v1");

    const manifestPath = join(project, "regraft.json");
    const { graft } = await addGraft({
      manifestPath,
      spec: `${upstream}@main#pkg`,
      dest: "vendor/pkg",
    });
    expect(graft.source.subdir).toBe("pkg");
    expect(existsSync(join(project, "vendor/pkg/inner/x.txt"))).toBe(true);
    expect(existsSync(join(project, "vendor/pkg/top.txt"))).toBe(false);
  });
});
