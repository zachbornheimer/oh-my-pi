import { SETTLE_BUDGET_MS, SETTLE_POLL_MS } from "./constants.js";
import { headContains } from "./head_contains.js";
import type { GitHubPorts } from "./ports.js";
import { readFacts } from "./read_facts.js";
import { judgePrSettled } from "./settled.js";
import type { Facts, Gate, PrGates, Target, Verdict } from "./types.js";

/** One reading of the pull request's head: its facts, the gates as that head left them, and what they mean together. */
export interface PrReading {
  readonly facts: Facts;
  readonly gates: readonly Gate[];
  readonly verdict: Verdict;
}

/** A reading, and whether the wait for it gave up: a head that did not settle in time is `blocked` with `timedOut` set. */
export type Reading = PrReading & { readonly timedOut?: true };

/** What a reading is judged against: the standard criteria of `target`, plus the caller's `gates`. */
export interface Criteria {
  readonly target: Target;
  readonly gates?: PrGates;
}

/** What a wait is told: the criteria to judge against, and what it has already seen. */
export interface WaitOptions {
  readonly criteria: Criteria;
  /** A reading already taken, so a head that is already settled costs no second read. */
  readonly seen?: PrReading;
  /** An OPEN reading of any unrelated head is `working`; terminal PR states end the wait regardless of head. */
  readonly expectedHead?: string;
}

const GATE_VERDICTS: ReadonlySet<string> = new Set(["passed", "failed", "not_proven"]);

/** What a caller's gates said, checked: a gate that answers in a shape this loop cannot read is a bug, never a pass. */
function checkedGates(gates: readonly Gate[]): readonly Gate[] {
  if (!Array.isArray(gates)) throw new Error("gates: expected an array of { name, verdict, observed }");
  gates.forEach((gate, index) => {
    const where = `gates[${index}]`;
    if (typeof gate !== "object" || gate === null) throw new Error(`${where}: expected an object`);
    if (typeof gate.name !== "string" || gate.name === "") throw new Error(`${where}.name: expected a non-empty string`);
    if (!GATE_VERDICTS.has(gate.verdict)) {
      throw new Error(`${where}.verdict: expected passed, failed or not_proven, got ${String(gate.verdict)}`);
    }
    if (typeof gate.observed !== "string") throw new Error(`${where}.observed: expected a string`);
  });
  return gates;
}

/**
 * Judges facts already read. The caller's gates are evaluated here, on this head, every time: a gate may have side
 * effects (a lockfile rewrite), so a pull request that is no longer open evaluates none, since nothing may be done to
 * it. A gate that throws propagates: the reading failed, and a failed reading is never a pass.
 */
async function judgeReading(facts: Facts, criteria: Criteria): Promise<PrReading> {
  const gates = facts.state !== "OPEN" || criteria.gates === undefined ? [] : checkedGates(await criteria.gates(facts));
  return { facts, gates, verdict: judgePrSettled(facts, criteria.target, gates) };
}

/** Reads the pull request's current head, evaluates the caller's gates on it, and judges both against the target. */
export async function readPr(ports: GitHubPorts, prUrl: string, criteria: Criteria): Promise<PrReading> {
  return judgeReading(await readFacts(ports, prUrl), criteria);
}

/**
 * A reading of a head that does not contain `expectedHead` is not the head that was pushed: GitHub served it from before
 * the push. It is `working`, never a verdict about the pushed code, and no gate runs on it (a gate judges the pushed
 * head, and may act on it). A head a bot committed on top of the push contains it, and is judged as it stands.
 */
async function readExpectedHead(
  ports: GitHubPorts,
  prUrl: string,
  criteria: Criteria,
  expectedHead: string | undefined,
): Promise<PrReading> {
  const facts = await readFacts(ports, prUrl);
  if (
    expectedHead !== undefined && facts.state === "OPEN"
    && !await headContains(ports, facts.repo, expectedHead, facts.headSha)
  ) {
    const reasons = [`GitHub reports the head as ${facts.headSha}, awaiting the pushed ${expectedHead}`];
    return { facts, gates: [], verdict: { kind: "working", headSha: facts.headSha, reasons } };
  }
  return judgeReading(facts, criteria);
}

/**
 * Polls the pull request's current head, every SETTLE_POLL_MS and no faster, until the verdict is no longer `working`
 * or SETTLE_BUDGET_MS has gone, in which case it is `blocked` for not settling, with `timedOut` set. The caller's gates
 * are evaluated on every reading of the expected head, so a gate that only turns true once CI or a bot has caught up
 * is seen when it does.
 */
export async function waitUntilPrHeadSettled(
  ports: GitHubPorts & { progress?: (message: string) => void },
  prUrl: string,
  options: WaitOptions,
): Promise<Reading> {
  const deadline = ports.now().getTime() + SETTLE_BUDGET_MS;
  let reading = options.seen ?? await readExpectedHead(ports, prUrl, options.criteria, options.expectedHead);
  while (reading.verdict.kind === "working") {
    if (ports.now().getTime() + SETTLE_POLL_MS > deadline) {
      const reasons = [...reading.verdict.reasons, `did not settle within ${SETTLE_BUDGET_MS / 60_000} minutes`];
      return { ...reading, verdict: { ...reading.verdict, kind: "blocked", reasons }, timedOut: true };
    }
    ports.progress?.(`waiting for the head to settle: ${reading.verdict.reasons.join("; ")}`);
    await ports.sleep(SETTLE_POLL_MS);
    reading = await readExpectedHead(ports, prUrl, options.criteria, options.expectedHead);
  }
  return reading;
}
