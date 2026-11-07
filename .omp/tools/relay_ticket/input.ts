import { parseThread } from "./thread.js";
import { DEFAULT_SESSION_MINUTES, MAX_SESSION_MINUTES, REPO_SLUG, type RelayTicketInput, TICKET_ID } from "./types.js";

/** An omitted optional arrives as undefined or, from a model, null: both mean absent. */
const present = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

function optionalString(name: string, value: unknown): string | undefined {
  const given = present(value);
  if (given === undefined) return undefined;
  if (typeof given !== "string" || given === "") throw new Error(`${name} must be a non-empty string`);
  return given;
}

function optionalBoolean(name: string, value: unknown, fallback: boolean): boolean {
  const given = present(value);
  if (given === undefined) return fallback;
  if (typeof given !== "boolean") throw new Error(`${name} must be true or false`);
  return given;
}

/** Validates the tool's arguments and applies defaults; throws a message naming the bad field. */
export function parseInput(raw: Readonly<Record<string, unknown>>): RelayTicketInput {
  const ticket = raw.ticket;
  if (typeof ticket !== "string" || !TICKET_ID.test(ticket)) throw new Error("ticket must be a Linear identifier like ZYS-123");
  const repo = optionalString("repo", raw.repo);
  if (repo !== undefined && !REPO_SLUG.test(repo)) throw new Error("repo must be a GitHub repository as owner/name");
  const minutes = present(raw.timeoutMinutes) ?? DEFAULT_SESSION_MINUTES;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SESSION_MINUTES) {
    throw new Error(`timeoutMinutes must be a whole number from 1 to ${MAX_SESSION_MINUTES}`);
  }
  const prompt = optionalString("prompt", raw.prompt);
  const model = optionalString("model", raw.model);
  return {
    ticket,
    ...(repo === undefined ? {} : { repo }),
    ...(prompt === undefined ? {} : { prompt }),
    thread: parseThread(raw.thread),
    settleOnTicket: optionalBoolean("settleOnTicket", raw.settleOnTicket, true),
    merge: optionalBoolean("merge", raw.merge, false),
    ...(model === undefined ? {} : { model }),
    timeoutMinutes: minutes,
  };
}
