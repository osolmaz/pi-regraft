import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import type {
  AddCommandResult,
  ErrorCommandResult,
  StatusCommandResult,
  UpdateCommandResult,
} from "../src/cli-results.ts";
import { git } from "../src/git.ts";

let root: string;
let upstream: string;
let project: string;

async function g(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

async function configure(path: string): Promise<void> {
  await g(["config", "user.email", "test@example.com"], path);
  await g(["config", "user.name", "Test User"], path);
}

async function commit(path: string, message: string): Promise<void> {
  await g(["add", "-A"], path);
  await g(["commit", "-q", "-m", message], path);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "regraft-cli-"));
  upstream = join(root, "upstream");
  project = join(root, "project");
  await mkdir(upstream);
  await mkdir(project);
  await g(["init", "-q", "-b", "main"], upstream);
  await g(["init", "-q", "-b", "main"], project);
  await configure(upstream);
  await configure(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("regraft CLI", () => {
  it("prints help without an error", async () => {
    const result = await runCli(["--help"], project);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("regraft update <name>");
    expect(result.stderr).toBe("");
  });

  it("adds and finds grafts from a repository subdirectory", async () => {
    await writeFile(join(upstream, "a.txt"), "one\n");
    await commit(upstream, "v1");
    const nested = join(project, "nested");
    await mkdir(nested);

    const added = await runCli(
      [
        "add",
        `${upstream}@main`,
        "vendor/tool",
        "--note",
        "keep local behavior",
        "--json",
      ],
      nested,
    );
    expect(added.code).toBe(0);
    const addResult = JSON.parse(added.stdout) as AddCommandResult;
    expect(addResult.command).toBe("add");
    expect(addResult.graft.name).toBe("tool");
    expect(addResult.graft.notes).toEqual(["keep local behavior"]);
    expect(addResult.repository).toBe(project);

    const status = await runCli(["status", "--json"], nested);
    const statusResult = JSON.parse(status.stdout) as StatusCommandResult;
    expect(statusResult.grafts).toHaveLength(1);
    expect(statusResult.grafts[0]?.behind).toBe(false);
  });

  it("returns conflicts as a successful needs-resolution result", async () => {
    await writeFile(join(upstream, "config.txt"), "value = 1\n");
    await commit(upstream, "v1");
    expect(
      (await runCli(["add", `${upstream}@main`, "vendor/config"], project))
        .code,
    ).toBe(0);
    await writeFile(join(project, "vendor/config/config.txt"), "value = 2\n");
    await commit(project, "feat: customize config");
    await writeFile(join(upstream, "config.txt"), "value = 3\n");
    await commit(upstream, "v2");

    const update = await runCli(["update", "config", "--json"], project);
    expect(update.code).toBe(0);
    const result = JSON.parse(update.stdout) as UpdateCommandResult;
    expect(result.state).toBe("needs_resolution");
    expect(result.conflicts).toEqual(["config.txt"]);
    expect(result.overlay_pending).toBe(true);
    expect(
      await readFile(join(project, "vendor/config/config.txt"), "utf8"),
    ).toContain("<<<<<<<");
  });

  it("records notes and emits one JSON value", async () => {
    await writeFile(join(upstream, "a.txt"), "one\n");
    await commit(upstream, "v1");
    await runCli(["add", `${upstream}@main`, "vendor/tool"], project);

    const note = await runCli(
      ["note", "tool", "preserve", "telemetry", "removal", "--json"],
      project,
    );
    expect(note.code).toBe(0);
    expect(note.stderr).toBe("");
    expect(note.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(note.stdout).graft.notes).toEqual([
      "preserve telemetry removal",
    ]);
  });

  it("rejects concurrent mutating commands without deleting the existing lock", async () => {
    await writeFile(join(upstream, "a.txt"), "one\n");
    await commit(upstream, "v1");
    const lock = join(project, ".git", "regraft.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), '{"pid":123,"cwd":"/other"}\n');

    const result = await runCli(
      ["add", `${upstream}@main`, "vendor/tool", "--json"],
      project,
    );
    expect(result.code).toBe(1);
    const error = JSON.parse(result.stdout) as ErrorCommandResult;
    expect(error.error.kind).toBe("blocked");
    expect(error.error.message).toContain("pid 123 from /other");
    expect(await readFile(join(lock, "owner.json"), "utf8")).toContain("123");
  });

  it("uses exit code 2 for invalid arguments", async () => {
    const result = await runCli(["update", "--json"], project);
    expect(result.code).toBe(2);
    const error = JSON.parse(result.stdout) as ErrorCommandResult;
    expect(error.error.kind).toBe("usage");
  });

  it("emits JSON for unknown commands when requested", async () => {
    const result = await runCli(["bogus", "--json"], project);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const error = JSON.parse(result.stdout) as ErrorCommandResult;
    expect(error).toMatchObject({
      schema_version: 1,
      command: "unknown",
      state: "error",
      error: { kind: "usage" },
    });
  });
});
