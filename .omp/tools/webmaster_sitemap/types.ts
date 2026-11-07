/** The shapes the sitemap check passes between its steps. Port of Mastra's `webmaster/finding.ts`, `webmaster/measurement.ts` and the capability's schemas. */

export const SEVERITIES = ["high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One thing wrong (or worth a look) on a sitemap: found by a rule, ranked by a model. */
export interface Finding {
  /** `sitemap.<what>`, stable across runs. */
  id: string;
  area: "sitemap";
  severity: Severity;
  evidence: string;
  fix_hint: string;
  /** The model's stated confidence that the finding is real, when it judged it. */
  confidence?: number;
}

export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** Worst severity first; ties keep their order. */
export const bySeverity = (a: Pick<Finding, "severity">, b: Pick<Finding, "severity">): number =>
  severityRank(a.severity) - severityRank(b.severity);

/** The most pages of a sitemap whose status is fetched; the rest are judged by their address alone. */
export const SITEMAP_PAGE_CAP = 60;
/** The most addresses of a sitemap a measurement carries. */
export const SITEMAP_URL_CAP = 5000;

export interface SitemapPage {
  /** Address of the sampled page. */
  url: string;
  /** The first response's status, before any redirect; 0 when the page could not be fetched. */
  status: number;
  /** Where a 3xx response points. */
  location?: string;
  /** Whether the page tells search not to index it. */
  noindex: boolean;
  /** The page's rel=canonical address, when it declares one. */
  canonical?: string;
}

export type SitemapMeasurement =
  | {
    status: "measured";
    sitemap_url: string;
    files_read: number;
    /** Every address the sitemap lists, counted before the cap on `urls`. */
    urls_total: number;
    urls: string[];
    pages: SitemapPage[];
  }
  | { status: "unmeasured"; reason: string };

export const LISTING_REASONS = ["noindex", "404", "redirect", "private_pattern", "staging_host", "duplicate_canonical"] as const;
export type ListingReason = (typeof LISTING_REASONS)[number];

export interface ListedUrl {
  url: string;
  reason: ListingReason;
}

export interface StatusCounts {
  "200": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
  unreachable: number;
}

export interface SitemapResult {
  sitemap_url: string;
  urls_total: number;
  /** How many pages had their status fetched; the rest are judged by address alone. */
  urls_checked: number;
  truncated: boolean;
  by_status: StatusCounts;
  should_not_be_listed: ListedUrl[];
  missing_from_sitemap_hint?: number;
  findings: Finding[];
  /** Why the sitemap could not be read; every other field is then empty. */
  unmeasured?: string;
  /** Set when the model step failed: the findings then keep the severity their rule gave. */
  judgment_unavailable?: string;
}
