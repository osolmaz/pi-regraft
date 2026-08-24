import { join } from "node:path";
import { findLocalBaseCommit } from "../git.js";
import { findGraft, MANIFEST_FILE, readManifest, type Manifest } from "../manifest.js";
import { firstParentCommits } from "./git.js";
import type { AgentReport, GraftBaselineEntry, RepositorySnapshot, RunRecord } from "./types.js";

export async function completionProblems(
  run: RunRecord,
  report: AgentReport,
  observed: RepositorySnapshot
): Promise<string[]> {
  if (report.state !== "completed") return [];
  const basic = basicProblems(report, observed);
  const history = await historyProblems(run, report, observed).catch((error: unknown) => [
    `could not validate completion history: ${errorMessage(error)}`
  ]);
  const grafts = await updatedGraftProblems(run, report).catch((error: unknown) => [
    `could not validate updated grafts: ${errorMessage(error)}`
  ]);
  return [...basic, ...history, ...grafts];
}

function basicProblems(report: AgentReport, observed: RepositorySnapshot): string[] {
  const problems: string[] = [];
  if (observed.dirty_paths.length > 0) {
    problems.push(`worktree is dirty: ${observed.dirty_paths.join(", ")}`);
  }
  if (report.checks.some((check) => check.outcome === "failed")) {
    problems.push("report contains a failed check");
  }
  return problems;
}

async function historyProblems(
  run: RunRecord,
  report: AgentReport,
  observed: RepositorySnapshot
): Promise<string[]> {
  const actual = await firstParentCommits(run.repository, run.starting.head, observed.head);
  const reported = report.commits.map((commit) => commit.sha);
  const problems: string[] = [];
  if (run.starting.head !== observed.head && actual.length === 0) {
    problems.push("starting HEAD is absent from the final first-parent history");
  }
  if (JSON.stringify(actual) !== JSON.stringify(reported)) {
    problems.push("reported commits do not match the exact first-parent run history");
  }
  return problems;
}

async function updatedGraftProblems(run: RunRecord, report: AgentReport): Promise<string[]> {
  const updatedNames = new Set(report.updated_grafts.map((entry) => entry.graft));
  const duplicates =
    updatedNames.size === report.updated_grafts.length
      ? []
      : ["updated grafts contain duplicate names"];
  const commitScope = report.commits
    .filter((commit) => !updatedNames.has(commit.graft))
    .map((commit) => `commit ${commit.sha} names graft "${commit.graft}" outside updated_grafts`);

  const baseline = run.graft_baseline;
  if (baseline === undefined || baseline.starting_head !== run.starting.head) {
    return [...duplicates, ...commitScope, "run has no valid starting graft baseline"];
  }
  const manifest = await readManifest(join(run.repository, MANIFEST_FILE));
  const manifestScope = manifestScopeProblems(manifest, baseline.grafts, updatedNames);
  const perGraft = await Promise.all(
    report.updated_grafts.map(async (updated) => {
      const starting = baseline.grafts.find((entry) => entry.graft === updated.graft);
      if (starting === undefined) {
        return [`updated graft "${updated.graft}" is absent from the starting baseline`];
      }
      return await oneGraftProblems(run, report, manifest, starting, updated);
    })
  );
  return [...duplicates, ...commitScope, ...manifestScope, ...perGraft.flat()];
}

function manifestScopeProblems(
  manifest: Manifest,
  baseline: readonly GraftBaselineEntry[],
  updatedNames: ReadonlySet<string>
): string[] {
  const baselineNames = new Set(baseline.map((entry) => entry.graft));
  const changedWithoutReport = baseline.flatMap((starting) => {
    const finalGraft = findGraft(manifest, starting.graft);
    const changed =
      finalGraft === undefined ||
      finalGraft.commit !== starting.upstream ||
      finalGraft.dest !== starting.dest;
    return changed && !updatedNames.has(starting.graft)
      ? [`final manifest changes graft "${starting.graft}" outside updated_grafts`]
      : [];
  });
  const added = manifest.grafts
    .filter((graft) => !baselineNames.has(graft.name))
    .map((graft) => `final manifest adds graft "${graft.name}" outside the starting baseline`);
  return [...changedWithoutReport, ...added];
}

async function oneGraftProblems(
  run: RunRecord,
  report: AgentReport,
  manifest: Manifest,
  starting: GraftBaselineEntry,
  updated: AgentReport["updated_grafts"][number]
): Promise<string[]> {
  const revisions = revisionProblems(manifest, starting, updated);
  const commits = await graftCommitProblems(run, report, starting, updated);
  return [...revisions, ...commits];
}

function revisionProblems(
  manifest: Manifest,
  starting: GraftBaselineEntry,
  updated: AgentReport["updated_grafts"][number]
): string[] {
  const problems: string[] = [];
  if (starting.upstream !== updated.old_upstream) {
    problems.push(`updated graft "${updated.graft}" has the wrong old upstream revision`);
  }
  const finalGraft = findGraft(manifest, updated.graft);
  if (
    finalGraft === undefined ||
    finalGraft.commit !== updated.new_upstream ||
    finalGraft.dest !== starting.dest
  ) {
    problems.push(`updated graft "${updated.graft}" does not match the final manifest`);
  }
  return problems;
}

async function graftCommitProblems(
  run: RunRecord,
  report: AgentReport,
  starting: GraftBaselineEntry,
  updated: AgentReport["updated_grafts"][number]
): Promise<string[]> {
  const graftCommits = report.commits
    .map((commit, index) => ({ ...commit, index }))
    .filter((commit) => commit.graft === updated.graft);
  const bases = graftCommits.filter((commit) => commit.kind === "base");
  if (bases.length !== 1) {
    return [`updated graft "${updated.graft}" must report exactly one pristine base commit`];
  }
  const base = bases[0];
  if (base === undefined) return [];
  const overlays = graftCommits.filter((commit) => commit.kind === "overlay");
  const localBase = await findLocalBaseCommit(
    run.repository,
    MANIFEST_FILE,
    updated.graft,
    starting.dest,
    updated.new_upstream
  ).catch(() => undefined);
  const problems = [
    ...overlayAuthorityProblems(run, updated.graft, overlays.length),
    ...(localBase === base.sha ? [] : [basePreservationProblem(updated.graft)])
  ];
  const validOverlays = overlaysInBaseSegment(report, overlays, base.index);
  if (validOverlays.length !== overlays.length) {
    problems.push(`updated graft "${updated.graft}" reports an overlay outside its base segment`);
  }
  if (starting.local_overlay && validOverlays.length === 0) {
    problems.push(`updated graft "${updated.graft}" requires an overlay commit`);
  }
  problems.push(
    ...baseOnlyPositionProblems(
      starting,
      updated.graft,
      validOverlays.length,
      base.index,
      report.commits.length
    )
  );
  return problems;
}

function baseOnlyPositionProblems(
  starting: GraftBaselineEntry,
  graft: string,
  overlayCount: number,
  baseIndex: number,
  commitCount: number
): string[] {
  return !starting.local_overlay && overlayCount === 0 && baseIndex !== commitCount - 1
    ? [`updated graft "${graft}" has a base-only commit that is not the final run commit`]
    : [];
}

function overlayAuthorityProblems(run: RunRecord, graft: string, overlayCount: number): string[] {
  return overlayCount > 0 && !run.authority.overlay_commits
    ? [`updated graft "${graft}" reports an overlay commit without overlay authority`]
    : [];
}

function overlaysInBaseSegment(
  report: AgentReport,
  overlays: Array<AgentReport["commits"][number] & { index: number }>,
  baseIndex: number
): Array<AgentReport["commits"][number] & { index: number }> {
  const nextBase = report.commits.findIndex(
    (commit, index) => index > baseIndex && commit.kind === "base"
  );
  return overlays.filter(
    (overlay) => overlay.index > baseIndex && (nextBase === -1 || overlay.index < nextBase)
  );
}

function basePreservationProblem(graft: string): string {
  return `updated graft "${graft}" did not preserve its reported pristine base`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
