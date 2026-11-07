// find_superseding_tickets: which tickets filed after this one make it unnecessary? A full omp session with the user's own
// setup reads the ticket and searches Linear and answers one JSON object; the filing dates are then checked here, in
// code, so a ticket the agent names that was not filed later is dropped no matter how plausible it sounds.
import { askObject, type Exec } from "./omp_session.js";
import { type Obj, reqArray, reqObject, reqString, ticketId } from "./shape.js";
import { supersessionPrompt } from "./supersession_prompt.js";

export const FIND_SUPERSEDING_TICKETS_NAME = "find_superseding_tickets";

/** One session reads the ticket and searches Linear in every status; it can take a while. */
export const SUPERSESSION_TIMEOUT_MS = 20 * 60_000;

const LINEAR_ID = /^[A-Z][A-Z0-9]*-\d+$/;

export interface SupersedingTicket {
  id: string;
  filed_at: string;
  why: string;
}

export interface FindSupersedingTicketsOutput {
  ticket: string;
  verdict: "superseded" | "not_superseded" | "unverified";
  filed_at: string | null;
  superseded_by: SupersedingTicket[];
  rejected: { id: string; reason: string }[];
  evidence: string;
}

export interface FindSupersedingDeps {
  exec: Exec;
  signal?: AbortSignal;
  /** Directory the session starts in; a private temporary one when absent. */
  cwd?: string;
}

interface Answer {
  filed_at: string;
  superseded_by: SupersedingTicket[];
  evidence: string;
}

/** What the agent answers. Throws, naming the field, when the shape is wrong. */
export function supersessionAnswerOf(value: Obj): Answer {
  return {
    filed_at: reqString(value, "filed_at"),
    superseded_by: reqArray(value, "superseded_by").map((entry, index) => {
      const candidate = reqObject(entry, `superseded_by[${index}]`);
      return { id: reqString(candidate, "id"), filed_at: reqString(candidate, "filed_at"), why: reqString(candidate, "why") };
    }),
    evidence: reqString(value, "evidence"),
  };
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Applies the dates, in code, to what the agent answered: a candidate counts only when it is a Linear identifier other
 * than the ticket, named once, with a real filing date strictly after the ticket's.
 */
export function judgeSupersession(ticket: string, answer: Answer): FindSupersedingTicketsOutput {
  const { filed_at, evidence } = answer;
  const ticketTime = Date.parse(filed_at);
  if (Number.isNaN(ticketTime)) {
    return {
      ticket,
      verdict: "unverified",
      filed_at,
      superseded_by: [],
      rejected: [],
      evidence: `the ticket's filing date is not a date (${filed_at}), so later tickets cannot be told from earlier ones`,
    };
  }
  const kept: SupersedingTicket[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const candidate of answer.superseded_by) {
    const id = candidate.id.trim().toUpperCase();
    const time = Date.parse(candidate.filed_at);
    if (!LINEAR_ID.test(id)) rejected.push({ id, reason: "not a Linear identifier" });
    else if (id === ticket) rejected.push({ id, reason: "the ticket itself" });
    else if (kept.some((entry) => entry.id === id)) rejected.push({ id, reason: "named twice" });
    else if (Number.isNaN(time)) rejected.push({ id, reason: `filing date ${candidate.filed_at} is not a date` });
    else if (time <= ticketTime) {
      rejected.push({ id, reason: `filed ${candidate.filed_at}, not after the ticket (${filed_at})` });
    } else kept.push({ id, filed_at: candidate.filed_at, why: candidate.why });
  }
  return {
    ticket,
    verdict: kept.length > 0 ? "superseded" : "not_superseded",
    filed_at,
    superseded_by: kept,
    rejected,
    evidence,
  };
}

/** Runs the check. An agent that cannot answer is `unverified`, never `not_superseded`; a cancellation still throws. */
export async function runFindSupersedingTickets(
  input: { ticket: string },
  deps: FindSupersedingDeps,
): Promise<FindSupersedingTicketsOutput> {
  const ticket = ticketId(input.ticket);
  let answer: Answer;
  try {
    answer = await askObject(deps.exec, supersessionPrompt(ticket), supersessionAnswerOf, {
      timeoutMs: SUPERSESSION_TIMEOUT_MS,
      signal: deps.signal,
      cwd: deps.cwd,
      label: `find_superseding_tickets ${ticket}`,
    });
  } catch (error) {
    deps.signal?.throwIfAborted();
    return {
      ticket,
      verdict: "unverified",
      filed_at: null,
      superseded_by: [],
      rejected: [],
      evidence: `the agent did not answer: ${reasonOf(error)}`,
    };
  }
  return judgeSupersession(ticket, answer);
}
