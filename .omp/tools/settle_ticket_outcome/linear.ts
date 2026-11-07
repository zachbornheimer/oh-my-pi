import { askObject, type Exec, NO_RECURSION } from "./omp_session.js";
import { type Obj, optString, reqBool, reqString } from "./shape.js";
import type { Workspace } from "./workspaces.js";

/** A write session sets the status and posts one comment; it can take a few minutes. */
export const WRITE_TIMEOUT_MS = 10 * 60_000;
/** A read session reads one ticket. */
export const READ_TIMEOUT_MS = 5 * 60_000;
/** How many of a ticket's latest comments the read-back looks through for the one just posted. */
export const COMMENTS_READ = 10;

export interface LinearWrite {
  ticket: string;
  /** The exact status name to set. */
  status: string;
  /** The ticket this one duplicates; only with the workspace's duplicate status. */
  duplicateOf?: string;
  /** The comment text, posted once. */
  comment: string;
}

export interface LinearRead {
  /** The exact status name the ticket has now. */
  status: string;
  /** The verbatim bodies of the ticket's latest comments, newest first. */
  comments: string[];
}

/** One Linear workspace, through the user's own Linear tools in a full omp session. */
export interface LinearPort {
  /** Sets the status (and the duplicate relation), then posts the comment. Throws when the session says a write did not happen. */
  write(workspace: Workspace, input: LinearWrite): Promise<void>;
  /** Reads the ticket's status and latest comments now. */
  read(workspace: Workspace, ticket: string): Promise<LinearRead>;
}

const where = (workspace: Workspace, ticket: string): string =>
  `Linear ticket ${ticket} (the workspace served by the Linear MCP server "${workspace.server}", or whichever Linear tool reaches the team whose key is ${workspace.team}). Linear tools are not preloaded: find them with tool_search.`;

const COMMENT_BEGIN = "----- COMMENT BEGIN -----";
const COMMENT_END = "----- COMMENT END -----";

export function writePrompt(workspace: Workspace, input: LinearWrite): string {
  const duplicate = input.duplicateOf === undefined
    ? ""
    : `\n   ${input.ticket} duplicates ${input.duplicateOf}: also record that as a Linear relation of type duplicate from ${input.ticket} to ${input.duplicateOf}.`;
  return `Settle ${where(workspace, input.ticket)}

Do exactly these two things, in this order, and nothing else (no other edit, label, relation, assignee or comment):
1. Set its status to exactly "${input.status}". Look the status up by name among the team's statuses. If the team has no status named exactly that, change nothing and answer status_set false with the reason in problem.${duplicate}
2. Post ONE comment on it whose text is exactly what is between the two marker lines below, verbatim, markdown as written. First read the ticket's comments: if one with exactly this text already exists, post nothing more and count it as posted.

${COMMENT_BEGIN}
${input.comment}
${COMMENT_END}

${NO_RECURSION}

## Your answer

Reply with ONLY one JSON object: no prose, no code fence. Its shape:
{"status_set": <true when the ticket now has that status>, "duplicate_linked": <true when the duplicate relation was recorded, false when it was asked for and not, null when none was asked for>, "comment_posted": <true when the comment is on the ticket, once>, "problem": <"why something is not done", or null>}`;
}

/** The re-ask after a reply that was not the JSON object: the writes may already be saved, so the session checks before it writes. */
export function writeRetryPrompt(workspace: Workspace, input: LinearWrite, reason: string, previousReply: string): string {
  return `${writePrompt(workspace, input)}

A previous run of this job did some or all of it and its reply was rejected: ${reason}
Earlier reply, for context only:
${previousReply}
Read the ticket first. Do only what is still missing: do not set the status again if it already has it, and never post the comment a second time. Then answer from what the ticket shows now.`;
}

export interface WriteReply {
  status_set: boolean;
  duplicate_linked: boolean | null;
  comment_posted: boolean;
  problem: string | undefined;
}

export function writeReplyOf(value: Obj): WriteReply {
  const linked = value.duplicate_linked;
  if (linked !== null && linked !== undefined && typeof linked !== "boolean") throw new Error("duplicate_linked must be a boolean or null");
  return {
    status_set: reqBool(value, "status_set"),
    duplicate_linked: linked ?? null,
    comment_posted: reqBool(value, "comment_posted"),
    problem: optString(value, "problem"),
  };
}

export function readPrompt(workspace: Workspace, ticket: string): string {
  return `Read ${where(workspace, ticket)}

This is a read-only check: change nothing. Report the ticket's exact current status name, and the full verbatim body of each of its ${COMMENTS_READ} most recent comments, newest first (fewer when it has fewer). If a read looks stale, read again up to 3 times a few seconds apart before answering.

${NO_RECURSION}

## Your answer

Reply with ONLY one JSON object: no prose, no code fence. Its shape:
{"status": "<exact status name>", "comments": ["<comment body>", "..."]}`;
}

export function readReplyOf(value: Obj): LinearRead {
  const comments = value.comments;
  if (!Array.isArray(comments) || comments.some((body) => typeof body !== "string")) throw new Error("comments must be an array of strings");
  return { status: reqString(value, "status").trim(), comments: comments as string[] };
}

export interface LiveDeps {
  exec: Exec;
  signal?: AbortSignal;
  cwd?: string;
}

/** The live port: a full omp session writes, and a separate read-only one reads back. */
export function linearSessionPort(deps: LiveDeps): LinearPort {
  return {
    async write(workspace, input) {
      const reply = await askObject(deps.exec, writePrompt(workspace, input), writeReplyOf, {
        timeoutMs: WRITE_TIMEOUT_MS,
        signal: deps.signal,
        cwd: deps.cwd,
        label: `settle_ticket_outcome ${input.ticket}`,
        retry: (reason, previous) => writeRetryPrompt(workspace, input, reason, previous),
      });
      const missing: string[] = [];
      if (!reply.status_set) missing.push(`the status was not set to "${input.status}"`);
      if (input.duplicateOf !== undefined && reply.duplicate_linked !== true) missing.push(`the duplicate relation to ${input.duplicateOf} was not recorded`);
      if (!reply.comment_posted) missing.push("the comment was not posted");
      if (missing.length > 0) {
        throw new Error(`Linear write on ${input.ticket} did not complete: ${missing.join("; ")}${reply.problem === undefined ? "" : ` (${reply.problem})`}`);
      }
    },
    read: (workspace, ticket) =>
      askObject(deps.exec, readPrompt(workspace, ticket), readReplyOf, {
        timeoutMs: READ_TIMEOUT_MS,
        signal: deps.signal,
        cwd: deps.cwd,
        label: `settle_ticket_outcome read-back of ${ticket}`,
      }),
  };
}
