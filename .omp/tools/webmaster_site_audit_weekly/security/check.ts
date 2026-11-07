/**
 * What every security check shares: the finding it reports, the verdict a rule decides, and the answer returned.
 * Plumbing only: each rules_*.ts owns its rule. Port of Mastra's `webmaster/finding.ts` and `webmaster/security/check.ts`.
 */

export const SEVERITIES = ["high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A security finding: found by a rule, with the first containment step before any lasting fix. */
export interface SecurityFinding {
  /** `<area>.<what>`, stable across runs, such as `security.site.exposed_files`. */
  id: string;
  area: "security";
  severity: Severity;
  evidence: string;
  fix_hint: string;
  /** The first containment step, in words; no tool carries it out. */
  containment: string;
}

export type CheckStatus = "pass" | "fail" | "unmeasured";

/** What one check answers about one site. */
export interface SecurityCheckResult {
  /** The apex domain the verdict is about. */
  site: string;
  /** The check that answered, such as `webmaster.security.site.exposed_files`. */
  check: string;
  /** `fail` when a finding stands; `unmeasured` when the data it reads could not be collected. */
  status: CheckStatus;
  findings: SecurityFinding[];
  /** Why the check is unmeasured. */
  reason?: string;
}

export function securityFinding(
  id: string,
  severity: Severity,
  evidence: string,
  containment: string,
  fixHint: string,
): SecurityFinding {
  return { id, area: "security", severity, evidence, fix_hint: fixHint, containment };
}

/** What a rule decides: the findings (none means pass), or why the data it needs could not be read. */
export type Verdict = readonly SecurityFinding[] | { readonly unmeasured: string };

export const isUnmeasured = (value: unknown): value is { readonly unmeasured: string } =>
  typeof value === "object" && value !== null && "unmeasured" in value;

/** The verdict on data the check could read: `fail` with the findings, or `pass` with none. */
export function judged(site: string, check: string, findings: readonly SecurityFinding[]): SecurityCheckResult {
  return { site, check, status: findings.length > 0 ? "fail" : "pass", findings: [...findings] };
}

/** The check's answer for a verdict. */
export function answer(site: string, check: string, verdict: Verdict): SecurityCheckResult {
  return "unmeasured" in verdict
    ? { site, check, status: "unmeasured", findings: [], reason: verdict.unmeasured }
    : judged(site, check, verdict);
}

export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** Worst severity first; ties keep their order. */
export const bySeverity = (a: Pick<SecurityFinding, "severity">, b: Pick<SecurityFinding, "severity">): number =>
  severityRank(a.severity) - severityRank(b.severity);

/** At most `shown` items in words, naming how many more there are. */
export function listed(items: readonly string[], shown = 10): string {
  return items.slice(0, shown).join(", ") + (items.length > shown ? `, and ${items.length - shown} more` : "");
}

const TRAILING_DOT = /\.$/;
const LEADING_WWW = /^www\./;

const addressOf = (site: string): URL => {
  const text = site.trim();
  try {
    return new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    throw new Error(
      `site must be a domain or an address such as \`example.org\` or \`https://www.example.org/\`; got ${JSON.stringify(site)}`,
    );
  }
};

/** The host a site address names: no scheme, path or port, lower-case, no trailing dot. */
export const hostOf = (site: string): string => addressOf(site).hostname.toLowerCase().replace(TRAILING_DOT, "");

/** The apex domain a site's domain or address names: no scheme, path or leading `www.`. */
export const apexOf = (site: string): string => hostOf(site).replace(LEADING_WWW, "");
