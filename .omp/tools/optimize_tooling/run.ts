import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  preparedOf,
  relayOf,
  settledOf,
  supersessionOf,
  ticketsOf,
  type TicketPorts,
  type TicketRun,
  validationOf,
  workTicket,
} from "./chain.js";
import { fileLock, type Lock } from "./file_lock.js";
import { delegateToolCall, type Exec } from "./omp_delegate.js";

const MS_PER_HOUR = 3_600_000;
/** How many eligible tickets are read before the retry window and the limit choose: the board's head, not all of it. */
const ELIGIBLE_READ = 200;
/** One native-tool call may run as long as a ticket's whole implementation. */
const STEP_TIMEOUT_MS = 3 * MS_PER_HOUR;
export const LOCK_WAIT_MS = 10 * 60_000;
export const LOCK_POLL_MS = 30_000;

export interface Settings {
  linear_teams: string[];
  linear_project: string;
  limit: number;
  retry_after_hours: number;
  apply: boolean;
}
export const DEFAULTS: Settings = { linear_teams: ["ZYS"], linear_project: "AI Tooling", limit: 1, retry_after_hours: 24, apply: true };

/** Applies the defaults and bounds of the Mastra input schema; throws on a value outside them. */
export function settingsOf(input: Partial<Record<keyof Settings, unknown>>): Settings {
  const teams = input.linear_teams ?? DEFAULTS.linear_teams;
  if (!Array.isArray(teams) || teams.some((t) => typeof t !== "string" || t === "")) throw new Error("linear_teams must be non-empty strings");
  const project = input.linear_project ?? DEFAULTS.linear_project;
  if (typeof project !== "string") throw new Error("linear_project must be a string");
  const limit = input.limit ?? DEFAULTS.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1) throw new Error("limit must be a positive integer");
  const hours = input.retry_after_hours ?? DEFAULTS.retry_after_hours;
  if (typeof hours !== "number" || !(hours > 0)) throw new Error("retry_after_hours must be positive");
  const apply = input.apply ?? DEFAULTS.apply;
  if (typeof apply !== "boolean") throw new Error("apply must be a boolean");
  return { linear_teams: [...(teams as string[])], linear_project: project, limit: limit as number, retry_after_hours: hours, apply };
}

/** The tickets a run took, and when: what keeps a blocked ticket from being every run's pick. */
export interface AttemptLedger {
  recent(now: number, windowMs: number): Promise<ReadonlySet<string>>;
  /** Records that `ticket` was taken at `now`, before it is worked: a run that dies still counts. */
  take(ticket: string, now: number): Promise<void>;
}

export const attemptsFile = (home: string = homedir()): string =>
  process.env.OPTIMIZE_TOOLING_ATTEMPTS_FILE ?? join(home, "Library", "Caches", "optimize-tooling", "attempts.json");
export const lockFile = (home: string = homedir()): string =>
  process.env.OPTIMIZE_TOOLING_LOCK_FILE ?? join(home, "Library", "Caches", "optimize-tooling", "lock");
export const nightlyLog = (home: string = homedir()): string => join(home, ".local", "share", "capability-replicas", "nightly.log");

/** The ledger as one JSON file, replaced whole through a rename so a crash never leaves half a file. */
export function fileAttemptLedger(path: string): AttemptLedger {
  async function read(): Promise<Record<string, number>> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a ticket-to-time map`);
    for (const [ticket, at] of Object.entries(parsed)) {
      if (typeof at !== "number") throw new Error(`${path}: ${ticket} has a non-numeric time`);
    }
    return parsed as Record<string, number>;
  }
  return {
    async recent(now, windowMs) {
      const taken = await read();
      return new Set(Object.entries(taken).filter(([, at]) => now - at < windowMs).map(([ticket]) => ticket));
    },
    async take(ticket, now) {
      const taken = await read();
      taken[ticket] = now;
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(taken, null, 2));
      await rename(temp, path);
    },
  };
}

/** Where a run chooses its tickets from: priority first, then oldest, over each team's workable statuses. */
export type EligibleTickets = (input: { teams: string[]; project: string | undefined; limit: number }, signal?: AbortSignal) => Promise<string[]>;

/**
 * The live ports. Each step belongs to another native omp tool and runs through one full omp session that calls it by name:
 * `list_eligible_tickets`, `prepare_ticket`, `find_superseding_tickets`, `validate_ticket`, `settle_ticket_outcome`, `relay`.
 */
export function liveTicketPorts(exec: Exec, signal?: AbortSignal): { ports: TicketPorts; eligible: EligibleTickets } {
  const call = <T>(tool: string, args: unknown, validate: (v: Record<string, unknown>) => T): Promise<T> =>
    delegateToolCall(exec, { tool, args, validate, timeoutMs: STEP_TIMEOUT_MS, signal });
  return {
    eligible: (input) => call("list_eligible_tickets", input, ticketsOf),
    ports: {
      prepare: (ticket) => call("prepare_ticket", { ticket }, preparedOf),
      findSuperseding: (ticket) => call("find_superseding_tickets", { ticket }, supersessionOf),
      validate: (ticket, supersession) => call("validate_ticket", { ticket, supersession }, validationOf),
      closeSuperseded: (ticket, supersession, validation) =>
        call(
          "settle_ticket_outcome",
          {
            ticket,
            closing: {
              outcome: "superseded",
              summary: `Superseded by ${supersession.superseded_by.map((later) => later.id).join(", ")}.`,
              concerns: [],
              evidence: [...supersession.superseded_by.map((later) => `${later.id} (filed ${later.filed_at}): ${later.why}`), supersession.evidence],
              ...(supersession.superseded_by[0] === undefined ? {} : { supersededBy: supersession.superseded_by[0].id }),
              closeLinkedPullRequest: true,
            },
            linkedPulls: validation.open_pull_requests.map((pr) => pr.url),
          },
          settledOf,
        ),
      relay: (ticket) => call("relay", { ticket }, relayOf),
    },
  };
}

export interface OptimizeOutput {
  status: "worked" | "empty" | "busy";
  eligible: number;
  recently_taken: string[];
  runs: TicketRun[];
  next: string;
}

export interface Deps {
  eligible: EligibleTickets;
  ports: TicketPorts;
  attempts: AttemptLedger;
  lock: Lock;
  appendLine: (path: string, text: string) => Promise<void>;
  logPath: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  lockPollMs?: number;
  signal?: AbortSignal;
  onPhase?: (phase: string) => void;
}

export const appendToFile = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text);
};

/** Tries the lock until it is held or `waitMs` has passed; the holder can be a whole ticket's implementation, so one try is not enough. */
export async function acquireWithin(
  acquire: () => Promise<{ held: boolean }>,
  options: { waitMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<boolean> {
  const deadline = options.now() + options.waitMs;
  for (;;) {
    if ((await acquire()).held) return true;
    if (options.now() + options.pollMs > deadline) return false;
    await options.sleep(options.pollMs);
  }
}

/**
 * Takes the machine lock, picks the workable tickets (leaving out ones a run took inside the retry window, keeping the first `limit`),
 * and works each one at a time through the chain. The lock is released in every case.
 */
export async function optimizeTooling(settings: Settings, deps: Deps): Promise<OptimizeOutput> {
  const runId = randomUUID();
  const acquired = await acquireWithin(() => {
    deps.signal?.throwIfAborted();
    return deps.lock.acquire({ runId, ticket: "optimize_tooling" });
  }, {
    waitMs: deps.lockWaitMs ?? LOCK_WAIT_MS,
    pollMs: deps.lockPollMs ?? LOCK_POLL_MS,
    sleep: deps.sleep,
    now: deps.now,
  });
  if (!acquired) {
    await deps.appendLine(deps.logPath, `${new Date(deps.now()).toISOString()} optimize_tooling: skipped, another run holds the lock\n`);
    return {
      status: "busy",
      eligible: 0,
      recently_taken: [],
      runs: [],
      next: "optimize_tooling is already running on this machine; stood down after waiting for the lock",
    };
  }
  try {
    deps.onPhase?.("reading eligible tickets");
    const offered = await deps.eligible(
      { teams: settings.linear_teams, project: settings.linear_project === "" ? undefined : settings.linear_project, limit: ELIGIBLE_READ },
      deps.signal,
    );
    const recent = await deps.attempts.recent(deps.now(), settings.retry_after_hours * MS_PER_HOUR);
    const recently_taken = offered.filter((ticket) => recent.has(ticket));
    const tickets = offered.filter((ticket) => !recent.has(ticket)).slice(0, settings.limit);
    const runs: TicketRun[] = [];
    for (const ticket of tickets) {
      deps.signal?.throwIfAborted();
      deps.onPhase?.(`working ${ticket}`);
      // Recorded before the work starts: a run that dies partway still counts, so the ticket is not the next pick.
      await deps.attempts.take(ticket, deps.now());
      runs.push(await workTicket(ticket, deps.ports, { apply: settings.apply }));
    }
    return {
      status: runs.length === 0 ? "empty" : "worked",
      eligible: offered.length,
      recently_taken,
      runs,
      next:
        runs.length === 0
          ? offered.length === 0
            ? "no ticket is in a workable status"
            : `every one of the ${offered.length} workable tickets was taken inside the retry window`
          : runs.map((run) => `${run.ticket}: ${run.outcome}`).join("; "),
    };
  } finally {
    await deps.lock.release(runId);
  }
}

export const liveLock = (): Lock => fileLock(lockFile());
export const liveLedger = (): AttemptLedger => fileAttemptLedger(attemptsFile());
