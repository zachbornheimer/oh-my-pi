import { nextRound, PR_BUDGET } from "./budget.js";
import { awaitMergedSettledApprovedPr, mergeSettledApprovedPr } from "./merge.js";
import { fixOpenPrIssuesOneCommitEachWithOmp } from "./fix_round.js";
import type { PrPorts } from "./ports.js";
import { pushPrFixRoundToHeadBranch } from "./push_round.js";
import { assess, canPushHead, openIssues } from "./settled.js";
import type { Input, Issue, State } from "./types.js";
import { type PrReading, readPr, type Reading, waitUntilPrHeadSettled } from "./wait_settled.js";

const finished = (state: State): boolean => state.status !== "working" || state.dryRun;

/**
 * What a reading means for the run. Settled is `done`; a head that is still working is waited for; a blocked head that no
 * round can help (closed, no push access with work left, or only a person can act) is `impossible`; a blocked head with
 * issues and budget left is more work — a draft among them: a draft blocks merging, not fixing, and is only
 * `impossible` once nothing is left to fix; and one whose budget is spent is `spent`. A last round whose push was
 * refused adds that refusal as an issue, so the next round fixes what refused it. The budget is Flight's, from
 * `PR_BUDGET`: rounds that started from this head (a push moves the head and starts that count again), rounds in all,
 * the run's wall clock, and the pull request's lifetime spend on the ledger.
 */
async function concludeReading(ports: PrPorts, state: State, reading: Reading): Promise<State> {
  const { facts, verdict } = reading;
  const failedRounds = state.rounds
    .filter((round) => round.status === "failed")
    .map((round) => `round ${round.number} (${round.role}) failed: ${round.reason}`);
  const reasons = [...verdict.reasons, ...failedRounds];
  const concluded = (status: State["status"], issues: Issue[], why: string[]): State => ({
    ...state,
    status,
    facts,
    verdict,
    issues,
    reasons: status === "done" ? [] : why,
    stale: false,
    headSha: facts.headSha,
  });
  if (verdict.kind === "settled") return concluded("done", [], []);
  if (verdict.kind === "merged") return concluded("merged", [], []);
  if (verdict.kind === "closed") return concluded("impossible", [], reasons);
  if (verdict.kind === "working") return concluded("working", [], reasons);
  if (reading.timedOut === true) return concluded("spent", [], reasons);

  const refusal = state.rounds.at(-1)?.refusal ?? "";
  const refused: Issue[] = refusal === "" ? [] : [{ kind: "push-refused", output: refusal }];
  const issues = [...openIssues(facts, state.target), ...refused];
  if (assess(facts, state.target).impossible !== undefined || issues.length === 0) {
    return concluded("impossible", issues, reasons);
  }
  if (state.dryRun) return concluded("working", issues, reasons);
  const spentMs = state.startedAt === "" ? 0 : Date.parse(facts.observedAt) - Date.parse(state.startedAt);
  const decision = nextRound(
    state.rounds.map((round) => ({ key: round.fromSha })),
    facts.headSha,
    await ports.ledger.spent(state.prUrl),
    PR_BUDGET,
    spentMs,
  );
  return decision.go
    ? concluded("working", issues, reasons)
    : concluded("spent", issues, [...reasons, `the run spent its budget: ${decision.spent}`]);
}

/** Step 1: read the head once and judge it for the target; a fork the viewer authored but cannot push to the base of is `mergeable`, unmerged. */
async function observeAndJudgeHead(ports: PrPorts, input: Input): Promise<State> {
  const initialTarget = input.target ?? "approved";
  ports.progress("reading the pull request head");
  let reading = await readPr(ports, input.prUrl, initialTarget);
  const forkAuthorOnly = reading.facts.isCrossRepository && !reading.facts.viewerCanPush && canPushHead(reading.facts);
  const target = input.target ?? (forkAuthorOnly ? "mergeable" : "approved");
  if (target !== initialTarget) reading = await readPr(ports, input.prUrl, target);
  const start: State = {
    prUrl: input.prUrl,
    target,
    merge: forkAuthorOnly ? false : (input.merge ?? false),
    dryRun: input.dryRun ?? false,
    status: "working",
    issues: [],
    reasons: [],
    attempt: null,
    rounds: [],
    stale: false,
    startedAt: ports.now().toISOString(),
    headSha: "",
  };
  return concludeReading(ports, start, reading);
}

/** Step 2: when the head is blocked with issues and a round is left, omp edits and commits. Never pushes. Charges the round. */
async function fixOpenIssuesWithOmp(ports: PrPorts, state: State): Promise<State> {
  const { facts, verdict } = state;
  if (finished(state) || facts === undefined || verdict?.kind !== "blocked") return state;
  try {
    const attempt = await fixOpenPrIssuesOneCommitEachWithOmp(ports, {
      facts,
      issues: state.issues,
      number: state.rounds.length + 1,
    });
    return { ...state, attempt };
  } finally {
    // omp reports no price, so the round is charged the reserve; a round that threw is charged too.
    await ports.ledger.charge(state.prUrl, PR_BUDGET.reserveUsd);
  }
}

/** Step 3: the host pushes the round's commits once and waits until GitHub reports the pushed SHA as the head. */
async function pushRoundToHeadBranch(ports: PrPorts, state: State): Promise<State> {
  const { facts, attempt } = state;
  if (facts === undefined || attempt === null) return state;
  const round = await pushPrFixRoundToHeadBranch(ports, { facts, attempt });
  return { ...state, attempt: null, rounds: [...state.rounds, round], stale: true };
}

/** Step 4: after a push, or while the head is still working: poll until reviewers and CI settle, then judge. */
async function waitUntilHeadSettled(ports: PrPorts, state: State): Promise<State> {
  const { facts, verdict } = state;
  if (finished(state)) return state;
  const seen: PrReading | undefined = state.stale || facts === undefined || verdict === undefined
    ? undefined
    : { facts, verdict };
  if (!state.stale && verdict?.kind !== "working") {
    return seen === undefined ? state : concludeReading(ports, state, seen);
  }
  const last = state.rounds.at(-1);
  const expectedHead = state.stale && last?.status === "pushed" ? last.toSha ?? undefined : undefined;
  const reading = await waitUntilPrHeadSettled(ports, state.prUrl, { target: state.target, seen, expectedHead });
  return concludeReading(ports, state, reading);
}

/** Step 5: squash-merge the judged head, only when merge was asked for, the head is done for the approved target, and the viewer can push. */
async function mergeSettledApprovedHead(ports: PrPorts, state: State): Promise<State> {
  const { facts, verdict } = state;
  if (state.dryRun || state.status !== "done" || facts === undefined || verdict === undefined) return state;
  const result = await mergeSettledApprovedPr(ports, { facts, verdict, merge: state.merge, target: state.target });
  if (result.merged) {
    ports.progress("merge accepted; observing what landed");
    return { ...state, status: "merged" };
  }
  if (result.refused) return { ...state, status: "impossible", reasons: [result.reason] };
  return result.reason === "" ? state : { ...state, reasons: [result.reason] };
}

/** Step 6: observe what the merge landed, because `gh pr merge` exits 0 for a merge-queue enqueue too. */
async function awaitMergedSettledApprovedHead(ports: PrPorts, state: State): Promise<State> {
  if (state.status !== "merged") return state;
  const landed = await awaitMergedSettledApprovedPr(ports, { prUrl: state.prUrl });
  if (landed.state === "merged") return state;
  if (landed.state === "queued") return { ...state, status: "queued", reasons: [...state.reasons, landed.reason] };
  return { ...state, status: "impossible", reasons: [...state.reasons, landed.reason] };
}

/** Drive one GitHub pull request to its settled target, and merge it only from settled approved. */
export async function makePrMergable(ports: PrPorts, input: Input): Promise<State> {
  let state = await observeAndJudgeHead(ports, input);
  while (!finished(state)) {
    state = await fixOpenIssuesWithOmp(ports, state);
    state = await pushRoundToHeadBranch(ports, state);
    state = await waitUntilHeadSettled(ports, state);
  }
  state = await mergeSettledApprovedHead(ports, state);
  return awaitMergedSettledApprovedHead(ports, state);
}

/** What the model reads: the status and the reasons first, then the rounds and the head. */
export function stateText(state: State): string {
  const lines = [
    `${state.prUrl}: ${state.status}${state.dryRun ? " (dry run)" : ""}, target ${state.target}${
      state.merge ? ", merge requested" : ""
    }`,
  ];
  if (state.verdict !== undefined) lines.push(`  verdict ${state.verdict.kind} at ${state.verdict.headSha}`);
  for (const reason of state.reasons) lines.push(`  - ${reason}`);
  if (state.issues.length > 0 && state.status !== "done") lines.push(`  open issues: ${state.issues.length}`);
  for (const round of state.rounds) {
    lines.push(
      `  round ${round.number} (${round.role}): ${round.status}, ${round.commits} commit${round.commits === 1 ? "" : "s"}${
        round.reason === "" ? "" : ` (${round.reason.split("\n")[0]})`
      }`,
    );
  }
  return lines.join("\n");
}
