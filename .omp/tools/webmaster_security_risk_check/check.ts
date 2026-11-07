/**
 * What every security check shares: the finding it reports and the verdict it answers. Plumbing only. Port of Mastra's
 * `webmaster/finding.ts` and `webmaster/security/check.ts`.
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
