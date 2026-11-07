import { type GhsecSource, isSeverity, SEVERITIES, type Severity, UNREADABLE_SEVERITY } from "./constants.js";

/** Every GitHub alert carries these; everything else the sources read is per source. */
export type RawAlert = { number: number; state: string; html_url: string; [field: string]: unknown };

/** Parses one raw entry of an alert listing; undefined when it lacks a positive integer number, a state or an html_url. */
export function parseRawAlert(value: unknown): RawAlert | undefined {
  const raw = objectOf(value);
  if (raw === undefined) return undefined;
  const { number, state, html_url: url } = raw;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined;
  if (typeof state !== "string" || typeof url !== "string") return undefined;
  return raw as RawAlert;
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

const severityIn = (value: unknown): Severity | undefined => {
  const text = textOf(value).toLowerCase();
  return isSeverity(text) ? text : undefined;
};

/** How a code-scanning `rule.severity` reads when the rule carries no `security_severity_level`. */
const RULE_SEVERITY: Record<string, Severity> = { error: "high", warning: "medium", note: "low" };

/** One source of GitHub security alerts: where it is read, what counts, and what its text says. */
export type SourceSpec = {
  /** The `gh api` path under `repos/<owner>/<repo>` that lists this source's alerts. */
  listPath: string;
  /** Whether one entry of the list is a security item at all: a plain Dependabot version-bump alert is not. */
  isSecurityAlert(raw: RawAlert): boolean;
  severityOf(raw: RawAlert): Severity;
  /** The short imperative outcome the ticket title carries, from the alert's own text. */
  outcomeOf(raw: RawAlert): string;
  /** The alert's own text for the ticket body's detail section. */
  detailOf(raw: RawAlert): string;
};

export const SOURCES: Record<GhsecSource, SourceSpec> = {
  dependabot: {
    listPath: "dependabot/alerts",
    isSecurityAlert: (raw) => objectOf(raw.security_advisory) !== undefined,
    severityOf: (raw) => severityIn(objectOf(raw.security_advisory)?.severity) ?? UNREADABLE_SEVERITY,
    outcomeOf: (raw) => {
      const name = textOf(objectOf(objectOf(raw.dependency)?.package)?.name);
      const summary = textOf(objectOf(raw.security_advisory)?.summary);
      const what = name === "" ? summary : `Upgrade ${name}: ${summary}`;
      return what.trim() === "" ? "Clear the Dependabot security alert" : what;
    },
    detailOf: (raw) => {
      const advisory = objectOf(raw.security_advisory);
      const description = textOf(advisory?.description);
      return description !== "" ? description : textOf(advisory?.summary);
    },
  },
  "code-scanning": {
    listPath: "code-scanning/alerts",
    isSecurityAlert: () => true,
    severityOf: (raw) =>
      severityIn(objectOf(raw.rule)?.security_severity_level)
      ?? RULE_SEVERITY[textOf(objectOf(raw.rule)?.severity).toLowerCase()]
      ?? UNREADABLE_SEVERITY,
    outcomeOf: (raw) => {
      const rule = textOf(objectOf(raw.rule)?.description);
      const message = textOf(objectOf(objectOf(raw.most_recent_instance)?.message)?.text);
      const outcome = rule !== "" ? rule : message;
      return outcome.trim() === "" ? "Clear the code scanning alert" : outcome;
    },
    detailOf: (raw) => textOf(objectOf(objectOf(raw.most_recent_instance)?.message)?.text),
  },
  "secret-scanning": {
    listPath: "secret-scanning/alerts",
    isSecurityAlert: () => true,
    // GitHub gives a secret-scanning alert no severity; a live exposed secret is the worst thing the run files.
    severityOf: () => "critical",
    outcomeOf: (raw) => {
      const type = textOf(raw.secret_type);
      return type === "" ? "Remove the leaked secret" : `Remove the leaked ${type} secret`;
    },
    detailOf: (raw) => {
      const type = textOf(raw.secret_type);
      return type === "" ? "A secret GitHub recognises is exposed in this repository." : `A ${type} secret is exposed in this repository.`;
    },
  },
};

/** `gh api --paginate` walks the `Link: rel="next"` chain until the pages end; the argv each source reads. */
export function alertListArgs(input: { source: GhsecSource; owner: string; repo: string }): string[] {
  return ["api", "--paginate", `repos/${input.owner}/${input.repo}/${SOURCES[input.source].listPath}?state=open&per_page=100`];
}

/** One alert of one source, read again to learn where it stands today. */
export function alertReadArgs(input: { source: GhsecSource; owner: string; repo: string; number: number }): string[] {
  return ["api", `repos/${input.owner}/${input.repo}/${SOURCES[input.source].listPath}/${input.number}`];
}

/** Every repository of an owner, as `gh repo list` answers them. */
export function repoListArgs(owner: string): string[] {
  return ["repo", "list", owner, "--limit", "1000", "--json", "name,isArchived,isFork"];
}

/** The alert's GitHub URL, also the link the settle comment names when the read carried no `html_url`. */
export function alertUrl(input: { source: GhsecSource; owner: string; repo: string; number: number }): string {
  return `https://github.com/${input.owner}/${input.repo}/security/${SOURCES[input.source].listPath}/${input.number}`;
}

/** Where GitHub says one alert stands today, and why when it was dismissed. */
export function alertOutcome(raw: RawAlert): { state: string; dismissedReason?: string } {
  const reason = textOf(raw.dismissed_reason) || textOf(raw.dismissedReason);
  return { state: textOf(raw.state) || "unknown", ...(reason === "" ? {} : { dismissedReason: reason }) };
}

export { SEVERITIES };
