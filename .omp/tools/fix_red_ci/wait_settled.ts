import { SETTLE_BUDGET_MS, SETTLE_POLL_MS } from "./constants.js";
import { headContains } from "./head_contains.js";
import type { GitHubPorts } from "./ports.js";
import { readFacts } from "./read_facts.js";
import { judgePrSettled } from "./settled.js";
import type { Facts, Target, Verdict } from "./types.js";

/** One reading of the pull request's head: its facts and what they mean for the target. */
export interface PrReading {
  readonly facts: Facts;
  readonly verdict: Verdict;
}

/** A reading, and whether the wait for it gave up: a head that did not settle in time is `blocked` with `timedOut` set. */
export type Reading = PrReading & { readonly timedOut?: true };

/** What a wait is told: the target to judge against (default `approved`), and what it has already seen. */
export interface WaitOptions {
  readonly target?: Target;
  /** A reading already taken, so a head that is already settled costs no second read. */
  readonly seen?: PrReading;
  /** An OPEN reading of any unrelated head is `working`; terminal PR states end the wait regardless of head. */
  readonly expectedHead?: string;
}

/** Reads the pull request's current head and judges it against `target`. */
export async function readPr(ports: GitHubPorts, prUrl: string, target: Target): Promise<PrReading> {
  const facts = await readFacts(ports, prUrl);
  return { facts, verdict: judgePrSettled(facts, target) };
}

/**
 * A reading of a head that does not contain `expectedHead` is not the head that was pushed: GitHub served it from before
 * the push. It is `working`, never a verdict about the pushed code. A head a bot committed on top of the push contains
 * it, and is judged as it stands.
 */
async function readExpectedHead(
  ports: GitHubPorts,
  prUrl: string,
  target: Target,
  expectedHead: string | undefined,
): Promise<PrReading> {
  const reading = await readPr(ports, prUrl, target);
  if (expectedHead === undefined || reading.verdict.kind === "merged" || reading.verdict.kind === "closed") {
    return reading;
  }
  if (await headContains(ports, reading.facts.repo, expectedHead, reading.facts.headSha)) return reading;
  const reasons = [`GitHub reports the head as ${reading.facts.headSha}, awaiting the pushed ${expectedHead}`];
  return { ...reading, verdict: { kind: "working", headSha: reading.facts.headSha, reasons } };
}

/**
 * Polls the pull request's current head, every SETTLE_POLL_MS and no faster, until the verdict is no longer `working`
 * or SETTLE_BUDGET_MS has gone, in which case it is `blocked` for not settling, with `timedOut` set.
 */
export async function waitUntilPrHeadSettled(
  ports: GitHubPorts & { progress?: (message: string) => void },
  prUrl: string,
  options: WaitOptions = {},
): Promise<Reading> {
  const target = options.target ?? "approved";
  const deadline = ports.now().getTime() + SETTLE_BUDGET_MS;
  let reading = options.seen ?? await readExpectedHead(ports, prUrl, target, options.expectedHead);
  while (reading.verdict.kind === "working") {
    if (ports.now().getTime() + SETTLE_POLL_MS > deadline) {
      const reasons = [...reading.verdict.reasons, `did not settle within ${SETTLE_BUDGET_MS / 60_000} minutes`];
      return { ...reading, verdict: { ...reading.verdict, kind: "blocked", reasons }, timedOut: true };
    }
    ports.progress?.(`waiting for the head to settle: ${reading.verdict.reasons.join("; ")}`);
    await ports.sleep(SETTLE_POLL_MS);
    reading = await readExpectedHead(ports, prUrl, target, options.expectedHead);
  }
  return reading;
}
