import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultConfigPath,
  loadConfig,
  parseModel,
  resetConfig,
  setConfigModel,
  setConfigThinking,
  validateConfig,
  validateThinking,
  writeConfig
} from "../../src/regrafter/config.js";

async function configDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "regrafter-config-"));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("regrafter config", () => {
  it("uses the XDG config home when present", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    expect(defaultConfigPath()).toBe("/tmp/xdg/regrafter/config.json");
  });

  it("returns undefined when the file is missing", async () => {
    const root = await configDir();
    expect(await loadConfig(join(root, "missing.json"))).toBeUndefined();
  });

  it("round-trips a written config", async () => {
    const root = await configDir();
    const file = join(root, "config.json");
    await writeConfig(
      { version: 1, auth: "pi", model: "huggingface/model-a", thinking: "high" },
      file
    );
    expect(await loadConfig(file)).toEqual({
      version: 1,
      auth: "pi",
      model: "huggingface/model-a",
      thinking: "high"
    });
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw["model"]).toBe("huggingface/model-a");
    await rm(root, { recursive: true, force: true });
  });

  it("sets and resets individual fields", async () => {
    const root = await configDir();
    const file = join(root, "config.json");
    expect(await setConfigModel("openai/gpt-5.6", file)).toEqual({
      version: 1,
      auth: "pi",
      model: "openai/gpt-5.6"
    });
    expect(await setConfigThinking("low", file)).toEqual({
      version: 1,
      auth: "pi",
      model: "openai/gpt-5.6",
      thinking: "low"
    });
    await resetConfig(file);
    expect(await loadConfig(file)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects invalid configs", () => {
    expect(() => validateConfig(null)).toThrow("config must be a JSON object");
    expect(() => validateConfig({ version: 2, auth: "pi" })).toThrow("version must be 1");
    expect(() => validateConfig({ version: 1, auth: "custom" })).toThrow("auth must be pi");
    expect(() => validateConfig({ version: 1, extra: true })).toThrow("unknown field extra");
    expect(() => validateConfig({ version: 1, auth: "pi", model: "model-only" })).toThrow(
      "model must use provider/model format"
    );
    expect(() => validateConfig({ version: 1, auth: "pi", thinking: "max" })).toThrow(
      "thinking must be one of"
    );
  });

  it("parses provider/model selections", () => {
    expect(parseModel("huggingface/moonshotai/Kimi-K3:fireworks-ai")).toEqual({
      provider: "huggingface",
      model: "moonshotai/Kimi-K3:fireworks-ai"
    });
    expect(() => parseModel("/model")).toThrow("provider/model");
    expect(() => parseModel("provider/")).toThrow("provider/model");
    expect(validateThinking("xhigh")).toBe("xhigh");
  });

  it("rejects a malformed config file", async () => {
    const root = await configDir();
    const file = join(root, "config.json");
    await writeFile(file, "not json\n");
    await expect(loadConfig(file)).rejects.toThrow("failed to parse");
    await rm(root, { recursive: true, force: true });
  });
});
