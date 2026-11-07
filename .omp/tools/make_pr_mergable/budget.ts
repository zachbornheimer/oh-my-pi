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
