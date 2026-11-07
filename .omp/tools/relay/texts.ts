import type { Closing, Comment, Issue, Outcome } from "./types.js";

const HEADLINE: Record<Outcome, string> = {
  undecipherable: "Not ready for development: this ticket cannot be deciphered",
  already_done: "Done: this is already complete",
  obsolete: "Canceled: obsolete",
  superseded: "Closed: superseded",
  needs_info: "Not ready for development: more information is needed",
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

/** The comment the relay leaves on the ticket when a run settles. The headline keeps the software factory's voice. */
export function ticketComment(closing: Closing, extra: { closedPullRequests: readonly string[]; supersededBy?: string }): string {
  const lines = [`**Software factory: ${HEADLINE[closing.outcome]}**`, "", closing.summary];
  lines.push(...list(CONCERN_LABEL[closing.outcome] ?? "Concerns", closing.concerns));
  lines.push(...list("Evidence", closing.evidence));
  if (extra.supersededBy !== undefined) lines.push("", `Superseded by ${extra.supersededBy}.`);
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

/** The ticket as the data a model is shown: title, status, description and every comment, oldest first. */
export function ticketMaterial(issue: Issue, comments: readonly Comment[]): string {
  const thread = [...comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((comment) => `--- comment ${comment.createdAt}\n${comment.body}`)
    .join("\n\n");
  return [
    `Ticket ${issue.identifier} (${issue.url})`,
    `Title: ${issue.title}`,
    `Status: ${issue.status}`,
    "",
    "Description:",
    issue.description === "" ? "(empty)" : issue.description,
    ...(thread === "" ? [] : ["", "Comments:", thread]),
  ].join("\n");
}

/** A message from anything thrown. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
