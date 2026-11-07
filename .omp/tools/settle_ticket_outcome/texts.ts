/** The comment a settled run leaves on its ticket, copied from the Mastra factory's `texts.ts`. */

export const OUTCOMES = [
  "undecipherable",
  "already_done",
  "obsolete",
  "superseded",
  "needs_info",
  "pr_ready",
  "work_completed",
  "blocked",
  "busy",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** How a run ends: what is written to the ticket and to the linked pull requests. */
export interface Closing {
  outcome: Outcome;
  summary: string;
  concerns: string[];
  evidence: string[];
  supersededBy?: string;
  closeLinkedPullRequest: boolean;
}

export interface PublishedPullRequest {
  url: string;
  number: number;
  draft: boolean;
}

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
