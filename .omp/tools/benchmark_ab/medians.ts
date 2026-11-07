/**
 * The pure core of the benchmark: one arm's median and the candidate-vs-floor comparison.
 * No clocks, no processes; the tests are exact.
 */

/** The median: the middle duration for an odd count, the mean of the two middle ones for an even count. */
export function median(durations: readonly number[]): number {
  if (durations.length === 0) throw new Error("median of no durations");
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface Medians {
  readonly floorMs: number;
  readonly candidateMs: number;
  readonly deltaMs: number;
  readonly ratio: number | null;
  readonly excess: string;
}

/** The candidate-vs-floor comparison: per-arm medians, the delta, the ratio (null over a 0 ms floor) and the excess. */
export function medianComparison(floorDurations: readonly number[], candidateDurations: readonly number[]): Medians {
  const floorMs = median(floorDurations);
  const candidateMs = median(candidateDurations);
  const deltaMs = candidateMs - floorMs;
  const ratio = floorMs > 0 ? candidateMs / floorMs : null;
  return { floorMs, candidateMs, deltaMs, ratio, excess: excessSentence(floorMs, deltaMs, ratio) };
}

/** The reported format: milliseconds to 3 decimals, percentages to 1. */
const MS_DECIMALS = 3;
const PERCENT_DECIMALS = 1;

function ms(value: number): string {
  return value.toFixed(MS_DECIMALS);
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(PERCENT_DECIMALS)}%`;
}

function excessSentence(floorMs: number, deltaMs: number, ratio: number | null): string {
  if (deltaMs === 0) return "candidate matches the floor median";
  if (deltaMs > 0) {
    const over = ratio === null ? "" : ` (${percent(deltaMs / floorMs)} over it)`;
    return `candidate is ${ms(deltaMs)} ms slower than the floor median${over}`;
  }
  return `candidate is ${ms(-deltaMs)} ms faster than the floor median (${percent(-deltaMs / floorMs)} under it)`;
}
