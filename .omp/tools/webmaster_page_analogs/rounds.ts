import { plainUrl } from "./page_address.ts";
import { ANALOG_SET_MIN, ANALOG_SETS, type AnalogSet, type RejectedCandidate } from "./schemas.ts";
import type { EarlierRounds, KeptChoice } from "./validate.ts";

/** The extra search rounds a set still short of ANALOG_SET_MIN gets after the first. */
export const FOLLOW_UP_ROUNDS = 2;

export type QueriesBySet = Readonly<Record<AnalogSet, readonly string[]>>;

/** What the search rounds have settled so far: kept analogs, rejected pages, queries tried, addresses considered. */
export interface AnalogPool extends EarlierRounds {
  readonly tried: readonly string[];
  /** The plain address of every page any round found, fetched or not; no later round considers it again. */
  readonly considered: ReadonlySet<string>;
}

export const EMPTY_POOL: AnalogPool = {
  kept: { sameIndustry: [], differentIndustry: [] },
  rejected: [],
  tried: [],
  considered: new Set(),
};

/** One round's outcome: its searches, every address it found, the cumulative kept lists and its own rejections. */
export interface RoundOutcome {
  readonly searched: QueriesBySet;
  readonly found: readonly string[];
  readonly kept: Readonly<Record<AnalogSet, readonly KeptChoice[]>>;
  readonly rejected: readonly RejectedCandidate[];
}

const normalized = (query: string): string => query.toLowerCase().replace(/\s+/g, " ").trim();

/** The sets that kept fewer than ANALOG_SET_MIN analogs. */
export function shortSets(kept: Readonly<Record<AnalogSet, readonly KeptChoice[]>>): AnalogSet[] {
  return ANALOG_SETS.filter((set) => kept[set].length < ANALOG_SET_MIN);
}

/**
 * Each set's proposed searches that no earlier search ran and the other set does not already run, compared without
 * case or spacing, each once, the same-industry set first.
 */
export function untriedBySet(proposed: Partial<QueriesBySet>, tried: readonly string[]): QueriesBySet {
  const seen = new Set(tried.map(normalized));
  const fresh = (queries: readonly string[]) =>
    queries.filter((query) => {
      const key = normalized(query);
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // Object literals evaluate in order, so a query both sets propose stays with sameIndustry.
  return {
    sameIndustry: fresh(proposed.sameIndustry ?? []),
    differentIndustry: fresh(proposed.differentIndustry ?? []),
  };
}

/** The pool after one round: its searches tried, its addresses considered, its kept lists, its rejections appended. */
export function afterRound(pool: AnalogPool, round: RoundOutcome): AnalogPool {
  return {
    tried: [...pool.tried, ...ANALOG_SETS.flatMap((set) => round.searched[set])],
    considered: new Set([...pool.considered, ...round.found.map((address) => plainUrl(address) ?? address)]),
    kept: round.kept,
    rejected: [...pool.rejected, ...round.rejected],
  };
}

const keptLine = ({ choice }: KeptChoice): string =>
  `- ${choice.url} (${choice.organization}): ${choice.observedTitle}`;

/** The analogs earlier rounds kept, set by set, for a later choose step; empty when none were kept. */
export function keptGround(kept: Readonly<Record<AnalogSet, readonly KeptChoice[]>>): string {
  if (ANALOG_SETS.every((set) => kept[set].length === 0)) return "";
  return [
    "## Analogs kept in earlier rounds",
    ...ANALOG_SETS.flatMap((set) => kept[set].map((entry) => `${keptLine(entry)} [${set}]`)),
  ].join("\n");
}

/** What a follow-up question reads about one short set: what it kept, every query tried, every page rejected and why. */
export function followUpGround(set: AnalogSet, pool: AnalogPool): string {
  const listed = (lines: readonly string[]) => lines.length === 0 ? ["none"] : lines;
  return [
    "## Short set",
    `${set}: kept ${pool.kept[set].length} of ${ANALOG_SET_MIN}`,
    "",
    "## Kept in this set",
    ...listed(pool.kept[set].map(keptLine)),
    "",
    "## Queries already searched",
    ...listed(pool.tried.map((query) => `- ${query}`)),
    "",
    "## Pages already rejected",
    ...listed(pool.rejected.map((entry) => `- ${entry.url}: ${entry.reason}`)),
  ].join("\n");
}
