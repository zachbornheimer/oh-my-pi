import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { askObject, type Exec } from "./omp_session.js";
import { answerOnlyPrompt, intakePrompt } from "./prompts.js";
import { type Obj, reqBool, reqString, ticketId } from "./shape.js";

export const PREPARE_TICKET_NAME = "prepare_ticket";

/** The whole intake is one omp session that reads, researches and rewrites the ticket; it can run long. */
export const INTAKE_TIMEOUT_MS = 30 * 60_000;

export interface PrepareTicketOutput {
  ready_for_work: boolean;
  status: string;
  reason?: string;
  /** The intake's omp session transcript file; empty when omp wrote none. */
  thread: string;
}

export interface PrepareTicketDeps {
  exec: Exec;
  signal?: AbortSignal;
  /** The text of the tickets skill; the intake follows it. */
  readSkill?: () => Promise<string>;
  /** Where the intake's transcript is kept. */
  threadsDir?: string;
  now?: () => number;
}

const home = (): string => process.env.HOME || homedir();

export const defaultTicketsSkill = (): Promise<string> => readFile(join(home(), ".agents", "skills", "tickets", "SKILL.md"), "utf8");

export const defaultThreadsDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(home(), ".local", "state"), PREPARE_TICKET_NAME, "threads");

/** What the agent answers. */
export function intakeAnswerOf(value: Obj): { ready_for_work: boolean; status: string } {
  return { ready_for_work: reqBool(value, "ready_for_work"), status: reqString(value, "status").trim() };
}

/** The newest `.jsonl` under `dir`, however deep omp nested it; undefined when there is none. */
async function newestTranscript(dir: string): Promise<string | undefined> {
  let best: { path: string; at: number } | undefined;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        const at = (await stat(path)).mtimeMs;
        if (best === undefined || at > best.at) best = { path, at };
      }
    }
  };
  await walk(dir);
  return best?.path;
}

/**
 * Runs the intake on the ticket: one full omp session (the user's own Linear tools) rewrites it and answers whether it
 * is ready. The reply is validated here; a bad one is asked again from the ticket's saved state, without redoing the edits.
 */
export async function runPrepareTicket(input: { ticket: string }, deps: PrepareTicketDeps): Promise<PrepareTicketOutput> {
  const ticket = ticketId(input.ticket);
  const skill = await (deps.readSkill ?? defaultTicketsSkill)();
  const sessionDir = join(deps.threadsDir ?? defaultThreadsDir(), `${ticket}-${(deps.now ?? Date.now)()}`);
  await mkdir(sessionDir, { recursive: true });
  const { ready_for_work, status } = await askObject(deps.exec, intakePrompt(ticket, skill), intakeAnswerOf, {
    timeoutMs: INTAKE_TIMEOUT_MS,
    signal: deps.signal,
    sessionDir,
    label: `prepare_ticket ${ticket}`,
    retry: (reason, reply) => answerOnlyPrompt(ticket, reason, reply),
  });
  const thread = (await newestTranscript(sessionDir)) ?? "";
  return ready_for_work
    ? { ready_for_work, status, thread }
    : {
      ready_for_work,
      status,
      reason: "Unable to make ready for work, see the transcript for more details.",
      thread,
    };
}
