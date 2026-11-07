import { nextRound, PR_BUDGET } from "./budget.js";
import { fixOneRound } from "./fix_round.js";
import type { PrPorts } from "./ports.js";
import { pushPrFixRoundToHeadBranch } from "./push_round.js";
import { assess, openIssues } from "./settled.js";
import type { Input, Issue, RoundRecord, State } from "./types.js";
import { type PrReading, readPr, type Reading, waitUntilPrHeadSettled } from "./wait_settled.js";

/** The target is always `mergeable`: checks green, no conflict, no open thread or comment. Reviewer criteria are not waited for. */
const TARGET = "mergeable";

const finished = (state: State): boolean => state.status !== "working";

/**
 * What a reading means for the run. Settled is `done`; a head still working is waited for; a blocked head no round can
 * help (closed, no push access with work left, or nothing left to fix) is `impossible`; a blocked head with issues and
 * budget left is more work; and one whose budget is spent is `spent`. A last round whose push was refused adds that
 * refusal as an issue, so the next round fixes what refused it. The budget is `PR_BUDGET`: rounds started from this head,
 * rounds in all, the run's wall clock, and the pull request's lifetime spend on the ledger.
 */
async function concludeReading(ports: PrPorts, state: State, reading: Reading): Promise<State> {
  const { facts, verdict } = reading;
  const failedRounds = state.rounds
    .filter((round) => round.status === "failed")
    .map((round) => `round ${round.number} failed: ${round.reason}`);
  const reasons = [...verdict.reasons, ...failedRounds];
  const concluded = (status: State["status"], issues: Issue[], why: string[]): State => ({
    ...state,
    status,
    facts,
    verdict,
    issues,
    reasons: status === "done" || status === "merged" ? [] : why,
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

/** One round, when the head is blocked with issues and the budget allows: the model's edits, the commit, the one push. Charges the round. */
async function fixAndPush(ports: PrPorts, state: State, input: Input, signal?: AbortSignal): Promise<State> {
  const { facts, verdict } = state;
  if (finished(state) || facts === undefined || verdict?.kind !== "blocked") return state;
  const number = state.rounds.length + 1;
  const earlier = state.summary === "" ? "" : state.summary;
  try {
    const round = await fixOneRound(ports, { facts, check: input.check, issues: state.issues, number, earlier }, signal);
    const summary = round.summary;
    if (round.impossible || round.attempt === null) {
      const record: RoundRecord = {
        number,
        role: "@task",
        status: "failed",
        reason: summary,
        fromSha: facts.headSha,
        toSha: null,
        commits: 0,
        refusal: "",
      };
      return { ...state, status: "impossible", reasons: [summary], summary, rounds: [...state.rounds, record] };
    }
    const record = await pushPrFixRoundToHeadBranch(ports, { facts, attempt: round.attempt });
    const pushedSummary = record.status === "failed" ? `${summary} Not pushed: ${record.reason}` : summary;
    return {
      ...state,
      attempt: null,
      rounds: [...state.rounds, record],
      stale: true,
      summary: pushedSummary,
      changed: record.status === "pushed" ? [...state.changed, ...round.changed] : state.changed,
    };
  } finally {
    // omp reports no price, so the round is charged the reserve; a round that threw is charged too.
    await ports.ledger.charge(state.prUrl, PR_BUDGET.reserveUsd);
  }
}

/** After a push, or while the head is still working: poll until CI settles, then judge. */
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

/** Drive one GitHub pull request's red checks to mergeable with the model's exact-text edits, pushed once per round. Never merges. */
export async function fixRedCi(ports: PrPorts, input: Input, signal?: AbortSignal): Promise<State> {
  ports.progress("reading the pull request head");
  const reading = await readPr(ports, input.prUrl, TARGET);
  let state = await concludeReading(ports, {
    prUrl: input.prUrl,
    target: TARGET,
    status: "working",
    issues: [],
    reasons: [],
    attempt: null,
    rounds: [],
    stale: false,
    startedAt: ports.now().toISOString(),
    headSha: "",
    summary: "",
    changed: [],
  }, reading);
  while (!finished(state)) {
    signal?.throwIfAborted();
    state = await fixAndPush(ports, state, input, signal);
    state = await waitUntilHeadSettled(ports, state);
  }
  return state;
}

export interface FixRedCiOutput {
  summary: string;
  green: boolean;
  changed: string[];
  status: "done" | "impossible" | "spent";
  rounds: number;
  reasons: string[];
}

/** The run's result in the capability's shape. A pull request already merged counts as done: nothing is left to fix. */
export function toOutput(state: State): FixRedCiOutput {
  const green = state.status === "done" || state.status === "merged";
  return {
    summary: green && state.summary === ""
      ? (state.status === "merged" ? "The pull request is already merged." : "The pull request is mergeable.")
      : state.summary,
    green,
    changed: state.changed,
    status: green ? "done" : state.status === "spent" ? "spent" : "impossible",
    rounds: state.rounds.length,
    reasons: state.reasons,
  };
}

/** What the model reads. */
export function outputText(prUrl: string, output: FixRedCiOutput): string {
  const lines = [
    `${prUrl}: ${output.status}${output.green ? " (mergeable)" : ""}, ${output.rounds} round${output.rounds === 1 ? "" : "s"}`,
    `summary: ${output.summary}`,
  ];
  if (output.changed.length > 0) lines.push(`changed: ${output.changed.join(", ")}`);
  for (const reason of output.reasons) lines.push(`  - ${reason}`);
  return lines.join("\n");
}
