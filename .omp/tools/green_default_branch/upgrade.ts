import { DEPENDENCIES_CHECKED } from "./constants.js";
import { contextOf, type Ctx, type RepositoryContext } from "./context.js";
import { isDependencyBotLogin } from "./dependency_bots.js";
import { type PullFact, readPulls } from "./github.js";
import { readRow } from "./ledger.js";
import { isCancelled, readDefaultBranchCiState } from "./read_state.js";
import type { UpgradeReport, UpgradeVerdict } from "./upgrade_runner.js";

const FAILURE_TEXT_LIMIT = 300;

export type PullResult = {
  url: string;
  verdict: UpgradeVerdict;
  /** The upgrade's reason, or why it was skipped. */
  reason: string;
};

export type UpgradeOutput = RepositoryContext & {
  /** The recorded state that decided whether anything ran. */
  state?: string;
  /** Why no pull request was looked at. */
  skipped?: string;
  /** Why a person is needed, when the repository's outcome ended needs-human. */
  needsHuman?: string;
  pulls: PullResult[];
};

/**
 * Runs `upgrade_dependency` on the repository's open Dependabot and Renovate pull requests that do not yet carry
 * `ai:dependencies-checked`. Only a repository recorded green gets this; a red default branch makes every upgrade
 * pull request red for a reason the upgrade cannot fix. A dry run lists the pull requests and upgrades none.
 */
export async function upgradeBotDependencyPrsMissingCheckedLabel(
  ctx: Ctx,
  input: RepositoryContext,
  recorded?: { state: string; needsHuman?: string },
): Promise<UpgradeOutput> {
  const { host } = ctx;
  const context = contextOf(input);
  try {
    const state = await recordedState(ctx, input, recorded);
    if (state !== "green") {
      return {
        ...context,
        state,
        skipped: `recorded state is ${state}, not green`,
        needsHuman: recorded?.needsHuman,
        pulls: [],
      };
    }
    const pulls = (await readPulls(host, input.nameWithOwner)).filter(
      (pull) => isDependencyBotLogin(pull.authorLogin) && !pull.labels.includes(DEPENDENCIES_CHECKED),
    );
    const results: PullResult[] = [];
    for (const pull of pulls) {
      ctx.progress(`${input.nameWithOwner}: upgrade_dependency on ${pull.url}`);
      results.push(context.dryRun === true ? dryRun(pull) : await upgrade(ctx, pull));
    }
    return { ...context, state, needsHuman: recorded?.needsHuman, pulls: results };
  } catch (error) {
    if (isCancelled(error)) throw error;
    return { ...context, skipped: `upgrade pull requests failed: ${(error as Error).message}`, pulls: [] };
  }
}

async function recordedState(
  ctx: Ctx,
  input: RepositoryContext,
  recorded: { state: string } | undefined,
): Promise<string> {
  if (recorded !== undefined) return recorded.state;
  const row = await readRow(ctx.host, input.nameWithOwner);
  if (row !== undefined) return row.state;
  const read = await readDefaultBranchCiState(ctx.host, input);
  if (read.facts === undefined) return read.failure ?? "unread";
  return read.facts.rollup === "SUCCESS" ? "green" : `rollup ${read.facts.rollup}`;
}

function dryRun(pull: PullFact): PullResult {
  return { url: pull.url, verdict: "skipped", reason: "dry run" };
}

async function upgrade(ctx: Ctx, pull: PullFact): Promise<PullResult> {
  let report: UpgradeReport;
  try {
    report = await ctx.upgrade(pull.url);
  } catch (error) {
    if (isCancelled(error)) throw error;
    const reason = `${(error as Error).message}`.slice(0, FAILURE_TEXT_LIMIT);
    return { url: pull.url, verdict: "needs_work", reason: `upgrade_dependency could not run: ${reason}` };
  }
  if ("error" in report) return { url: pull.url, verdict: "needs_work", reason: report.error };
  const why = report.failed.join("; ").slice(0, FAILURE_TEXT_LIMIT);
  const reason = report.verdict === "needs_work" && why !== ""
    ? `upgrade_dependency verdict needs_work: ${why}`
    : `upgrade_dependency verdict ${report.verdict}`;
  return { url: pull.url, verdict: report.verdict, reason };
}
