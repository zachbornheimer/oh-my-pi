import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Flight's loop, after `flight/src/pr/snapshot.ts`: rounds are counted per head the reading is keyed by, a round's cost
 * goes on a lifetime ledger per pull request, and a round whose cost is unknown is charged the reserve, never zero.
 * omp reports no price, so every round here is charged the reserve.
 */

const MS_PER_HOUR = 3_600_000;

export interface Budget {
  /** Rounds that may start on one key (a head); a new key starts a fresh count. */
  readonly perKey: number;
  /** Rounds that may start in one run, whatever their keys. */
  readonly rounds: number;
  /** Milliseconds from the first reading to the last round that may start. */
  readonly wallMs: number;
  /** Lifetime USD per owner, persisted across runs. */
  readonly costUsd: number;
  /** Charged for a round whose cost is unknown, and required as headroom before a round starts. */
  readonly reserveUsd: number;
}

/** Flight's numbers (3 attempts per head, $25 per pull request, $2 reserve) plus 20 rounds and 6 hours as backstops. */
export const PR_BUDGET: Budget = { perKey: 3, rounds: 20, wallMs: 6 * MS_PER_HOUR, costUsd: 25, reserveUsd: 2 };

export interface Round {
  readonly key: string;
}

export type Decision = { readonly go: true } | { readonly go: false; readonly spent: string };

/** Whether a round may start on `key`. The first limit reached names itself in `spent`. */
export function nextRound(
  history: readonly Round[],
  key: string,
  charged: number,
  budget: Budget,
  elapsedMs: number,
): Decision {
  const onKey = history.filter((round) => round.key === key).length;
  if (onKey >= budget.perKey) {
    return { go: false, spent: `${onKey} rounds already started on ${key} (limit ${budget.perKey} per key)` };
  }
  if (history.length >= budget.rounds) {
    return { go: false, spent: `${history.length} rounds already started (limit ${budget.rounds})` };
  }
  if (elapsedMs >= budget.wallMs) {
    return { go: false, spent: `${elapsedMs} ms elapsed since the first reading (limit ${budget.wallMs} ms)` };
  }
  if (charged + budget.reserveUsd > budget.costUsd) {
    return {
      go: false,
      spent: `$${charged} charged plus the $${budget.reserveUsd} reserve exceeds the $${budget.costUsd} ceiling`,
    };
  }
  return { go: true };
}

/** What one round costs; a round that made no priced call is charged the reserve. */
export function roundCost(callCosts: readonly (number | null)[], reserveUsd: number): number {
  if (callCosts.length === 0) return reserveUsd;
  const known = callCosts.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  return callCosts.includes(null) ? Math.max(known, reserveUsd) : known;
}

/** Thrown by `work` when no further round can help; `until` reports `impossible` with the message. */
export class StepImpossible extends Error {
  override readonly name = "StepImpossible";
}

/** Lifetime USD per owner, kept where a fresh process reads it. */
export interface SpendLedger {
  spent(owner: string): Promise<number>;
  /** Adds `usd` to the owner's total and returns the new total. */
  charge(owner: string, usd: number): Promise<number>;
}

/** `$CAPABILITY_CACHE_DIR/until/`, else `~/.cache/capability-runtime/until/`: the same file the Mastra twin keeps. */
export function ledgerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CAPABILITY_CACHE_DIR?.trim();
  return configured ? join(configured, "until") : join(homedir(), ".cache", "capability-runtime", "until");
}

/**
 * One JSON file per owner (`{ owner, usd }`), replaced by rename so a reader sees the old total or the new one. Two
 * processes charging the same owner at the same instant can lose one charge; the reserve headroom absorbs one round.
 * Deleting the owner's file resets its lifetime spend.
 */
export function fileLedger(directory: string): SpendLedger {
  const pathOf = (owner: string): string => join(directory, `${encodeURIComponent(owner)}.json`);
  const read = async (owner: string): Promise<number> => {
    let text: string;
    try {
      text = await readFile(pathOf(owner), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const stored = JSON.parse(text) as { usd?: unknown };
    if (typeof stored.usd !== "number" || !Number.isFinite(stored.usd) || stored.usd < 0) {
      throw new Error(`The spend ledger at ${pathOf(owner)} does not hold a USD total`);
    }
    return stored.usd;
  };
  return {
    spent: read,
    charge: async (owner, usd) => {
      const total = (await read(owner)) + usd;
      const path = pathOf(owner);
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${process.pid}.tmp`;
      await writeFile(staging, `${JSON.stringify({ owner, usd: total })}\n`, "utf8");
      await rename(staging, path);
      return total;
    },
  };
}

/** What `judge` says about one reading. `issues` are what the next round works. */
export type Judgement<Issue> =
  | { readonly done: true }
  | { readonly impossible: string }
  | { readonly issues: readonly Issue[] }
  | { readonly waiting: string };

export interface UntilSpec<Reading, Issue = unknown> {
  readonly name: string;
  /** The ledger key, e.g. the pull request URL: lifetime spend is per owner. */
  readonly owner: string;
  /** A fresh reading, every round. */
  readonly observe: () => Promise<Reading>;
  /** The budget key of a reading, e.g. its head SHA. */
  readonly key: (reading: Reading) => string;
  readonly judge: (reading: Reading) => Judgement<Issue>;
  /** One round of work. Throw `StepImpossible` when no round can help. `round` is 1-based within this run. */
  readonly work: (reading: Reading, issues: readonly Issue[], round: number) => Promise<unknown>;
  readonly budget: Budget;
}

export interface UntilDeps {
  readonly ledger: SpendLedger;
  readonly now: () => number;
  /** Waits `ms`; rejects when the run is cancelled. */
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to wait before observing again when the judge says `waiting`. */
  readonly pollMs: number;
}

export interface UntilResult<Reading> {
  readonly status: "done" | "impossible" | "spent";
  /** The last reading taken. */
  readonly reading: Reading;
  /** Why it did not finish `done`: the impossibility, or which limit was spent. Empty when done. */
  readonly reasons: readonly string[];
  /** Rounds started in this run. */
  readonly rounds: number;
}

/**
 * Observe, judge; on issues check the budget and run one round of work, then observe again. `waiting` observes
 * again after `pollMs` without starting a round (the wall limit still ends it). A round's cost is charged to the
 * owner's ledger even when its work throws.
 */
export async function until<Reading, Issue = unknown>(
  spec: UntilSpec<Reading, Issue>,
  deps: UntilDeps,
): Promise<UntilResult<Reading>> {
  const { budget } = spec;
  const history: Round[] = [];
  let startedAt: number | undefined;
  const finish = (
    status: UntilResult<Reading>["status"],
    reading: Reading,
    reasons: readonly string[],
  ): UntilResult<Reading> => ({ status, reading, reasons, rounds: history.length });

  for (;;) {
    const reading = await spec.observe();
    startedAt ??= deps.now();
    const elapsed = deps.now() - startedAt;
    const verdict = spec.judge(reading);

    if ("done" in verdict) return finish("done", reading, []);
    if ("impossible" in verdict) return finish("impossible", reading, [verdict.impossible]);

    if ("waiting" in verdict) {
      if (elapsed >= budget.wallMs) {
        return finish("spent", reading, [
          `${elapsed} ms elapsed since the first reading (limit ${budget.wallMs} ms) while waiting: ${verdict.waiting}`,
        ]);
      }
      await deps.sleep(deps.pollMs);
      continue;
    }

    const key = spec.key(reading);
    const decision = nextRound(history, key, await deps.ledger.spent(spec.owner), budget, elapsed);
    if (!decision.go) return finish("spent", reading, [decision.spent]);

    history.push({ key });
    let failure: unknown;
    try {
      await spec.work(reading, verdict.issues, history.length);
    } catch (error) {
      failure = error;
    }
    await deps.ledger.charge(spec.owner, roundCost([], budget.reserveUsd));
    if (failure instanceof StepImpossible) return finish("impossible", reading, [failure.message]);
    if (failure !== undefined) throw failure;
  }
}
