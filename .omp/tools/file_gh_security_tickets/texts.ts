import { TITLE_OUTCOME_MAX } from "./constants.js";
import type { AlertItem } from "./schemas.js";
import { SOURCES } from "./sources.js";

/** The ticket title: the tag first, never truncated; then the short imperative outcome, capped to stay readable. */
export function ticketTitle(item: AlertItem): string {
  const outcome = item.outcome.length > TITLE_OUTCOME_MAX ? `${item.outcome.slice(0, TITLE_OUTCOME_MAX - 1).trimEnd()}…` : item.outcome;
  return `[${item.tag}] ${outcome}`;
}

/** The ticket body, in the template the software factory's /tickets pass consumes. No raw JSON is pasted. */
export function ticketBody(item: AlertItem): string {
  const [owner, repo] = item.repo.split("/");
  const listPath = SOURCES[item.source].listPath;
  const detail = item.detail.trim() === "" ? "GitHub carries no further text for this alert." : item.detail;
  return [
    `## Problem`,
    ``,
    `GitHub reports an open ${item.source} alert (${item.severity}) on ${owner}/${repo}: ${item.outcome}.`,
    ``,
    `## Repro or detail`,
    ``,
    detail,
    ``,
    `## Non-goals`,
    ``,
    `- Nothing outside ${owner}/${repo}.`,
    `- No refactoring beyond clearing the alert.`,
    ``,
    `## Acceptance criteria`,
    ``,
    `- [ ] The ${item.source} alert ${item.number} on ${owner}/${repo} no longer reads open on GitHub.`,
    `- [ ] ${item.outcome}`,
    ``,
    `## Verify`,
    ``,
    "`gh api " + `repos/${owner}/${repo}/${listPath}/${item.number}` + "` answers a state other than `open`.",
    ``,
    `## Evidence`,
    ``,
    `- Tag: ${item.tag}`,
    `- Alert: ${item.url}`,
    `- Repository: ${item.repo}`,
    `- Source: ${item.source} alert ${item.number}`,
    `- Severity: ${item.severity}`,
    `- State: open when filed`,
  ].join("\n");
}

/** The comment a settled ticket carries: what GitHub says about the alert now, and the date the run moved the ticket. */
export function settleComment(input: {
  tag: string;
  githubState: string;
  dismissedReason?: string;
  url: string;
  date: string;
  done: string;
}): string {
  const why = input.dismissedReason === undefined ? "" : ` (${input.dismissedReason})`;
  return [
    `**file_gh_security_tickets: GitHub says this alert is ${input.githubState}${why}.**`,
    ``,
    `${input.url}`,
    ``,
    `Moved to ${input.done} on ${input.date}; the ticket no longer tracks live work. Tag: ${input.tag}.`,
  ].join("\n");
}
