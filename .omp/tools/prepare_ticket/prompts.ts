import { NO_RECURSION } from "./omp_session.js";

/** The intake prompt, copied from the Mastra capability's `intake.yaml` and adapted to a full omp session that answers in JSON. */
const INTAKE_INSTRUCTIONS = `Rewrite Linear ticket {ticket} according to the tickets skill below. You may need to investigate to decipher the ticket and
make it doable. Review the entire ticket, not just the body: every comment, the metadata (labels, project, related issues,
priority, estimate), the status, and the ticket's history. Linear tools are not preloaded: find them with tool_search.

Rewrite it skeptically, adversarially reviewing the claim, so that the ticket is useful to the next worker who takes it.
Put relevant information that does not belong in the ticket body (your hunches, guesses, recommendations) in a comment.
Make the ticket FAANG-grade.

When the ticket's underlying complaint is not already clear from the repository and the ticket's own history, research it
with web search: is it a real problem at all, and is there a common-practice solution to this type of problem that should be
considered for adoption? Record what you found, with sources, in a comment (not the ticket body), and let it inform whether
the ticket is real, already solved by a standard practice, or better reframed. Skip the search when the ticket is
self-evidently specific to this codebase.

Update the ticket's metadata: the tags, the related issues, and the status. The status must reflect the truth: Canceled for
a superseded ticket, Duplicate for a duplicate, the ready-for-development status only for a ticket that is ready for
development, the not-ready status for one that is not. If you find an in-progress pull request for this issue, link it to
the issue so the next agent or engineer has the context.

Answer ready_for_work true only when the ticket is ready for development after your changes, and give the exact status name
the ticket now has.`;

const ANSWER_FORMAT = `## Your answer

When you are done, reply with ONLY one JSON object: no prose, no code fence. Its shape:
{"ready_for_work": <true when the ticket is ready for development after your changes>, "status": "<the exact name of the ticket's status after your changes>"}

Examples:
- Linear ticket ZYS-1. The body is vague; a comment names the failing endpoint and the cause.
  {"ready_for_work": true, "status": "Ready for Development"}
- Linear ticket ZYS-2. It asks for a fix that another ticket already shipped.
  {"ready_for_work": false, "status": "Canceled"}`;

/** Substitutes by position, so a `$&` or `{ticket}` inside the skill text is never re-expanded. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(ticket|tickets_skill)\}/g, (_match, key: string) => values[key]!);
}

export function intakePrompt(ticket: string, ticketsSkill: string): string {
  return [
    fill(INTAKE_INSTRUCTIONS, { ticket, tickets_skill: ticketsSkill }),
    "",
    NO_RECURSION,
    "",
    "## Tickets skill",
    "",
    ticketsSkill,
    "",
    ANSWER_FORMAT,
  ].join("\n");
}

/**
 * The re-ask after a reply that was not the JSON object. The earlier run's edits are already saved, so this prompt makes
 * no edits: it reads the ticket and answers from what Linear shows now.
 */
export function answerOnlyPrompt(ticket: string, reason: string, previousReply: string): string {
  return [
    `An earlier run rewrote Linear ticket ${ticket} per the tickets skill and its final reply was rejected: ${reason}`,
    "Its edits are already saved. Do NOT edit, comment on, or change the status of the ticket again. Read the ticket now in Linear (Linear tools are not preloaded: find them with tool_search) and answer from what it shows.",
    "",
    NO_RECURSION,
    "",
    "Earlier reply, for context only:",
    previousReply,
    "",
    ANSWER_FORMAT,
  ].join("\n");
}
