import { GH_BIN, MERGED_CHECKS_REGISTRATION_MS, MERGED_ROLLUP_BUDGET_MS, POLL_MS } from "./constants.js";
import { contextOf, type Ctx, type RepositoryContext } from "./context.js";
import type { FixResult } from "./fix.js";
import { pushOmpCiFixToCiGreenBranch } from "./fix.js";
import { readMerge, readRollup } from "./github.js";
import type { Host } from "./host.js";
import type { GitHubPorts } from "./pr/ports.js";
import { mergeSettledApprovedPr } from "./pr/merge.js";
import { waitUntilPrHeadSettled } from "./pr/wait_settled.js";
import { defaultBranchOf, isCancelled, readDefaultBranchCiState } from "./read_state.js";
import { greenFromMerge, type Outcome, type OutcomeStep } from "./states.js";
import { type Classification, pullNumber, type RepoFacts } from "./triage.js";

export type LandResult =
  | { kind: "needs-human"; reason: string }
  | { kind: "awaiting-merge"; prUrl: string; number: number; reread: boolean }
  | { kind: "unfixed"; evidence: string }
  | { kind: "green"; evidence: string; headSha: string; mergeCommit: string; rollup: string };

/**
 * Where a pull request landed. Merged is green only when the default branch's head is the squash commit and its
 * fresh rollup is SUCCESS; merged any other way is unfixed. The rollup of a merge that just happened is read again
 * while its checks run (PENDING or EXPECTED, up to MERGED_ROLLUP_BUDGET_MS) or have not registered yet (ABSENT, up to
 * MERGED_CHECKS_REGISTRATION_MS), so a merge is judged on finished checks. A blocked or conflicting pull request
 * needs a person.
 */
export async function readLanded(host: Host, repo: string, number: number): Promise<LandResult> {
  const view = await readMerge(host, repo, number);
  if (view.state !== "MERGED") {
    if (view.mergeStateStatus === "BLOCKED" || view.mergeStateStatus === "DIRTY") {
      return { kind: "needs-human", reason: `merge ${view.mergeStateStatus}` };
    }
    return { kind: "awaiting-merge", prUrl: view.url, number, reread: true };
  }
  const startedMs = host.now().getTime();
  let rollup = await readRollup(host, repo);
  while (stillRunning(rollup.rollup, host.now().getTime() - startedMs)) {
    await host.sleep(POLL_MS);
    rollup = await readRollup(host, repo);
  }
  const evidence = `statusCheckRollup ${rollup.rollup} head ${rollup.headSha} merge ${view.mergeCommit}`;
  if (greenFromMerge(rollup.headSha, view.mergeCommit, rollup.rollup)) {
    return { kind: "green", evidence, headSha: rollup.headSha, mergeCommit: view.mergeCommit, rollup: rollup.rollup };
  }
  return { kind: "unfixed", evidence };
}

function stillRunning(rollup: string, elapsedMs: number): boolean {
  if (rollup === "PENDING" || rollup === "EXPECTED") return elapsedMs < MERGED_ROLLUP_BUDGET_MS;
  return rollup === "ABSENT" && elapsedMs < MERGED_CHECKS_REGISTRATION_MS;
}

/**
 * The ledger writes for a landed pull request. `from` is the state the repository is in. A pull request still
 * waiting writes nothing: the caller already recorded that it is awaiting merge. The agent's time was charged on the
 * `fixing` step, so nothing here carries `elapsedSeconds`.
 */
export function landOutcome(result: LandResult, at: { from: string; prUrl?: string }): Outcome {
  if (result.kind === "green") {
    const basis = {
      kind: "squash-merge-success" as const,
      headSha: result.headSha,
      mergeCommit: result.mergeCommit,
      rollup: result.rollup,
    };
    return {
      steps: [{ from: "awaiting-merge", to: "green", evidence: result.evidence, basis, prUrl: at.prUrl, pid: null }],
    };
  }
  if (result.kind === "unfixed") {
    return { steps: [{ from: at.from, to: "unfixed", evidence: result.evidence, prUrl: at.prUrl, pid: null }] };
  }
  if (result.kind === "needs-human") {
    return { steps: [{ from: at.from, to: "needs-human", evidence: result.reason, pid: null }], human: result.reason };
  }
  return { steps: [] };
}

/**
 * Reads where one repository's `ci-green/` pull request landed: the one a `reread` classification names, else the open
 * one in the facts. Writes nothing; the caller records the outcome.
 */
export async function readCiGreenPrMergeState(
  host: Host,
  input: RepositoryContext,
  source: { classification?: Classification; facts?: RepoFacts },
): Promise<{ context: RepositoryContext; outcome: Outcome }> {
  const context = contextOf(input);
  const target = await pullToRead(host, input, source);
  if (target === undefined) {
    const evidence = "no ci-green pull request to read";
    return { context, outcome: { steps: [{ from: "awaiting-merge", to: "unclassified", evidence }] } };
  }
  try {
    const landed = await readLanded(host, input.nameWithOwner, target.number);
    return { context, outcome: landOutcome(landed, { from: "awaiting-merge", prUrl: target.url }) };
  } catch (error) {
    if (isCancelled(error)) throw error;
    const evidence = `reading ${input.nameWithOwner}#${target.number} failed: ${(error as Error).message}`;
    return { context, outcome: { steps: [{ from: "awaiting-merge", to: "unclassified", evidence }] } };
  }
}

async function pullToRead(
  host: Host,
  input: RepositoryContext,
  source: { classification?: Classification; facts?: RepoFacts },
): Promise<{ number: number; url: string } | undefined> {
  if (source.classification?.action === "reread") {
    const { prUrl, prNumber } = source.classification;
    return { number: prNumber || pullNumber(prUrl), url: prUrl };
  }
  const facts = source.facts ?? (await readDefaultBranchCiState(host, input)).facts;
  return facts?.openPr === undefined ? undefined : { number: facts.openPr.number, url: facts.openPr.url };
}

/**
 * Pushes the fix, then opens the pull request from the pushed `ci-green/` branch into the default branch (or takes the
 * one already open), waits for its head to settle, and squash-merges it when it is settled approved, naming the head
 * SHA it judged. Anything short of that (red checks, an open thread, a refused merge) goes to `ctx.drive`, which fixes
 * and merges it in rounds; only its spent budget records `unfixed`. Green is recorded only from a fresh default-branch
 * rollup on the squash commit. When the fix was not pushed the outcome the push implied is returned unchanged.
 */
export async function mergeCiGreenPrIntoDefaultBranch(
  ctx: Ctx,
  input: RepositoryContext,
  classification: Classification,
  pushed?: { context: RepositoryContext; fix: FixResult; outcome: Outcome },
): Promise<{ context: RepositoryContext; outcome: Outcome }> {
  const { host } = ctx;
  const pushedRun = pushed ?? await pushOmpCiFixToCiGreenBranch(host, input, classification, ctx.progress);
  const context = contextOf(pushedRun.context);
  const { fix } = pushedRun;
  const before = pushedRun.outcome;
  if (fix.kind !== "pushed") return { context, outcome: before };
  const defaultBranch = context.defaultBranch ?? await defaultBranchOf(host, context.nameWithOwner);
  const landed = await openPullRequest(ctx, context.nameWithOwner, defaultBranch, fix.branch);
  const after = await landSteps(host, context.nameWithOwner, landed);
  return { context, outcome: { ...after, steps: [...before.steps, ...after.steps] } };
}

async function landSteps(host: Host, repo: string, landed: LandResult): Promise<Outcome> {
  if (landed.kind !== "awaiting-merge") return landOutcome(landed, { from: "fixing" });
  const waiting: OutcomeStep = {
    from: "fixing",
    to: "awaiting-merge",
    evidence: `pr ${landed.prUrl}`,
    prUrl: landed.prUrl,
    pid: null,
  };
  if (!landed.reread) return { steps: [waiting] };
  const read = await readLanded(host, repo, landed.number);
  if (read.kind === "awaiting-merge") return { steps: [waiting] };
  const rest = landOutcome(read, { from: "fixing" });
  return { ...rest, steps: [waiting, ...rest.steps] };
}

/** The PR number a `gh pr create` printed, from its last line; undefined when that line is not a pull request URL. */
function createdPull(stdout: string): { url: string; number: number } | undefined {
  const url = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  const match = url.match(/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)$/);
  return match?.[1] === undefined ? undefined : { url, number: Number(match[1]) };
}

/**
 * The branch's open pull request into the default branch when it has one (an earlier day's run opened it and the fixer
 * resumed its branch), else a new one. Either way it goes through the same settled-approved gate.
 */
async function openPullRequest(ctx: Ctx, repo: string, defaultBranch: string, branch: string): Promise<LandResult> {
  const { host } = ctx;
  const listed = await host.exec(GH_BIN, [
    "pr",
    "list",
    "--repo",
    repo,
    "--base",
    defaultBranch,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url,number",
  ]);
  if (listed.status !== 0) {
    return { kind: "needs-human", reason: `pr list for ${branch} failed: ${listed.stderr.trim()}` };
  }
  let open: { url: string; number: number } | undefined;
  try {
    open = (JSON.parse(listed.stdout || "[]") as { url: string; number: number }[])[0];
  } catch (error) {
    return { kind: "needs-human", reason: `pr list for ${branch} returned unreadable JSON: ${(error as Error).message}` };
  }
  if (open !== undefined) return mergeWhenSettledApproved(ctx, open.url, open.number);
  ctx.progress(`${repo}: opening a pull request for ${branch}`);
  const created = await host.exec(GH_BIN, [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    defaultBranch,
    "--head",
    branch,
    "--title",
    `ci-green ${branch}`,
    "--body",
    "Fixes the default-branch check. Merged only once it is settled approved. Nothing else is merged.",
  ]);
  if (created.status !== 0) return { kind: "needs-human", reason: `pr create failed: ${created.stderr.trim()}` };
  const pull = createdPull(created.stdout);
  if (pull === undefined) {
    return { kind: "needs-human", reason: `pr create printed no pull request URL: ${created.stdout.trim().slice(0, 200)}` };
  }
  return mergeWhenSettledApproved(ctx, pull.url, pull.number);
}

/** `gh` through the host, so a test's host answers it; a non-zero exit throws with its stderr. */
export function githubPortsOf(host: Host, progress?: (message: string) => void): GitHubPorts & {
  progress?: (message: string) => void;
} {
  return {
    gh: async (args) => {
      const result = await host.exec(GH_BIN, [...args]);
      if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args.slice(0, 2).join(" ")} failed`);
      return result.stdout;
    },
    now: () => host.now(),
    sleep: (ms) => host.sleep(ms),
    progress,
  };
}

/** How much of make_pr_mergable's report the ledger keeps as evidence: its verdict line and the reasons after it. */
const REPORT_EVIDENCE_CAP = 1500;

/**
 * The same gate as `make_pr_mergable`: wait for the pull request's head to settle, judge it, and merge only from
 * settled approved, against the head SHA that was judged. Short of that, `ctx.drive` takes the pull request to merged;
 * a run that ends unmerged is `unfixed`, with its report as the evidence.
 */
async function mergeWhenSettledApproved(ctx: Ctx, url: string, number: number): Promise<LandResult> {
  const ports = githubPortsOf(ctx.host, ctx.progress);
  const { facts, verdict } = await waitUntilPrHeadSettled(ports, url);
  if (verdict.kind === "merged") return { kind: "awaiting-merge", prUrl: url, number, reread: true };
  if (verdict.kind === "closed") return { kind: "unfixed", evidence: verdict.reasons.join("; ") };
  if (verdict.kind === "settled") {
    const merged = await mergeSettledApprovedPr(ports, { facts, verdict, merge: true });
    if (merged.merged) return { kind: "awaiting-merge", prUrl: url, number, reread: true };
  }
  ctx.progress(`${url}: not settled approved; handing it to the make_pr_mergable rounds`);
  const driven = await ctx.drive(url);
  if (driven.exitCode === 0) return { kind: "awaiting-merge", prUrl: url, number, reread: true };
  return { kind: "unfixed", evidence: driven.text.trim().slice(0, REPORT_EVIDENCE_CAP) };
}
