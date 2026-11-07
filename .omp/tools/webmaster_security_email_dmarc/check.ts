/**
 * What every check in this tool shares: the finding it reports, the verdict a rule decides, and the answer returned.
 * Plumbing only: each tool's rules.ts owns its rule.
 */

export type Severity = "high" | "medium" | "low" | "info";

/** A security finding: what is wrong, the first step to contain it, and the lasting fix. */
export interface SecurityFinding {
  id: string;
  area: "security";
  severity: Severity;
  evidence: string;
  /** The first containment step, in words; this tool carries nothing out. */
  containment: string;
  fix_hint: string;
}

export type CheckStatus = "pass" | "fail" | "unmeasured";

/** What one check answers about one site. */
export interface SecurityCheckResult {
  /** The apex domain the verdict is about. */
  site: string;
  /** The check that answered, such as `webmaster.security.tls.expiry`. */
  check: string;
  /** `fail` when a finding stands; `unmeasured` when the data it reads could not be collected. */
  status: CheckStatus;
  findings: SecurityFinding[];
  /** Why the check is unmeasured. */
  reason?: string;
}

/** What a rule decides: the findings (none means pass), or why the data it needs could not be read. */
export type Verdict = readonly SecurityFinding[] | { readonly unmeasured: string };

export function securityFinding(
  id: string,
  severity: Severity,
  evidence: string,
  containment: string,
  fixHint: string,
): SecurityFinding {
  return { id, area: "security", severity, evidence, containment, fix_hint: fixHint };
}

export const isUnmeasured = (value: unknown): value is { readonly unmeasured: string } =>
  typeof value === "object" && value !== null && "unmeasured" in value;

/** The check's answer for a verdict. */
export function answer(site: string, check: string, verdict: Verdict): SecurityCheckResult {
  if (isUnmeasured(verdict)) return { site, check, status: "unmeasured", findings: [], reason: verdict.unmeasured };
  return { site, check, status: verdict.length > 0 ? "fail" : "pass", findings: [...verdict] };
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

/** What a check tool returns: the answer as JSON text for the model, and the same answer typed in `details`. */
export interface CheckToolResult {
  content: { type: "text"; text: string }[];
  details: SecurityCheckResult;
}

/** The tool object every check hands to omp: `P` is its parameters, `S` its parameter schema. */
export interface CheckTool<P, S> {
  name: string;
  label: string;
  description: string;
  loadMode: "discoverable";
  /** Nothing on this machine is written or run: DNS and TLS queries only. */
  approval: "read";
  parameters: S;
  execute(
    toolCallId: string,
    params: P,
    onUpdate: ((partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined,
    ctx: unknown,
    signal?: AbortSignal,
  ): Promise<CheckToolResult>;
}

export const toolResult = (result: SecurityCheckResult): CheckToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  details: result,
});
