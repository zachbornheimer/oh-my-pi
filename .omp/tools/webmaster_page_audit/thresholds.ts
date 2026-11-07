/**
 * The lines every webmaster performance capability reads a metric against: Core Web Vitals and Lighthouse's own.
 * `good` is the line a value meets to be good; `poor` is the line past which it is poor. Timings and layout shift
 * are lower-is-better; the performance score is 0 to 1 and higher-is-better.
 *
 * This is the union of webmaster's `PERFORMANCE_BUDGET` and zwsip's `cwv-thresholds.ts`. When the pinned
 * `@zysys/site-probes` exports `cwvThresholds`, `test/capability/webmaster_shared/thresholds.test.ts` checks this
 * table equals it; until then this file is the table.
 */
export interface Threshold {
  readonly good: number;
  readonly poor: number;
  readonly higherIsBetter: boolean;
}

const lowerIsBetter = (good: number, poor: number): Threshold => ({ good, poor, higherIsBetter: false });

export const THRESHOLDS = {
  ttfb_ms: lowerIsBetter(800, 1800),
  fcp_ms: lowerIsBetter(1800, 3000),
  lcp_ms: lowerIsBetter(2500, 4000),
  inp_ms: lowerIsBetter(200, 500),
  tbt_ms: lowerIsBetter(200, 600),
  si_ms: lowerIsBetter(3400, 5800),
  cls: lowerIsBetter(0.1, 0.25),
  perf_score: { good: 0.9, poor: 0.5, higherIsBetter: true },
} as const satisfies Record<string, Threshold>;

export type ToneMetric = keyof typeof THRESHOLDS;
export const TONE_METRICS = Object.keys(THRESHOLDS) as readonly ToneMetric[];

export const TONES = ["good", "warn", "poor"] as const;
export type Tone = (typeof TONES)[number];

/** Where one measurement falls against its lines. */
export function toneOf(metric: ToneMetric, value: number): Tone {
  const { good, poor, higherIsBetter }: Threshold = THRESHOLDS[metric];
  if (higherIsBetter) {
    if (value >= good) return "good";
    return value >= poor ? "warn" : "poor";
  }
  if (value <= good) return "good";
  return value <= poor ? "warn" : "poor";
}
