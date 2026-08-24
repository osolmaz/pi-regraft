import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { agentReportSchema } from "./report-schema.js";
import type { AgentReport, ControllerResult, RunRecord } from "./types.js";

export function parseAgentReport(value: unknown): AgentReport {
  if (!Value.Check(agentReportSchema, value)) {
    const first = [...Value.Errors(agentReportSchema, value)][0];
    throw new Error(
      `invalid Regrafter report${first === undefined ? "" : ` at ${first.path}: ${first.message}`}`
    );
  }
  validateDecision(value);
  validateTerminalDetails(value);
  return value;
}

function validateDecision(report: AgentReport): void {
  if (report.state === "needs_decision" && report.decision === undefined) {
    throw new Error("needs_decision report must include decision");
  }
  if (report.state !== "needs_decision" && report.decision !== undefined) {
    throw new Error("decision is only valid for needs_decision");
  }
}

function validateTerminalDetails(report: AgentReport): void {
  if (report.state === "blocked" && report.blocker === undefined) {
    throw new Error("blocked report must include blocker");
  }
  if (report.state === "failed" && report.recovery === undefined) {
    throw new Error("failed report must include recovery");
  }
}

export async function readAgentReport(path: string): Promise<AgentReport> {
  const text = await readFile(path, "utf8");
  return parseAgentReport(JSON.parse(text) as unknown);
}

export function controllerResult(run: RunRecord): ControllerResult {
  if (run.report === undefined || run.session_id === undefined) {
    throw new Error(`run ${run.run_id} has no terminal report`);
  }
  return {
    ...run.report,
    run_id: run.run_id,
    repository: run.repository,
    session_id: run.session_id
  };
}
