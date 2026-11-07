/** The GitHub security sources a run reads, in the order the sources table lists them. */
export const GHSEC_SOURCES = ["dependabot", "code-scanning", "secret-scanning"] as const;
export type GhsecSource = (typeof GHSEC_SOURCES)[number];

/**
 * The sources a *sweep* files tickets for. Dependabot is deliberately absent: `upgrade_bot_prs` already works the open
 * bot pull requests every four hours through `upgrade_dependency`, and filing a ticket per Dependabot alert would
 * duplicate that machinery on the scale that makes it unusable (hundreds of alerts per repository). Dependabot stays in
 * `GHSEC_SOURCES` because a tag that already exists for one must still be read, and settled, by the run that owns it.
 */
export const SWEEP_SOURCES = ["code-scanning", "secret-scanning"] as const;

/**
 * The tag that joins a GitHub security alert to its Linear ticket: `ghsec:<owner>/<repo>#<source>-<number>`, such as
 * `ghsec:Software-Automation-Holdings-LLC/auth#code-scanning-42`. One function formats it, one regex parses it, both
 * here; nothing else in this tool may shape a tag.
 */
const GHSEC_TAG = new RegExp(`^ghsec:([^/\\s#]+)/([^/\\s#]+)#(${GHSEC_SOURCES.join("|")})-([1-9][0-9]*)$`);

export function ghsecTag(input: { owner: string; repo: string; source: GhsecSource; number: number }): string {
  return `ghsec:${input.owner}/${input.repo}#${input.source}-${input.number}`;
}

export type GhsecTagParts = { owner: string; repo: string; source: GhsecSource; number: number };

/** The pieces of one ghsec tag, or nothing when the text is not one. */
export function parseGhsecTag(text: string): GhsecTagParts | undefined {
  const found = GHSEC_TAG.exec(text.trim());
  if (found === null) return undefined;
  return { owner: found[1]!, repo: found[2]!, source: found[3]! as GhsecSource, number: Number(found[4]) };
}

/** The first ghsec tag any text carries (a ticket title carries its tag in square brackets), or nothing. */
export function findGhsecTag(text: string): string | undefined {
  for (const candidate of text.match(/ghsec:[^\s\]]+/g) ?? []) {
    if (parseGhsecTag(candidate) !== undefined) return candidate;
  }
  return undefined;
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const isSeverity = (value: unknown): value is Severity => (SEVERITIES as readonly unknown[]).includes(value);

/** Critical first: how `minSeverity` keeps the alerts at or above the floor, and how a sweep orders its tickets. */
export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/**
 * Critical first, then high, medium, low: the order a sweep lists its alerts in, so the worst alert is the first
 * ticket the run creates. Ties keep the order the sources answered in (the sort is stable); the reconcile step then
 * breaks ties by tag.
 */
export const bySeverityDescending = <T extends { severity: Severity }>(left: T, right: T): number =>
  severityRank(left.severity) - severityRank(right.severity);

export const DEFAULT_MIN_SEVERITY: Severity = "low";
// An unreadable severity files as medium: never guess an alert up or down from text the source did not carry.
export const UNREADABLE_SEVERITY: Severity = "medium";

/** Linear's `priority` from the alert's severity: 1 Urgent, 2 High, 3 Normal, 4 Low. */
export const SEVERITY_PRIORITY: Record<Severity, number> = { critical: 1, high: 2, medium: 3, low: 4 };

/** The label a ticket takes only when the workspace already has one by this name; none is ever created. */
export const SECURITY_LABEL = "Security";

/** The short outcome after the tag in a ticket title; the tag itself is never truncated. */
export const TITLE_OUTCOME_MAX = 80;

/** `gh repo list --limit`: the most repositories one owner run will visit. */
export const MAX_REPOS_PER_OWNER = 1000;

/** One source of one repository answers at most this many open alerts; past it the run fails rather than file a partial set. */
export const MAX_ALERTS_PER_SOURCE = 1000;

export const LINEAR_PAGE_SIZE = 250;
/** A runaway bound on Linear pagination, not a size budget. */
export const MAX_LINEAR_PAGES = 100;

/** Interval between progress updates while the run works. */
export const HEARTBEAT_MS = 15_000;
