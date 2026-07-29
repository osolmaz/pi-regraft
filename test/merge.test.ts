import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threeWayMerge } from "../src/merge.ts";

let root: string;
let base: string;
let local: string;
let upstream: string;

async function put(dir: string, rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "regraft-test-"));
  base = join(root, "base");
  local = join(root, "local");
  upstream = join(root, "upstream");
  await mkdir(base, { recursive: true });
  await mkdir(local, { recursive: true });
  await mkdir(upstream, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("threeWayMerge", () => {
  it("takes upstream changes on files you did not touch", async () => {
    await put(base, "a.txt", "one\n");
    await put(local, "a.txt", "one\n");
    await put(upstream, "a.txt", "one\ntwo\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.changed).toContain("a.txt");
    expect(report.conflicts).toEqual([]);
    expect(await readFile(join(local, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("keeps your edits when upstream did not change the file", async () => {
    await put(base, "a.txt", "one\n");
    await put(local, "a.txt", "one\nlocal\n");
    await put(upstream, "a.txt", "one\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.changed).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(await readFile(join(local, "a.txt"), "utf8")).toBe("one\nlocal\n");
  });

  it("merges non-overlapping edits from both sides cleanly", async () => {
    await put(base, "a.txt", "top\nmiddle\nbottom\n");
    await put(local, "a.txt", "TOP\nmiddle\nbottom\n");
    await put(upstream, "a.txt", "top\nmiddle\nBOTTOM\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.conflicts).toEqual([]);
    expect(report.changed).toContain("a.txt");
    expect(await readFile(join(local, "a.txt"), "utf8")).toBe("TOP\nmiddle\nBOTTOM\n");
  });

  it("marks overlapping edits as a conflict", async () => {
    await put(base, "a.txt", "value = 1\n");
    await put(local, "a.txt", "value = 2\n");
    await put(upstream, "a.txt", "value = 3\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.conflicts).toContain("a.txt");
    const merged = await readFile(join(local, "a.txt"), "utf8");
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain(">>>>>>>");
    expect(merged).toContain("value = 2");
    expect(merged).toContain("value = 3");
  });

  it("adds files introduced upstream", async () => {
    await put(base, "a.txt", "a\n");
    await put(local, "a.txt", "a\n");
    await put(upstream, "a.txt", "a\n");
    await put(upstream, "nested/new.txt", "brand new\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.added).toContain("nested/new.txt");
    expect(existsSync(join(local, "nested/new.txt"))).toBe(true);
  });

  it("removes files upstream deleted that you did not touch", async () => {
    await put(base, "gone.txt", "bye\n");
    await put(local, "gone.txt", "bye\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.removed).toContain("gone.txt");
    expect(existsSync(join(local, "gone.txt"))).toBe(false);
  });

  it("flags a conflict when upstream deletes a file you edited", async () => {
    await put(base, "keep.txt", "orig\n");
    await put(local, "keep.txt", "orig\nmy edit\n");

    const report = await threeWayMerge(base, local, upstream);

    expect(report.conflicts).toContain("keep.txt");
    expect(existsSync(join(local, "keep.txt"))).toBe(true);
  });
});
