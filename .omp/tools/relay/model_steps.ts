import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMPROVEMENT_SCHEMA,
  parseImprovement,
  parseRewriteReply,
  parseRootCauseVerdict,
  parseWorkRecord,
  REWRITE_SCHEMA,
  ROOT_CAUSE_SCHEMA,
  schemaText,
  WORK_RECORD_SCHEMA,
} from "./records.js";
import { fillTemplate, parseAnswer } from "./template.js";
import { ticketMaterial } from "./texts.js";
import type { Comment, Improvement, Issue, PullRequestRef, RelayPorts, RewriteAnswer, RootCauseVerdict, WorkRecord } from "./types.js";

/** The skill whose text the /tickets rewrite carries. */
export const TICKETS_SKILL = "tickets";

/** Where the adversarial reviewer writes its one JSON verdict: outside every checkout, so a review never writes into a target tree. */
export function rootCauseVerdictPath(ticket: string, directory: string): string {
  return join(directory, `${ticket}-root-cause.json`);
}

function prompt(name: string): string {
  return readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8");
}

/** The reply schema of the /tickets question: an object whose one required key is the question's field. */
function rewriteReplySchema(): object {
  return { type: "object", properties: { Rewrite: REWRITE_SCHEMA }, required: ["Rewrite"], additionalProperties: false };
}

/**
 * MODEL: one question over the ticket, with the text of the `tickets` skill (read at run time from the installed skills)
 * in its instructions. Answers `{ decipherable, description, questions }`: the template-shaped body, or the questions
 * that block it. Writes nothing.
 */
export async function rewriteTicketToTemplate(
  ports: Pick<RelayPorts, "ask" | "readSkill">,
  input: { issue: Issue; comments: readonly Comment[] },
): Promise<RewriteAnswer> {
  const skill = await ports.readSkill(TICKETS_SKILL);
  const text = await ports.ask({
    field: "Rewrite",
    prompt: fillTemplate(
      prompt("rewrite_ticket.md"),
      { skill, material: ticketMaterial(input.issue, input.comments), schema: JSON.stringify(rewriteReplySchema()) },
      "rewrite_ticket.md",
    ),
  });
  return parseAnswer(text, parseRewriteReply, "the Rewrite question");
}

/**
 * MODEL (headless omp, read-only): the adversarial pre-review. Is the ticket's claim real, what is its root cause, or is it
 * a user mistake, done, obsolete or superseded? The reviewer writes one JSON verdict file that is parsed; a missing or
 * malformed file throws. The relay opens no checkout, so the review reads the ticket's own material and runs in a scratch
 * directory.
 */
export async function reviewTicketRootCause(
  ports: Pick<RelayPorts, "review">,
  input: { ticket: string; body: string; linkedPulls: readonly PullRequestRef[]; verdictDirectory: string },
): Promise<RootCauseVerdict> {
  const verdictPath = rootCauseVerdictPath(input.ticket, input.verdictDirectory);
  const checkout =
    "No repository was identified for this ticket, so there is no checkout to read: judge the claim on the ticket's own material and on what you can reach from here — the hosts, services and accounts the ticket names — and set `workInThisCheckout` false.";
  const text = await ports.review({
    verdictPath,
    prompt: fillTemplate(
      prompt("review_root_cause.md"),
      {
        ticket: input.ticket,
        body: input.body,
        checkout,
        linkedPullRequests: input.linkedPulls.length === 0 ? "none" : input.linkedPulls.map((pull) => pull.url).join(", "),
        verdictPath,
        schema: schemaText(ROOT_CAUSE_SCHEMA),
      },
      "review_root_cause.md",
    ),
  });
  return parseAnswer(text, parseRootCauseVerdict, `the root-cause review of ${input.ticket}`);
}

/** The adversarial review's finding, as the worker starts from it. */
function reviewText(verdict: RootCauseVerdict): string {
  const lines = [
    `Verdict: ${verdict.verdict} — real work; judge the rest yourself, this is where you start, not what you must copy.`,
    `Root cause: ${verdict.rootCause}`,
    `Summary: ${verdict.summary}`,
  ];
  if (verdict.evidence.length > 0) lines.push("Evidence:", ...verdict.evidence.map((line) => `- ${line}`));
  if (verdict.concerns.length > 0) lines.push("Concerns:", ...verdict.concerns.map((line) => `- ${line}`));
  return lines.join("\n");
}

/**
 * MODEL (headless omp): works the reviewed ticket — one call, whose prompt carries the rewritten ticket as untrusted
 * data and the review's finding as its starting material. Answers one record: the deliverable, what it used, the
 * evidence, and an outcome that keeps a blocked attempt distinguishable from completion.
 */
export async function workTicket(
  ports: Pick<RelayPorts, "work">,
  input: { ticket: string; body: string; rootCause: RootCauseVerdict },
): Promise<WorkRecord> {
  const answer = await ports.work({
    prompt: fillTemplate(
      prompt("work_ticket.md"),
      { ticket: input.ticket, body: input.body, review: reviewText(input.rootCause), schema: schemaText(WORK_RECORD_SCHEMA) },
      "work_ticket.md",
    ),
  });
  return parseAnswer(answer, parseWorkRecord, `the relay's ticket worker on ${input.ticket}`);
}

/** The worked ticket's record, as the tooling pass reads it. */
function workText(work: WorkRecord): string {
  const lines = [`Outcome: ${work.outcome}`, `Summary: ${work.summary}`];
  const used = [
    ...work.used.tools.map((tool) => `tool: ${tool}`),
    ...work.used.skills.map((skill) => `skill: ${skill}`),
    ...work.used.workflows.map((workflow) => `workflow: ${workflow}`),
  ];
  if (used.length > 0) lines.push("What it used:", ...used.map((line) => `- ${line}`));
  if (work.evidence.length > 0) lines.push("Evidence:", ...work.evidence.map((line) => `- ${line}`));
  if (work.concerns.length > 0) lines.push("Concerns:", ...work.concerns.map((line) => `- ${line}`));
  return lines.join("\n");
}

/**
 * MODEL (headless omp, in the tooling checkout): the tooling pass. Asks whether a tool or capability could have existed
 * that would have made the work easier; when one was missing it creates it and lands it (merged to main, or a pull
 * request), and when nothing was missing it says so and changes nothing. Answers one record.
 */
export async function improveTools(
  ports: Pick<RelayPorts, "improve">,
  input: { ticket: string; work: WorkRecord },
): Promise<Improvement> {
  const answer = await ports.improve({
    prompt: fillTemplate(
      prompt("improve_tools.md"),
      { ticket: input.ticket, work: workText(input.work), schema: schemaText(IMPROVEMENT_SCHEMA) },
      "improve_tools.md",
    ),
  });
  return parseAnswer(answer, parseImprovement, `the relay's tooling pass on ${input.ticket}`);
}
