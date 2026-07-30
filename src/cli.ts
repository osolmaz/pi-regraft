import { join } from "node:path";
import {
  addCommandResult,
  CLI_SCHEMA_VERSION,
  noteCommandResult,
  statusCommandResult,
  updateCommandResult,
  type ErrorCommandResult,
  type RegraftCommandResult,
} from "./cli-results.ts";
import { repositoryRoot } from "./git.ts";
import { MANIFEST_FILE } from "./manifest.ts";
import { addGraft, addNote, status, updateGraft } from "./operations.ts";

export interface CliExecution {
  code: number;
  stdout: string;
  stderr: string;
}

type CommandName = "status" | "add" | "update" | "note";

interface ParsedInvocation {
  command: CommandName;
  args: string[];
  json: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function usage(): string {
  return [
    "regraft - update vendored Git trees while keeping local edits",
    "",
    "usage:",
    "  regraft status [--json]",
    "  regraft add <url>[@ref][#subdir] [dest] [--name <name>] [--note <text>] [--json]",
    "  regraft update <name> [--json]",
    "  regraft note <name> <text> [--json]",
    "",
  ].join("\n");
}

function parseInvocation(argv: string[]): ParsedInvocation {
  if (argv.length === 0) {
    throw new UsageError(usage());
  }
  const command = argv[0];
  if (
    command !== "status" &&
    command !== "add" &&
    command !== "update" &&
    command !== "note"
  ) {
    throw new UsageError(`${usage()}unknown command: ${command ?? ""}`);
  }
  return {
    command,
    args: argv.slice(1).filter((arg) => arg !== "--json"),
    json: argv.includes("--json"),
  };
}

function option(
  args: string[],
  name: string,
): { value?: string; rest: string[] } {
  const index = args.indexOf(name);
  if (index === -1) return { rest: [...args] };
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new UsageError(`${name} requires a value`);
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

async function executeCommand(
  invocation: ParsedInvocation,
  cwd: string,
): Promise<RegraftCommandResult> {
  const repoRoot = await repositoryRoot(cwd);
  const manifestPath = join(repoRoot, MANIFEST_FILE);
  switch (invocation.command) {
    case "status": {
      if (invocation.args.length > 0)
        throw new UsageError("usage: regraft status [--json]");
      return statusCommandResult(repoRoot, await status(manifestPath));
    }
    case "add": {
      const named = option(invocation.args, "--name");
      const noted = option(named.rest, "--note");
      const [spec, dest, ...extra] = noted.rest;
      if (!spec || extra.length > 0) {
        throw new UsageError(
          "usage: regraft add <url>[@ref][#subdir] [dest] [--name <name>] [--note <text>] [--json]",
        );
      }
      return addCommandResult(
        repoRoot,
        await addGraft({
          manifestPath,
          spec,
          ...(dest ? { dest } : {}),
          ...(named.value ? { name: named.value } : {}),
          ...(noted.value ? { note: noted.value } : {}),
        }),
      );
    }
    case "update": {
      const [name, ...extra] = invocation.args;
      if (!name || extra.length > 0) {
        throw new UsageError("usage: regraft update <name> [--json]");
      }
      return updateCommandResult(
        repoRoot,
        await updateGraft(manifestPath, name),
      );
    }
    case "note": {
      const [name, ...words] = invocation.args;
      const text = words.join(" ").trim();
      if (!name || !text)
        throw new UsageError("usage: regraft note <name> <text> [--json]");
      return noteCommandResult(
        repoRoot,
        await addNote(manifestPath, name, text),
      );
    }
  }
}

function isRecoveryFailure(message: string): boolean {
  return (
    message.includes("rollback also failed") ||
    message.includes("could not restore the merged overlay") ||
    message.includes("could not restore")
  );
}

function errorResult(
  command: CommandName | "unknown",
  kind: ErrorCommandResult["error"]["kind"],
  message: string,
): ErrorCommandResult {
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command,
    state: "error",
    error: { kind, message },
  };
}

function humanOutput(result: RegraftCommandResult): string {
  if (result.state === "error") return `${result.error.message}\n`;
  switch (result.command) {
    case "status":
      if (result.grafts.length === 0) return "No grafts are tracked.\n";
      return `${result.grafts
        .map((graft) =>
          graft.behind
            ? `${graft.name}: behind ${graft.current_commit.slice(0, 12)} -> ${graft.latest_commit.slice(0, 12)}`
            : `${graft.name}: up to date at ${graft.current_commit.slice(0, 12)}`,
        )
        .join("\n")}\n`;
    case "add":
      return `Added ${result.graft.name} at ${result.graft.dest}; base ${result.base_commit.slice(0, 12)}.\n`;
    case "update":
      if (result.state === "up_to_date") {
        return `${result.graft.name} is up to date at ${result.new_commit.slice(0, 12)}.\n`;
      }
      return `${result.graft.name} updated to ${result.new_commit.slice(0, 12)} with ${result.conflicts.length} conflict(s); base ${result.new_base_commit?.slice(0, 12) ?? "unknown"}.\n`;
    case "note":
      return `Recorded note for ${result.graft.name} (${result.graft.notes.length} total).\n`;
  }
}

export async function runCli(
  argv: string[],
  cwd = process.cwd(),
): Promise<CliExecution> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { code: 0, stdout: usage(), stderr: "" };
  }
  const requestedJson = argv.includes("--json");
  let invocation: ParsedInvocation | undefined;
  try {
    invocation = parseInvocation(argv);
    const result = await executeCommand(invocation, cwd);
    return {
      code: 0,
      stdout: invocation.json
        ? `${JSON.stringify(result)}\n`
        : humanOutput(result),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const usageFailure = error instanceof UsageError;
    const kind = usageFailure
      ? "usage"
      : isRecoveryFailure(message)
        ? "failed"
        : "blocked";
    const command = invocation?.command ?? "unknown";
    const result = errorResult(command, kind, message);
    return {
      code: usageFailure ? 2 : 1,
      stdout: requestedJson ? `${JSON.stringify(result)}\n` : "",
      stderr: requestedJson
        ? ""
        : message.endsWith("\n")
          ? message
          : `${message}\n`,
    };
  }
}
