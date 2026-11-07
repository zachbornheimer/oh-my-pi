import type { ChangeVerdict, Closing, Outcome, PublishedPullRequest } from "./schemas.js";

const HEADLINE: Record<Exclude<Outcome, "busy">, string> = {
  undecipherable: "Not ready for development: this ticket cannot be deciphered",
  already_done: "Done: this is already complete",
  obsolete: "Canceled: obsolete",
  superseded: "Closed: superseded",
  needs_info: "Not ready for development: more information is needed",
  pr_ready: "Pull request ready",
  work_completed: "Done: the work is complete",
  blocked: "Blocked: this run cannot finish it as dispatched",
};

const CONCERN_LABEL: Partial<Record<Outcome, string>> = {
  undecipherable: "Questions that block this ticket",
  needs_info: "Outstanding concerns",
  blocked: "What is missing, and what would unblock it",
};

function list(heading: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ["", `${heading}:`, ...items.map((item) => `- ${item}`)];
}

/** The comment the factory leaves on the ticket when a run settles. */
export function ticketComment(
  closing: Closing,
  extra: { pullRequest?: PublishedPullRequest; closedPullRequests: readonly string[]; supersededBy?: string },
): string {
  if (closing.outcome === "busy") throw new Error("a busy run writes nothing to the ticket");
  const lines = [`**Software factory: ${HEADLINE[closing.outcome]}**`, "", closing.summary];
  lines.push(...list(CONCERN_LABEL[closing.outcome] ?? "Concerns", closing.concerns));
  lines.push(...list("Evidence", closing.evidence));
  if (extra.supersededBy !== undefined) lines.push("", `Superseded by ${extra.supersededBy}.`);
  if (extra.pullRequest !== undefined) {
    lines.push("", `${extra.pullRequest.draft ? "Draft pull request" : "Pull request"}: ${extra.pullRequest.url}`);
  }
  lines.push(...list("Closed pull requests", extra.closedPullRequests));
  return lines.join("\n");
}

/** The one comment a run that could not finish leaves on the ticket, in the factory's own voice. */
export function failureComment(reason: string): string {
  return [
    "**Software factory: this run could not finish**",
    "",
    reason,
    "",
    "The run stopped before it settled anything, so the ticket was left as it was; re-dispatch it, or reply here with what blocked it.",
  ].join("\n");
}

function section(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ["", `## ${title}`, "", ...items.map((item) => `- ${item}`)];
}

/** The pull request body: it names the ticket, what was done, what the review said, and any outstanding concerns. */
export function pullRequestBody(input: {
  ticket: string;
  ticketUrl: string;
  summary: string;
  concerns: readonly string[];
  evidence: readonly string[];
  review?: ChangeVerdict;
  draft: boolean;
  /** The workspace's own name for the status a remand lands in. */
  remandedTo: string;
}): string {
  const lines = [`Linear: [${input.ticket}](${input.ticketUrl})`];
  if (input.draft) {
    lines.push(
      "",
      `**Draft: ${input.ticket} was sent back to ${input.remandedTo}.** This branch holds the work done so far; the outstanding concerns are below.`,
    );
  }
  lines.push("", "## Summary", "", input.summary);
  lines.push(...section(input.draft ? "Outstanding concerns" : "Concerns", input.concerns));
  lines.push(...section("Evidence", input.evidence));
  if (input.review !== undefined) {
    lines.push("", "## Adversarial review", "", `${input.review.verdict}: ${input.review.summary}`);
    lines.push(
      ...input.review.findings.map((finding) =>
        `- [${finding.severity}] ${finding.location}: ${finding.issue}${finding.fix === undefined ? "" : ` (fix: ${finding.fix})`}`
      ),
    );
  }
  return lines.join("\n");
}
