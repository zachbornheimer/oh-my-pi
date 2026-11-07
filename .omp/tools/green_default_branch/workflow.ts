import { CONCURRENCY, PUSHABLE_PERMISSIONS } from "./constants.js";
import { type Ctx, contextOf, type RepositoryContext } from "./context.js";
import { listUniverse, readListing, readRollup } from "./github.js";
import { mergeCiGreenPrIntoDefaultBranch, readCiGreenPrMergeState } from "./land.js";
import { readRow } from "./ledger.js";
import { decideInclusion, type Exclusion, type Listing } from "./inclusion.js";
import { classifyDefaultBranchCiState, readDefaultBranchCiState } from "./read_state.js";
import { appendRepositoryOutcomeToLedger } from "./record.js";
import { rerunFlakyDefaultBranchJobs } from "./rerun.js";
import type { Outcome } from "./states.js";
import type { Classification, RepoFacts } from "./triage.js";
import { type PullResult, upgradeBotDependencyPrsMissingCheckedLabel } from "./upgrade.js";

export const GREEN_DEFAULT_BRANCH_ID = "green_default_branch";

/** States a one-repository run can end in without the caller having to do anything. */
export const SETTLED_STATES: readonly string[] = ["green", "no-ci", "flaky-rerun", "awaiting-merge"];

/** A classification that only records a state: the outcome is that state, with no work in between. */
function recordedOutcome(classification: Classification, defaultBranch: string | undefined): Outcome {
  if (classification.action !== "record") return { steps: [] };
  return {
    steps: [{
      from: classification.from,
      to: classification.to,
      evidence: classification.evidence,
      basis: classification.basis,
      failingJobs: classification.failingJobs,
      defaultBranch,
    }],
  };
}

/** What one repository's run came to. `exitCode` is 0 only when nothing is left for the caller to do. */
export type RepositoryRun = {
  nameWithOwner: string;
  exitCode: number;
  /** The repository's recorded state, or `excluded` when it was left out. */
  state: string;
  /** The ledger's last event for it, or why it was excluded. */
  evidence: string;
  /** Why a person is needed. Returned to the caller; nothing is posted anywhere. */
  needsHuman?: string;
  /** Why no dependency pull request was looked at. */
  skipped?: string;
  pulls: PullResult[];
};

/**
 * One repository: read its default branch's CI, decide the one action, do it, record it, then upgrade its dependency
 * pull requests if it ended green. A needs-human outcome is returned to the caller, never announced. Inside the run
 * nothing throws for a repository that cannot be read or fixed: that is a recorded state. Only a cancelled run throws.
 */
export async function greenDefaultBranch(ctx: Ctx, input: RepositoryContext): Promise<RepositoryRun> {
  const { host } = ctx;
  ctx.progress(`${input.nameWithOwner}: reading the default branch`);
  const read = await readDefaultBranchCiState(host, input);
  const { context, classification } = await classifyDefaultBranchCiState(host, input, read);
  ctx.progress(`${input.nameWithOwner}: ${classification.action} (${classification.evidence})`);
  const outcome = await outcomeOf(ctx, context, classification, read.facts);
  const { recorded } = await appendRepositoryOutcomeToLedger(host, contextOf(context), outcome);
  const upgrade = await upgradeBotDependencyPrsMissingCheckedLabel(ctx, contextOf(context), recorded);
  return {
    nameWithOwner: input.nameWithOwner,
    exitCode: SETTLED_STATES.includes(recorded.state) ? 0 : 1,
    state: recorded.state,
    evidence: recorded.evidence,
    needsHuman: recorded.needsHuman,
    skipped: upgrade.skipped,
    pulls: upgrade.pulls,
  };
}

async function outcomeOf(
  ctx: Ctx,
  context: RepositoryContext,
  classification: Classification,
  facts: RepoFacts | undefined,
): Promise<Outcome> {
  if (classification.action === "rerun") {
    return (await rerunFlakyDefaultBranchJobs(ctx.host, context, classification)).outcome;
  }
  if (classification.action === "fix") {
    return (await mergeCiGreenPrIntoDefaultBranch(ctx, context, classification)).outcome;
  }
  if (classification.action === "reread") {
    return (await readCiGreenPrMergeState(ctx.host, context, { classification, facts })).outcome;
  }
  return recordedOutcome(classification, context.defaultBranch);
}

/**
 * Greens one repository's default branch by name. An archived or unpushable repository is excluded, not run. A merge an
 * earlier run left awaiting checks is re-read, so green is written only for the squash commit. A dry run classifies and
 * records; it never reruns, fixes, merges or upgrades.
 */
export async function runGreenDefaultBranch(ctx: Ctx, nameWithOwner: string, dryRun = false): Promise<RepositoryRun> {
  const { host } = ctx;
  const listing = await readListing(host, nameWithOwner);
  if (listing !== undefined) {
    if (listing.archived) return excluded(nameWithOwner, "archived");
    if (!(PUSHABLE_PERMISSIONS as readonly string[]).includes(listing.viewerPermission)) {
      return excluded(nameWithOwner, `not pushable (${listing.viewerPermission})`);
    }
  }
  const resumed = (await readRow(host, nameWithOwner))?.state === "awaiting-merge";
  return greenDefaultBranch(ctx, {
    nameWithOwner,
    ...(listing === undefined ? {} : { defaultBranch: listing.defaultBranch }),
    dryRun,
    resumed,
    runId: `rg-${host.now().toISOString()}`,
  });
}

function excluded(nameWithOwner: string, reason: string): RepositoryRun {
  return { nameWithOwner, exitCode: 0, state: "excluded", evidence: reason, pulls: [] };
}

/** Which of the account's pushable repositories to green: every one, or one owner's. */
export type RepositoryFilter = { readonly kind: "all" } | { readonly kind: "owner"; readonly owner: string };

export type SweepResult = {
  exitCode: number;
  /** One `<name>: <state> (<evidence>)` line per repository, then one `<name>: excluded (<reason>)` per exclusion. */
  text: string;
  runs: RepositoryRun[];
  exclusions: Exclusion[];
};

/**
 * Greens every repository the `gh` user can push to, minus the canary, the billing hold, archived and unpushable ones
 * (each listed with its reason), by running `runGreenDefaultBranch` on each, red repositories first, `CONCURRENCY` at a
 * time. Exit 0 only when every included repository ended in a settled state. A needs-human repository is reported in
 * the text and the exit code; nothing is notified or posted. Throws when the repositories cannot be listed.
 */
export async function runGreenRepositories(ctx: Ctx, filter: RepositoryFilter, dryRun = false): Promise<SweepResult> {
  const { host } = ctx;
  const scope = filter.kind === "all" ? "the account" : filter.owner;
  let listings: Listing[];
  try {
    listings = (await listUniverse(host)).repos;
  } catch (error) {
    throw new Error(`listing repositories failed: ${(error as Error).message}`);
  }
  const inclusion = decideInclusion(listings);
  const included = inclusion.included.filter((repo) => inScope(filter, repo.nameWithOwner));
  const exclusions = inclusion.exclusions.filter((item) => inScope(filter, item.nameWithOwner));
  ctx.progress(`${included.length} repositories to green for ${scope}; ordering red first`);
  const ordered = await orderRedFirstByLiveRollup(ctx, included);
  const results = await greenEach(ctx, ordered.map((repo) => repo.nameWithOwner), dryRun);
  const lines = [
    ...(ordered.length === 0 ? [`no pushable repositories to green for ${scope}`] : []),
    ...results.map((result) => result.line),
    ...exclusions.map((item) => `${item.nameWithOwner}: excluded (${item.reason})`),
  ];
  const allSettled = ordered.length > 0 && results.every((result) => result.settled);
  return {
    exitCode: allSettled ? 0 : 1,
    text: lines.join("\n"),
    runs: results.flatMap((result) => (result.run === undefined ? [] : [result.run])),
    exclusions,
  };
}

function inScope(filter: RepositoryFilter, nameWithOwner: string): boolean {
  return filter.kind === "all" || nameWithOwner.split("/")[0]?.toLowerCase() === filter.owner.toLowerCase();
}

type Greened = { line: string; settled: boolean; run?: RepositoryRun };

/** Every repository through `runGreenDefaultBranch`, at most `CONCURRENCY` at once, results in the order given. */
async function greenEach(ctx: Ctx, names: readonly string[], dryRun: boolean): Promise<Greened[]> {
  const results: Greened[] = Array.from<Greened>({ length: names.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, names.length) }, async () => {
    for (let at = next++; at < names.length; at = next++) {
      results[at] = await greenOne(ctx, names[at] as string, dryRun);
    }
  });
  await Promise.all(workers);
  return results;
}

async function greenOne(ctx: Ctx, nameWithOwner: string, dryRun: boolean): Promise<Greened> {
  try {
    const run = await runGreenDefaultBranch(ctx, nameWithOwner, dryRun);
    return {
      line: `${nameWithOwner}: ${run.state} (${oneLine(run.evidence)})`,
      settled: run.exitCode === 0 && (run.state === "excluded" || SETTLED_STATES.includes(run.state)),
      run,
    };
  } catch (error) {
    if (/was cancelled/.test((error as Error).message)) throw error;
    return { line: `${nameWithOwner}: error (${oneLine((error as Error).message)})`, settled: false };
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Puts the repositories whose default-branch rollup is FAILURE or ERROR first, then orders by name. Under the daily
 * agent cap this decides which red repositories get a fix. A rollup that cannot be read counts as not red.
 */
export async function orderRedFirstByLiveRollup<T extends { nameWithOwner: string }>(
  ctx: Ctx,
  repositories: readonly T[],
): Promise<T[]> {
  const ROLLUP_READ_CONCURRENCY = 8;
  const red = new Map<string, boolean>();
  const queue = [...repositories];
  const readers = Array.from({ length: Math.min(ROLLUP_READ_CONCURRENCY, queue.length) }, async () => {
    for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
      red.set(repo.nameWithOwner, await isRed(ctx, repo.nameWithOwner));
    }
  });
  await Promise.all(readers);
  const rank = (repo: T): number => (red.get(repo.nameWithOwner) === true ? 0 : 1);
  return [...repositories].sort((left, right) =>
    rank(left) - rank(right) || left.nameWithOwner.localeCompare(right.nameWithOwner)
  );
}

async function isRed(ctx: Ctx, nameWithOwner: string): Promise<boolean> {
  try {
    const { status, rollup } = await readRollup(ctx.host, nameWithOwner);
    return status === 200 && (rollup === "FAILURE" || rollup === "ERROR");
  } catch (error) {
    if (/was cancelled/.test((error as Error).message)) throw error;
    return false;
  }
}
