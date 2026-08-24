import { describe, expect, it } from "vitest";
import { controllerResult, parseAgentReport } from "../../src/regrafter/reports.js";
import type { RunRecord } from "../../src/regrafter/types.js";

function base(state: string): Record<string, unknown> {
  return {
    schema_version: 1,
    state,
    summary: "Summary",
    commits: [],
    checks: [],
    updated_grafts: [],
    next: "Next"
  };
}

it("rejects a controller result before a report and session exist", () => {
  const snapshot = { branch: "main", head: "abc", dirty_paths: [] };
  const run: RunRecord = {
    schema_version: 1,
    run_id: "run-11111111111111111111111111111111",
    repository: "/repo",
    git_common_dir: "/repo/.git",
    state: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    starting: snapshot,
    last_observed: snapshot,
    authority: { overlay_commits: false, push: false, pull_requests: false }
  };
  expect(() => controllerResult(run)).toThrow("no terminal report");
});

describe("parseAgentReport", () => {
  it("accepts a valid completion", () => {
    expect(parseAgentReport(base("completed")).state).toBe("completed");
  });
  it("rejects unknown fields and unsupported schema versions", () => {
    expect(() => parseAgentReport({ ...base("completed"), extra: true })).toThrow(
      "invalid Regrafter report"
    );
    expect(() => parseAgentReport({ ...base("completed"), schema_version: 2 })).toThrow(
      "invalid Regrafter report"
    );
  });
  it("requires state-specific fields", () => {
    expect(() => parseAgentReport(base("needs_decision"))).toThrow("must include decision");
    expect(() => parseAgentReport(base("blocked"))).toThrow("must include blocker");
    expect(() => parseAgentReport(base("failed"))).toThrow("must include recovery");
  });
  it("rejects a decision on a non-decision state", () => {
    const value = {
      ...base("completed"),
      decision: {
        id: "decision-1",
        graft: "goal",
        question: "Which behavior?",
        context: "Both work.",
        options: [
          { id: "one", label: "One", effect: "First", files: [], reversible: true },
          { id: "two", label: "Two", effect: "Second", files: [], reversible: true }
        ],
        evidence: [],
        repository: { branch: "main", head: "abc", dirty_paths: [] }
      }
    };
    expect(() => parseAgentReport(value)).toThrow("only valid");
  });

  it("leaves failed completion checks for controller validation", () => {
    const value = {
      ...base("completed"),
      checks: [{ command: "npm test", scope: "repo", outcome: "failed", exit_code: 1 }]
    };
    expect(parseAgentReport(value).state).toBe("completed");
  });
});
