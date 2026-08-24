import { readFile } from "node:fs/promises";
import {
  defaultConfigPath,
  loadConfig,
  resetConfig,
  setConfigModel,
  setConfigThinking
} from "./config.js";
import {
  abortRun,
  acceptHandoff,
  attachRun,
  findRuns,
  inspectRun,
  prepareHandoff,
  sendRun,
  startRun
} from "./controller.js";
import type { RunAuthority } from "./types.js";

export async function runCli(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  try {
    const value = await dispatch(args);
    if (value !== undefined) print(value, json);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      process.stdout.write(
        `${JSON.stringify({ schema_version: 1, state: "failed", error: message })}\n`
      );
    else process.stderr.write(`regrafter: ${message}\n`);
    return usageError(message) ? 2 : 1;
  }
}

const commands: Readonly<Record<string, (args: readonly string[]) => Promise<unknown>>> = {
  start: startCommand,
  send: sendCommand,
  inspect: inspectCommand,
  list: listCommand,
  attach: attachCommand,
  abort: abortCommand,
  handoff: handoffCommand,
  config: configCommand
};

async function dispatch(args: readonly string[]): Promise<unknown> {
  const command = args[0];
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return undefined;
  }
  if (command === undefined) throw new Error("missing command");
  const handler = commands[command];
  if (handler === undefined) throw new Error(`unknown command: ${command}`);
  return await handler(args.slice(1));
}

async function startCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set(["--repo", "--request-file", "--allow"]));
  requireNoPositionals(parsed);
  const repository = required(parsed, "--repo");
  const authority = parseAuthority(parsed.options.get("--allow"));
  const request = await readTextFile(required(parsed, "--request-file"), "request");
  return await startRun(repository, request, { authority });
}
async function sendCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set(["--decision", "--message-file", "--allow"]));
  if (parsed.positionals.length !== 1) throw new Error("send requires one run id");
  const grant = parseAuthority(parsed.options.get("--allow"));
  const message = await readTextFile(required(parsed, "--message-file"), "message");
  return await sendRun(parsed.positionals[0] ?? "", message, parsed.options.get("--decision"), {
    grant
  });
}
async function inspectCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set());
  if (parsed.positionals.length !== 1) throw new Error("inspect requires one run id");
  return await inspectRun(parsed.positionals[0] ?? "");
}
async function listCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set(["--repo"]));
  requireNoPositionals(parsed);
  return { schema_version: 1, runs: await findRuns(parsed.options.get("--repo")) };
}
async function attachCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set());
  if (parsed.positionals.length !== 1) throw new Error("attach requires one run id");
  return await attachRun(parsed.positionals[0] ?? "");
}
async function abortCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set());
  if (parsed.positionals.length !== 1) throw new Error("abort requires one run id");
  return await abortRun(parsed.positionals[0] ?? "");
}
const handoffUsage =
  "handoff requires prepare <run-id>, or accept <run-id> --evidence <sha256> --actor <id> --reason-file <path>";
async function handoffCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set(["--evidence", "--actor", "--reason-file"]));
  const [action, id, ...rest] = parsed.positionals;
  if (rest.length > 0 || id === undefined) throw new Error(handoffUsage);
  if (action === "prepare") {
    if (parsed.options.size > 0) throw new Error(handoffUsage);
    return await prepareHandoff(id);
  }
  if (action === "accept") {
    const reason = (await readTextFile(required(parsed, "--reason-file"), "reason")).trim();
    return await acceptHandoff(
      id,
      required(parsed, "--evidence"),
      required(parsed, "--actor"),
      reason
    );
  }
  throw new Error(handoffUsage);
}
const configUsage =
  "config requires show, reset, set model <provider/model>, or set thinking <level>";
async function configCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseOptions(args, new Set());
  const [action, field, value, ...rest] = parsed.positionals;
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0] ?? ""}`);
  if (action === "set") return await configSet(field, value);
  if (field !== undefined) throw new Error(configUsage);
  if (action === "show") {
    return { schema_version: 1, path: defaultConfigPath(), config: (await loadConfig()) ?? null };
  }
  if (action === "reset") {
    await resetConfig();
    return { schema_version: 1, path: defaultConfigPath(), config: null };
  }
  throw new Error(configUsage);
}
async function configSet(field: string | undefined, value: string | undefined): Promise<unknown> {
  if (value === undefined) throw new Error(configUsage);
  if (field === "model") {
    return { schema_version: 1, path: defaultConfigPath(), config: await setConfigModel(value) };
  }
  if (field === "thinking") {
    return { schema_version: 1, path: defaultConfigPath(), config: await setConfigThinking(value) };
  }
  throw new Error(configUsage);
}

type Parsed = { positionals: string[]; options: Map<string, string> };
function parseOptions(args: readonly string[], accepted: ReadonlySet<string>): Parsed {
  const parsed: Parsed = { positionals: [], options: new Map() };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (!value.startsWith("--")) {
      parsed.positionals.push(value);
      continue;
    }
    if (!accepted.has(value)) throw new Error(`unknown option: ${value}`);
    if (parsed.options.has(value)) throw new Error(`duplicate option: ${value}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${value} requires a value`);
    parsed.options.set(value, next);
    index += 1;
  }
  return parsed;
}
function parseAuthority(value: string | undefined): RunAuthority {
  const permissions = new Set(value?.split(",").filter(Boolean) ?? []);
  const known = new Set(["commits", "push", "pull-requests"]);
  const unknown = [...permissions].find((permission) => !known.has(permission));
  if (unknown !== undefined) throw new Error(`unknown authority: ${unknown}`);
  return {
    overlay_commits: permissions.has("commits"),
    push: permissions.has("push"),
    pull_requests: permissions.has("pull-requests")
  };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.options.get(name);
  if (value === undefined) throw new Error(`missing required option ${name}`);
  return value;
}
function requireNoPositionals(parsed: Parsed): void {
  if (parsed.positionals.length > 0)
    throw new Error(`unexpected argument: ${parsed.positionals[0] ?? ""}`);
}
async function readTextFile(path: string, label: string): Promise<string> {
  const value = await readFile(path, "utf8");
  if (value.trim() === "") throw new Error(`${label} file must not be empty`);
  return value;
}
function print(value: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, json ? undefined : 2)}\n`);
}
function usageError(message: string): boolean {
  return /^(missing|unknown|duplicate|unexpected|start |send |inspect |attach |abort |handoff |config |--)/u.test(
    message
  );
}
function usage(): string {
  return `Usage:\n  regrafter start --repo <path> --request-file <file> [--allow commits,push,pull-requests] [--json]\n  regrafter send <run-id> [--decision <id>] --message-file <file> [--allow commits,push,pull-requests] [--json]\n  regrafter inspect <run-id> [--json]\n  regrafter list [--repo <path>] [--json]\n  regrafter attach <run-id>\n  regrafter abort <run-id> [--json]\n  regrafter handoff prepare <run-id> [--json]\n  regrafter handoff accept <run-id> --evidence <sha256> --actor <id> --reason-file <path> [--json]\n  regrafter config show [--json]\n  regrafter config set model <provider/model> [--json]\n  regrafter config set thinking <level> [--json]\n  regrafter config reset [--json]\n`;
}
