/**
 * What every WordPress security check shares: the finding it reports and the verdict it answers. Port of Mastra's
 * `webmaster/security/check.ts` (plumbing only: each check owns its rule).
 */

export type Severity = "high" | "medium" | "low" | "info";

/** A security finding: what was found, how bad, and the first thing to do about it before any lasting fix. */
export interface SecurityFinding {
  /** Stable across runs, such as `security.wordpress.cron`. */
  id: string;
  area: "security";
  severity: Severity;
  evidence: string;
  /** The first containment step, in words; no tool carries it out. */
  containment: string;
  fix_hint: string;
}

export type CheckStatus = "pass" | "fail" | "unmeasured";

/** What one check answers about one site. */
export interface SecurityCheckResult {
  /** The apex domain the verdict is about. */
  site: string;
  /** The check that answered, such as `webmaster.security.wordpress.cron`. */
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
  return { id, area: "security", severity, evidence, containment, fix_hint: fixHint };
}

/** What a rule decides: the findings (none means pass), or why the data it needs could not be read. */
export type Verdict = readonly SecurityFinding[] | { readonly unmeasured: string };

/** The check's answer for a verdict: `fail` with findings, `pass` with none, `unmeasured` (never pass) without data. */
export function answer(site: string, check: string, verdict: Verdict): SecurityCheckResult {
  if ("unmeasured" in verdict) return { site, check, status: "unmeasured", findings: [], reason: verdict.unmeasured };
  return { site, check, status: verdict.length > 0 ? "fail" : "pass", findings: [...verdict] };
}

/** At most `shown` items in words, naming how many more there are. */
export function listed(items: readonly string[], shown = 10): string {
  return items.slice(0, shown).join(", ") + (items.length > shown ? `, and ${items.length - shown} more` : "");
}

/** The result sentence every check's description carries. */
export const RESULT_RULES =
  "Result `{site, check, status, findings[], reason?}` (also as JSON text): `fail` when a finding stands (each has `id`, `severity`, `evidence`, `containment`, `fix_hint`), `pass` when none does, `unmeasured` with `reason` when the data could not be read; missing data is never a `pass`. An unparsable `site` is refused. It never fixes, deletes, quarantines, rotates or messages anyone.";

/** The result as the tool returns it: JSON text for the model, the same object as details. */
export function resultOf(result: SecurityCheckResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
}
