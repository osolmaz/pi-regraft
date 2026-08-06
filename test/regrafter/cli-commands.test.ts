import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({
  startRun: vi.fn(),
  sendRun: vi.fn(),
  inspectRun: vi.fn(),
  findRuns: vi.fn(),
  attachRun: vi.fn(),
  abortRun: vi.fn()
}));
vi.mock("../../src/regrafter/controller.js", () => controller);
const { runCli } = await import("../../src/regrafter/cli.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const mock of Object.values(controller)) mock.mockResolvedValue({ state: "completed" });
});

it("dispatches every controller command", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-cli-"));
  const request = join(root, "request.txt");
  await writeFile(request, "Update.\n");
  expect(
    await runCli([
      "start",
      "--repo",
      "/repo",
      "--request-file",
      request,
      "--allow",
      "commits,push",
      "--json"
    ])
  ).toBe(0);
  expect(
    await runCli([
      "send",
      "run-1",
      "--decision",
      "decision-1",
      "--message-file",
      request,
      "--allow",
      "pull-requests"
    ])
  ).toBe(0);
  expect(await runCli(["inspect", "run-1"])).toBe(0);
  expect(await runCli(["list", "--repo", "/repo"])).toBe(0);
  expect(await runCli(["attach", "run-1"])).toBe(0);
  expect(await runCli(["abort", "run-1"])).toBe(0);
  expect(controller.startRun).toHaveBeenCalledWith("/repo", "Update.\n", {
    authority: { overlay_commits: true, push: true, pull_requests: false }
  });
  expect(controller.sendRun).toHaveBeenCalledWith("run-1", "Update.\n", "decision-1", {
    grant: { overlay_commits: false, push: false, pull_requests: true }
  });
});

it("rejects missing, duplicate, and unexpected arguments", async () => {
  expect(await runCli([])).toBe(2);
  expect(await runCli(["start"])).toBe(2);
  expect(
    await runCli(["start", "--repo", "/repo", "--request-file", "file", "--allow", "merge"])
  ).toBe(2);
  expect(await runCli(["list", "extra"])).toBe(2);
  expect(await runCli(["list", "--repo", "a", "--repo", "b"])).toBe(2);
  expect(await runCli(["list", "--repo", "--other"])).toBe(2);
  expect(await runCli(["send", "run-1", "--message-file"])).toBe(2);
  expect(await runCli(["send", "--message-file", "file"])).toBe(2);
  expect(await runCli(["inspect", "one", "two"])).toBe(2);
  expect(await runCli(["attach"])).toBe(2);
  expect(await runCli(["abort", "one", "two"])).toBe(2);
});

it("normalizes non-Error controller failures", async () => {
  const errorWrite = vi.spyOn(process.stderr, "write");
  controller.inspectRun.mockRejectedValueOnce("plain failure");
  expect(await runCli(["inspect", "run-1"])).toBe(1);
  expect(errorWrite.mock.calls[0]?.[0]).toBe("regrafter: plain failure\n");
});

it("rejects an empty request file", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-cli-"));
  const request = join(root, "empty.txt");
  await writeFile(request, " \n");
  expect(await runCli(["start", "--repo", "/repo", "--request-file", request])).toBe(1);
});

it("manages the model config through the config command", async () => {
  const root = await mkdtemp(join(tmpdir(), "regrafter-cli-config-"));
  vi.stubEnv("XDG_CONFIG_HOME", root);
  try {
    const configPath = join(root, "regrafter", "config.json");
    expect(
      await runCli(["config", "set", "model", "huggingface/moonshotai/Kimi-K3:fireworks-ai"])
    ).toBe(0);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      auth: "pi",
      model: "huggingface/moonshotai/Kimi-K3:fireworks-ai"
    });
    expect(await runCli(["config", "set", "thinking", "high"])).toBe(0);
    expect(await runCli(["config", "show"])).toBe(0);
    expect(await runCli(["config", "reset"])).toBe(0);
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
    expect(await runCli(["config", "set", "model", "model-only"])).toBe(1);
    expect(await runCli(["config", "set", "thinking", "max"])).toBe(1);
    expect(await runCli(["config", "unknown"])).toBe(2);
  } finally {
    vi.unstubAllEnvs();
  }
});
