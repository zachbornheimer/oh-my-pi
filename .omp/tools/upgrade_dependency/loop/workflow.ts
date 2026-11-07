import { nextRound, PR_BUDGET } from "./budget.js";
import { fixOpenPrIssuesOneCommitEachWithOmp } from "./fix_round.js";
import type { PrPorts } from "./ports.js";
import { pushPrFixRoundToHeadBranch } from "./push_round.js";
import { assess, openIssues } from "./settled.js";
import type { Input, Issue, State, Target } from "./types.js";
import { type Criteria, type PrReading, readPr, type Reading, waitUntilPrHeadSettled } from "./wait_settled.js";

/** This tool settles a pull request for the `mergeable` target and never merges it. */
const TARGET: Target = "mergeable";

const finished = (state: State): boolean => state.status !== "working";

/**
 * What a reading means for the run. Settled (every standard criterion holds and no caller gate failed) is `done`; a
 * head that is still working is waited for; a blocked head that no round can help (closed, no push access with work
 * left, or only a person can act) is `impossible`; a blocked head with issues and budget left is more work — a draft
 * among them: a draft blocks merging, not fixing, and is only `impossible` once nothing is left to fix; and one whose
 * budget is spent is `spent`. A failed gate is an issue like any other. A last round whose push was refused adds that
 * refusal as an issue, so the next round fixes what refused it. The budget is Flight's, from `PR_BUDGET`: rounds that
 * started from this head (a push moves the head and starts that count again), rounds in all, the run's wall clock, and
 * the pull request's lifetime spend on the ledger.
 */
async function concludeReading(ports: PrPorts, state: State, reading: Reading): Promise<State> {
  const { facts, gates, verdict } = reading;
  const failedRounds = state.rounds
    .filter((round) => round.status === "failed")
    .map((round) => `round ${round.number} (${round.role}) failed: ${round.reason}`);
  const reasons = [...verdict.reasons, ...failedRounds];
  const concluded = (status: State["status"], issues: Issue[], why: string[]): State => ({
    ...state,
    status,
    facts,
    gates,
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
  const issues = [...openIssues(facts, state.target, gates), ...refused];
  if (assess(facts, state.target, gates).impossible !== undefined || issues.length === 0) {
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

/** Step 1: read the head once, evaluate the caller's gates on it, and judge both for the target. */
async function observeAndJudgeHead(ports: PrPorts, input: Input): Promise<State> {
  ports.progress("reading the pull request head");
  const reading = await readPr(ports, input.prUrl, { target: TARGET, gates: input.gates });
  const start: State = {
    prUrl: input.prUrl,
    target: TARGET,
    status: "working",
    gates: [],
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

/**
 * Step 2: when the head is blocked with issues and a round is left, omp edits and commits. Never pushes. A round that
 * started an omp run is charged the reserve (omp reports no price), also when it threw; a round that never reached the
 * agent (the host's own base merge, a head that moved, a closed pull request) cost nothing and is not charged.
 */
async function fixOpenIssuesWithOmp(ports: PrPorts, state: State): Promise<State> {
  const { facts, verdict } = state;
  if (finished(state) || facts === undefined || verdict?.kind !== "blocked") return state;
  let agentStarted = false;
  const round: Pick<PrPorts, "checkout" | "git" | "runAgent" | "progress"> = {
    checkout: (prUrl) => ports.checkout(prUrl),
    git: (args, cwd) => ports.git(args, cwd),
    progress: (message) => ports.progress(message),
    runAgent: (input) => {
      agentStarted = true;
      return ports.runAgent(input);
    },
  };
  try {
    const attempt = await fixOpenPrIssuesOneCommitEachWithOmp(round, {
      facts,
      issues: state.issues,
      number: state.rounds.length + 1,
    });
    return { ...state, attempt };
  } finally {
    if (agentStarted) await ports.ledger.charge(state.prUrl, PR_BUDGET.reserveUsd);
  }
}

/** Step 3: the host pushes the round's commits once and waits until GitHub reports the pushed SHA as the head. */
async function pushRoundToHeadBranch(ports: PrPorts, state: State): Promise<State> {
  const { facts, attempt } = state;
  if (facts === undefined || attempt === null) return state;
  const round = await pushPrFixRoundToHeadBranch(ports, { facts, attempt });
  return { ...state, attempt: null, rounds: [...state.rounds, round], stale: true };
}

/**
 * Step 4: after a push, or while the head is still working: poll until reviewers and CI settle, then judge. The caller's
 * gates are read again on every reading, so a push that changed what a gate observes is judged on the new head.
 */
async function waitUntilHeadSettled(ports: PrPorts, state: State, criteria: Criteria): Promise<State> {
  const { facts, verdict } = state;
  if (finished(state)) return state;
  const seen: PrReading | undefined = state.stale || facts === undefined || verdict === undefined
    ? undefined
    : { facts, gates: state.gates, verdict };
  if (!state.stale && verdict?.kind !== "working") {
    return seen === undefined ? state : concludeReading(ports, state, seen);
  }
  const last = state.rounds.at(-1);
  const expectedHead = state.stale && last?.status === "pushed" ? last.toSha ?? undefined : undefined;
  const reading = await waitUntilPrHeadSettled(ports, state.prUrl, { criteria, seen, expectedHead });
  return concludeReading(ports, state, reading);
}

/**
 * Drive one GitHub pull request to `mergeable` with the caller's gates, and stop there: this never merges. A failed
 * gate is worked by the fix round like any other issue, and is judged again on the head the round pushed.
 */
export async function driveToMergeable(ports: PrPorts, input: Input): Promise<State> {
  const criteria: Criteria = { target: TARGET, gates: input.gates };
  let state = await observeAndJudgeHead(ports, input);
  while (!finished(state)) {
    state = await fixOpenIssuesWithOmp(ports, state);
    state = await pushRoundToHeadBranch(ports, state);
    state = await waitUntilHeadSettled(ports, state, criteria);
  }
  return state;
}

/** What the model reads: the status and the reasons first, then the rounds and the head. */
export function stateText(state: State): string {
  const lines = [`${state.prUrl}: ${state.status}`];
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
