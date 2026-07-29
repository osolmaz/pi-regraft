import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findGraft,
  readManifest,
  upsertGraft,
  writeManifest,
  type Graft,
} from "../src/manifest.ts";
import { parseSourceSpec } from "../src/operations.ts";

let root: string;
let path: string;

function graft(name: string): Graft {
  return {
    name,
    dest: `vendor/${name}`,
    source: { url: "https://example.com/repo.git", ref: "main", subdir: "." },
    commit: "0".repeat(40),
    notes: [],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "regraft-manifest-"));
  path = join(root, "regraft.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("manifest", () => {
  it("returns an empty manifest when the file does not exist", async () => {
    const m = await readManifest(path);
    expect(m.version).toBe(1);
    expect(m.grafts).toEqual([]);
  });

  it("round-trips through write and read", async () => {
    const m = upsertGraft(await readManifest(path), graft("foo"));
    await writeManifest(path, m);
    const read = await readManifest(path);
    expect(read.grafts).toHaveLength(1);
    expect(findGraft(read, "foo")?.dest).toBe("vendor/foo");
  });

  it("upsert replaces an existing graft by name", async () => {
    let m = upsertGraft(await readManifest(path), graft("foo"));
    const edited: Graft = { ...graft("foo"), commit: "a".repeat(40) };
    m = upsertGraft(m, edited);
    expect(m.grafts).toHaveLength(1);
    expect(findGraft(m, "foo")?.commit).toBe("a".repeat(40));
  });

  it("writes grafts sorted by name", async () => {
    let m = await readManifest(path);
    m = upsertGraft(m, graft("zebra"));
    m = upsertGraft(m, graft("alpha"));
    await writeManifest(path, m);
    const read = await readManifest(path);
    expect(read.grafts.map((g) => g.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("parseSourceSpec", () => {
  it("parses url, ref, and subdir", () => {
    expect(parseSourceSpec("https://github.com/a/b.git@v2#pkg/x")).toEqual({
      url: "https://github.com/a/b.git",
      ref: "v2",
      subdir: "pkg/x",
    });
  });

  it("defaults ref to HEAD and subdir to '.'", () => {
    expect(parseSourceSpec("https://github.com/a/b.git")).toEqual({
      url: "https://github.com/a/b.git",
      ref: "HEAD",
      subdir: ".",
    });
  });

  it("does not treat the @ in an scp-like URL as a ref", () => {
    expect(parseSourceSpec("git@github.com:a/b.git#sub")).toEqual({
      url: "git@github.com:a/b.git",
      ref: "HEAD",
      subdir: "sub",
    });
  });

  it("parses a ref on an scp-like URL", () => {
    expect(parseSourceSpec("git@github.com:a/b.git@v1")).toEqual({
      url: "git@github.com:a/b.git",
      ref: "v1",
      subdir: ".",
    });
  });

  it("keeps slashes in branch names", () => {
    expect(parseSourceSpec("https://github.com/a/b.git@feature/local-bases#pkg")).toEqual({
      url: "https://github.com/a/b.git",
      ref: "feature/local-bases",
      subdir: "pkg",
    });
  });

  it("does not treat URL userinfo as a ref", () => {
    expect(parseSourceSpec("https://user@github.com/a/b.git")).toEqual({
      url: "https://user@github.com/a/b.git",
      ref: "HEAD",
      subdir: ".",
    });
  });
});
