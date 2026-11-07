import type { Finding } from "./finding.ts";
import type { PerformanceMetrics } from "./measurement.ts";
import { THRESHOLDS, type Tone, TONE_METRICS, type ToneMetric, toneOf } from "./thresholds.ts";

/** A page whose transfer weight passes these lines is heavy (webmaster policy, not a Core Web Vitals line). */
export const WEIGHT_WARN_BYTES = 2_500_000;
export const WEIGHT_POOR_BYTES = 5_000_000;

export type Tones = Partial<Record<ToneMetric, Tone>>;

/** The tone of every metric the probe reported; a metric it could not read has no tone. */
export function tonesOf(metrics: PerformanceMetrics): Tones {
  const tones: Tones = {};
  for (const metric of TONE_METRICS) {
    const value = metrics[metric];
    if (value !== null) tones[metric] = toneOf(metric, value);
  }
  return tones;
}

const LABELS: Readonly<Record<ToneMetric, { readonly name: string; readonly fix: string }>> = {
  ttfb_ms: {
    name: "Time to first byte",
    fix: "Cache the page at the edge, trim server work before the first byte, and check the host.",
  },
  fcp_ms: {
    name: "First Contentful Paint",
    fix: "Remove render-blocking CSS and scripts and inline the critical CSS.",
  },
  lcp_ms: {
    name: "Largest Contentful Paint",
    fix: "Serve the hero image sized and preloaded, and cut what blocks it.",
  },
  inp_ms: { name: "Interaction to Next Paint", fix: "Break up long main-thread tasks and defer third-party scripts." },
  tbt_ms: { name: "Total Blocking Time", fix: "Split or defer JavaScript that runs long tasks at load." },
  si_ms: {
    name: "Speed Index",
    fix: "Render above-the-fold content sooner: critical CSS, lighter hero, fewer blocking requests.",
  },
  cls: { name: "Cumulative Layout Shift", fix: "Reserve space for images, embeds and ads with width and height." },
  perf_score: { name: "Performance score", fix: "Work the failing audits above; the score follows them." },
};

const SEVERITY_OF_TONE: Readonly<Record<Exclude<Tone, "good">, Finding["severity"]>> = { warn: "medium", poor: "high" };

const showMetric = (metric: ToneMetric, value: number): string => {
  if (metric === "cls") return value.toFixed(3);
  if (metric === "perf_score") return `${Math.round(value * 100)}/100`;
  return `${Math.round(value)} ms`;
};

const lineOf = (metric: ToneMetric, tone: Exclude<Tone, "good">): string => {
  const { good, poor, higherIsBetter } = THRESHOLDS[metric];
  return higherIsBetter
    ? `${tone === "poor" ? "below" : "under"} ${showMetric(metric, tone === "poor" ? poor : good)}`
    : `over ${showMetric(metric, tone === "poor" ? poor : good)}`;
};

function metricFindings(metrics: PerformanceMetrics, tones: Tones): Finding[] {
  return TONE_METRICS.flatMap((metric) => {
    const tone = tones[metric];
    const value = metrics[metric];
    if (tone === undefined || tone === "good" || value === null) return [];
    const { name, fix } = LABELS[metric];
    return [{
      id: `performance.${metric}`,
      area: "performance" as const,
      severity: SEVERITY_OF_TONE[tone],
      evidence: `${name} is ${showMetric(metric, value)}, ${lineOf(metric, tone)} (${tone}).`,
      fix_hint: fix,
    }];
  });
}

function weightFindings(metrics: PerformanceMetrics): Finding[] {
  const bytes = metrics.weight_bytes;
  if (bytes === null || bytes <= WEIGHT_WARN_BYTES) return [];
  const megabytes = (bytes / 1_000_000).toFixed(1);
  return [{
    id: "performance.page_weight",
    area: "performance",
    severity: bytes > WEIGHT_POOR_BYTES ? "high" : "medium",
    evidence: `The page transfers ${megabytes} MB${
      metrics.image_count === null ? "" : ` with ${metrics.image_count} images`
    }.`,
    fix_hint: "Compress and resize images, serve modern formats, and drop unused scripts.",
  }];
}

/** Every performance finding the tones and the page weight raise. Pure. */
export function performanceFindings(metrics: PerformanceMetrics, tones: Tones): Finding[] {
  return [...metricFindings(metrics, tones), ...weightFindings(metrics)];
}
