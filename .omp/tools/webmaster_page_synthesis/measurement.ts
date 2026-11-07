/**
 * What the page probes read from a live URL. A probe that could not measure says so and why; a measurement is never
 * half-filled and a page or quota problem is never an exception.
 */
export interface Unmeasured {
  readonly status: "unmeasured";
  readonly reason: string;
}

export const unmeasured = (reason: string): Unmeasured => ({ status: "unmeasured", reason });

export interface Heading {
  level: number;
  text: string;
}

export interface SeoFactsMeasured {
  status: "measured";
  final_url: string;
  http_status: number;
  title: string;
  meta_description: string;
  canonical: string;
  robots_meta: string;
  x_robots_tag: string;
  headings: Heading[];
  heading_level_skips: number;
  schema_types: string[];
  schema_errors: string[];
  open_graph: string[];
  internal_links: number;
  external_links: number;
}
export type SeoMeasurement = SeoFactsMeasured | Unmeasured;

export const FORM_FACTORS = ["mobile", "desktop"] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

/** The probes that read one page, by the measurement each fills. */
export const PAGE_PROBES = ["seo", "content", "performance", "screenshot"] as const;
export type PageProbe = (typeof PAGE_PROBES)[number];
/** What a page's probes read when the caller names none: the fetch, without the slow speed run. */
export const DEFAULT_PAGE_PROBES: readonly PageProbe[] = ["seo", "content"];

export const PERFORMANCE_SOURCES = ["psi", "lighthouse"] as const;
export type PerformanceSource = (typeof PERFORMANCE_SOURCES)[number];

/** The metrics a Lighthouse opportunity can improve. `TBT` is the lab stand-in for INP. */
export const OPPORTUNITY_IMPACTS = ["TTFB", "FCP", "LCP", "INP", "TBT", "CLS"] as const;
export type OpportunityImpact = (typeof OPPORTUNITY_IMPACTS)[number];

export interface PerformanceOpportunity {
  audit: string;
  title: string;
  description?: string;
  savings_ms?: number;
  savings_bytes?: number;
  impacts: OpportunityImpact[];
}

export interface PerformanceMetrics {
  ttfb_ms: number | null;
  lcp_ms: number | null;
  fcp_ms: number | null;
  inp_ms: number | null;
  si_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  /** 0 to 1. */
  perf_score: number | null;
  weight_bytes: number | null;
  image_count: number | null;
  resource_summary: { type: string; requests: number; transfer_bytes: number }[] | null;
  unused_css_bytes: number | null;
  unused_js_bytes: number | null;
  largest_image: { url: string; transfer_bytes: number } | null;
  render_blocking_count: number | null;
  frameworks: string[];
  third_party: { requests: number; transfer_bytes: number; domains: string[] } | null;
  opportunities: PerformanceOpportunity[];
}

export type PerformanceMeasurement =
  | { status: "measured"; source: PerformanceSource; form_factor: FormFactor; metrics: PerformanceMetrics }
  | Unmeasured;

/** The most characters of the page's visible text a measurement carries. */
export const VISIBLE_TEXT_CAP = 20_000;

export interface ContentFactsMeasured {
  status: "measured";
  final_url: string;
  http_status: number;
  visible_text: string;
  tag_ids: string[];
  fb_pixel: boolean;
  third_party_domains: string[];
  image_count_dom: number;
  images_missing_alt: number;
  generator: string;
}
export type ContentMeasurement = ContentFactsMeasured | Unmeasured;

export type ScreenshotMeasurement =
  | {
    status: "measured";
    final_url: string;
    http_status: number;
    path: string;
    sha256: string;
    format: "png";
    width: number;
    height: number;
    captured_at: string;
  }
  | Unmeasured;

export const AXE_IMPACTS = ["critical", "serious", "moderate", "minor"] as const;
export type AxeImpact = (typeof AXE_IMPACTS)[number];

export interface AccessibilityViolation {
  id: string;
  impact: AxeImpact;
  help: string;
  node_count: number;
}

export type AccessibilityMeasurement =
  | {
    status: "measured";
    final_url: string;
    violations: AccessibilityViolation[];
    by_impact: Record<AxeImpact, number>;
  }
  | Unmeasured;

/** The most internal links whose status one page probe fetches. */
export const LINK_CHECK_CAP = 40;
/** How many of those statuses are fetched at once. */
export const LINKS_AT_ONCE = 6;

export interface BrokenLink {
  url: string;
  status: number;
}

export type LinksMeasurement =
  | { status: "measured"; final_url: string; checked: number; truncated: boolean; broken: BrokenLink[] }
  | Unmeasured;

export const CONSENT_GATES = ["present", "absent"] as const;
export type ConsentGate = (typeof CONSENT_GATES)[number];

export type PrivacyMeasurement =
  | { status: "measured"; final_url: string; tracker_hosts: string[]; consent_gate: ConsentGate }
  | Unmeasured;

export type Measured<T extends { status: string }> = Extract<T, { status: "measured" }>;
