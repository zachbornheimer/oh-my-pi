import { join } from "node:path";
import { EVENTS_FILE, STATE_FILE } from "./constants.js";
import type { Host } from "./host.js";
import { type FailingJob, isRepoState, localDay, type RepoState } from "./states.js";

export type LedgerEvent = {
  at: string;
  runId: string;
  nameWithOwner: string;
  from: string;
  to: string;
  evidence: string;
  defaultBranch?: string;
  failingJobs?: FailingJob[];
  prUrl?: string;
  pid?: number | null;
  elapsedSeconds?: number;
};

export type Row = {
  nameWithOwner: string;
  defaultBranch: string;
  state: RepoState;
  failingJobs: FailingJob[];
  prUrl: string;
  pid: number | null;
  attemptsToday: number;
  elapsedSeconds: number;
  lastEvent: string;
  updatedAt: string;
};

export type StateFile = {
  runId: string;
  generatedAt: string;
  repositories: Row[];
};

function eventsPath(host: Host): string {
  return join(host.stateDir(), EVENTS_FILE);
}

export async function readEvents(host: Host): Promise<LedgerEvent[]> {
  const text = await host.readText(eventsPath(host));
  if (text === undefined || text.trim() === "") return [];
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch (error) {
        throw new Error(`${eventsPath(host)} line ${index + 1} is not JSON: ${(error as Error).message}`);
      }
    });
}

/** The local calendar day an event's ISO timestamp falls on: the day `ci-green/<date>` branches are named for. */
function dayOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at.slice(0, 10) : localDay(parsed);
}

export function derive(events: LedgerEvent[], generatedAt: string): StateFile {
  const rows = new Map<string, Row>();
  let runId = "";
  for (const event of events) {
    if (event.runId) runId = event.runId;
    if (event.nameWithOwner === "" || !isRepoState(event.to)) continue;
    const prior = rows.get(event.nameWithOwner);
    rows.set(event.nameWithOwner, rowFrom(event, prior, events));
  }
  return { runId, generatedAt, repositories: [...rows.values()] };
}

function rowFrom(event: LedgerEvent, prior: Row | undefined, events: LedgerEvent[]): Row {
  const state = event.to as RepoState;
  return {
    nameWithOwner: event.nameWithOwner,
    defaultBranch: event.defaultBranch ?? prior?.defaultBranch ?? "",
    state,
    failingJobs: event.failingJobs ?? prior?.failingJobs ?? [],
    prUrl: event.prUrl ?? prior?.prUrl ?? "",
    pid: event.pid === undefined ? (prior?.pid ?? null) : event.pid,
    attemptsToday: countAttempts(events, event.nameWithOwner, event.at),
    elapsedSeconds: sumElapsed(events, event.nameWithOwner),
    lastEvent: event.evidence,
    updatedAt: event.at,
  };
}

function countAttempts(events: LedgerEvent[], name: string, at: string): number {
  const day = dayOf(at);
  return events.filter((event) => event.nameWithOwner === name && event.to === "fixing" && dayOf(event.at) === day)
    .length;
}

function sumElapsed(events: LedgerEvent[], name: string): number {
  return events.reduce(
    (total, event) => (event.nameWithOwner === name ? total + (event.elapsedSeconds ?? 0) : total),
    0,
  );
}

const appends = new Map<string, Promise<unknown>>();

/** Appends are serialized per state directory: concurrent repositories share one log and one `state.json.tmp`. */
export function appendEvent(host: Host, event: LedgerEvent): Promise<StateFile> {
  const key = host.stateDir();
  const written = (appends.get(key) ?? Promise.resolve()).then(() => appendNow(host, event));
  appends.set(key, written.catch(() => undefined));
  return written;
}

async function appendNow(host: Host, event: LedgerEvent): Promise<StateFile> {
  await host.appendText(eventsPath(host), JSON.stringify(event));
  const state = derive(await readEvents(host), event.at);
  await writeState(host, state);
  return state;
}

/** The repository's latest row, or undefined when the ledger has never recorded it. */
export async function readRow(host: Host, nameWithOwner: string): Promise<Row | undefined> {
  const state = derive(await readEvents(host), host.now().toISOString());
  return state.repositories.find((row) => row.nameWithOwner === nameWithOwner);
}

/** Agent seconds the ledger holds for events written on `now`'s local day, in milliseconds. */
export function agentMsToday(events: LedgerEvent[], now: Date): number {
  const day = localDay(now);
  const seconds = events.reduce(
    (total, event) => (dayOf(event.at) === day ? total + (event.elapsedSeconds ?? 0) : total),
    0,
  );
  return seconds * 1000;
}

async function writeState(host: Host, state: StateFile): Promise<void> {
  const path = join(host.stateDir(), STATE_FILE);
  const tmp = `${path}.tmp`;
  await host.writeText(tmp, `${JSON.stringify(state)}\n`);
  await host.rename(tmp, path);
}
