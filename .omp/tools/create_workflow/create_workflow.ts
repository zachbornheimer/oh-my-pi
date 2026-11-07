import { isAbsolute, resolve } from "node:path";
import type { ProposeDeps } from "./context.js";
import { type Duplicate, type Hints, leavesToBuild, plan, type PlannedLeaf, type UnplannedLeaf } from "./leaves.js";
import { optionsFrom, runProposeCapabilities } from "./propose.js";
import type { CallCounts, ProposeCapabilitiesInput, ProposeCapabilitiesOutput } from "./types.js";

/** What the caller gives: propose_capabilities' arguments plus the repo the planned code would go in. */
export interface CreateWorkflowInput extends ProposeCapabilitiesInput {
  /** The repo `implement_code` would build in: absolute, `~/...` or relative to omp's directory. Default: omp's directory. */
  readonly repo?: string;
  /** Plans no more than this many leaves, in run order; the rest stay proposed and unplanned. Absent: all of them. */
  readonly max_leaves?: number;
  readonly hints?: Hints;
}

export interface CreateWorkflowOutput {
  /** propose_capabilities' output, whole: per-source leaves, merged, rejected, usage. */
  readonly proposal: ProposeCapabilitiesOutput;
  /** A name an earlier source proposed again: planned once, at the first source. */
  readonly duplicates: readonly Duplicate[];
  /** One `implement_code` request per planned leaf, in run order; call `implement_code` with each `request`. */
  readonly implement_requests: readonly PlannedLeaf[];
  /** A proposed leaf with no request, and why. */
  readonly unplanned: readonly UnplannedLeaf[];
  /** The directory the requests name. */
  readonly repo: string;
  readonly totals: {
    readonly leaves: number;
    readonly requests: number;
    readonly unplanned: number;
    readonly duplicates: number;
    readonly calls: CallCounts;
  };
}

export interface CreateWorkflowDeps extends ProposeDeps {
  /** The directory a relative `repo` is read from, and the default repo: omp's working directory. */
  readonly workingDirectory: string;
}

function resolveRepo(repo: string | undefined, deps: CreateWorkflowDeps): string {
  const home = deps.machine.homeDirectory;
  const given = repo ?? deps.workingDirectory;
  if (typeof given !== "string" || given.trim() === "") throw new Error("create_workflow: repo must be a non-empty path");
  const expanded = given === "~" ? home : given.startsWith("~/") ? resolve(home, given.slice(2)) : given;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(deps.workingDirectory, expanded);
}

function maxLeavesOf(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`create_workflow: max_leaves must be a whole number >= 1, got ${JSON.stringify(value)}`);
  }
  return value;
}

function hintsOf(hints: Hints | null | undefined): Hints | undefined {
  if (hints === undefined || hints === null) return undefined;
  const near = hints.near ?? undefined;
  const language = hints.language ?? undefined;
  for (const [name, value] of [["near", near], ["language", language]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`create_workflow: hints.${name} must be a non-empty string`);
    }
  }
  if (near === undefined && language === undefined) return undefined;
  return { ...(near === undefined ? {} : { near }), ...(language === undefined ? {} : { language }) };
}

/**
 * Proposes the leaf capabilities in the sources (propose_capabilities over all of them), then turns each kept leaf with
 * pseudocode into the request `implement_code` takes. It builds nothing: a custom tool cannot call another tool, so the
 * build of each leaf is the caller's call to `implement_code`. Every argument is checked, and the repo must exist,
 * before the first model call.
 */
export async function runCreateWorkflow(input: CreateWorkflowInput, deps: CreateWorkflowDeps): Promise<CreateWorkflowOutput> {
  optionsFrom(input);
  const maxLeaves = maxLeavesOf(input.max_leaves);
  const hints = hintsOf(input.hints);
  const repo = resolveRepo(input.repo, deps);
  if (!(await deps.machine.isDirectory(repo))) {
    throw new Error(`create_workflow: repo ${repo} is not an existing directory; pass the repo the code would be built in`);
  }
  const proposal = await runProposeCapabilities(input, deps);
  const { build, beyond, duplicates } = leavesToBuild(proposal.runs, maxLeaves);
  const { planned, unplanned } = plan(build, beyond, repo, hints);
  return {
    proposal,
    duplicates,
    implement_requests: planned,
    unplanned,
    repo,
    totals: {
      leaves: proposal.totals.kept,
      requests: planned.length,
      unplanned: unplanned.length,
      duplicates: duplicates.length,
      calls: proposal.totals.calls,
    },
  };
}
