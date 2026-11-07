export const SEVERITIES = ["high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_AREAS = ["seo", "performance", "sitemap", "security", "accessibility", "links", "privacy"] as const;
export type FindingArea = (typeof FINDING_AREAS)[number];

/** One thing wrong (or worth a look) on a page: found by a rule, ranked by a model. */
export interface Finding {
  /** `<area>.<what>`, stable across runs, such as `seo.title_missing`. */
  id: string;
  area: FindingArea;
  severity: Severity;
  evidence: string;
  fix_hint: string;
  /** The judging model's stated confidence (0 to 1) in the severity it gave, when it judged the finding. */
  confidence?: number;
}

export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** Worst severity first; ties keep their order. */
export const bySeverity = (a: Pick<Finding, "severity">, b: Pick<Finding, "severity">): number =>
  severityRank(a.severity) - severityRank(b.severity);
