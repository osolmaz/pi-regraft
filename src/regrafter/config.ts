import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PiAppDefinition } from "@osolmaz/pi-factory";

export type ThinkingLevel = PiAppDefinition["thinking"];

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];

export type RegrafterConfig = {
  readonly version: 1;
  readonly auth: "pi";
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(root, "regrafter", "config.json");
}

export async function loadConfig(
  file: string = defaultConfigPath()
): Promise<RegrafterConfig | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to parse ${file}: ${errorMessage(error)}`, { cause: error });
  }
  return validateConfig(value, file);
}

export function validateConfig(value: unknown, source = "config"): RegrafterConfig {
  if (!isRecord(value)) throw new Error(`${source}: config must be a JSON object`);
  const allowed = new Set(["version", "auth", "model", "thinking"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${source}: unknown field ${unknown.join(", ")}`);
  if (value["version"] !== 1) throw new Error(`${source}: version must be 1`);
  validateAuth(value["auth"], source);
  const model = optionalString(value["model"], `${source}: model`);
  const thinking = optionalString(value["thinking"], `${source}: thinking`);
  return {
    version: 1,
    auth: "pi",
    ...(model === undefined ? {} : { model: validateModel(model, source) }),
    ...(thinking === undefined ? {} : { thinking: validateThinking(thinking, source) })
  };
}

function validateAuth(value: unknown, source: string): void {
  if (value !== undefined && value !== "pi") throw new Error(`${source}: auth must be pi`);
}

export function parseModel(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("model must use provider/model format");
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

export function validateModel(value: string, source = "config"): string {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length > 512) {
    throw new Error(`${source}: invalid model value`);
  }
  try {
    parseModel(trimmed);
  } catch {
    throw new Error(`${source}: model must use provider/model format`);
  }
  return trimmed;
}

export function validateThinking(value: string, source = "config"): ThinkingLevel {
  const level = THINKING_LEVELS.find((entry) => entry === value);
  if (level === undefined) {
    throw new Error(`${source}: thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return level;
}

export async function setConfigModel(
  model: string,
  file: string = defaultConfigPath()
): Promise<RegrafterConfig> {
  const current = (await loadConfig(file)) ?? { version: 1 as const, auth: "pi" as const };
  const next = { ...current, model: validateModel(model, "model") };
  await writeConfig(next, file);
  return next;
}

export async function setConfigThinking(
  thinking: string,
  file: string = defaultConfigPath()
): Promise<RegrafterConfig> {
  const current = (await loadConfig(file)) ?? { version: 1 as const, auth: "pi" as const };
  const next = { ...current, thinking: validateThinking(thinking, "thinking") };
  await writeConfig(next, file);
  return next;
}

export async function resetConfig(file: string = defaultConfigPath()): Promise<void> {
  await rm(file, { force: true });
}

export async function writeConfig(
  config: RegrafterConfig,
  file: string = defaultConfigPath()
): Promise<void> {
  const validated = validateConfig(config);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
