import type { HostMachine } from "./host_machine.js";

/**
 * One session of a harness, as much of it as is known. Listing costs a directory read; what a session is called and
 * whether it is a subagent's costs a read of a file or a query, so those arrive only through `SessionSource.describe`.
 */
export interface Session {
  readonly id: string;
  /** The file or database the session's transcript is read from; its modified time is the session's. */
  readonly path: string;
  readonly modifiedMs?: number;
  readonly title?: string;
  readonly cwd?: string;
  /** A session a harness started for another session. It is never the answer to `latest` or a title search. */
  readonly subagent?: boolean;
}

/** A `Session` whose modified time is known. */
export interface DatedSession extends Session {
  readonly modifiedMs: number;
}

/** How a harness's sessions are enumerated. */
export interface SessionSource {
  /** Every session of the harness, in no order, with at most what listing a directory (or one query) tells. */
  list(machine: HostMachine): Promise<Session[]>;
  /** `sessions` with their title, cwd and subagent flag read; a session the harness records none for is returned as it is. */
  describe(machine: HostMachine, sessions: readonly DatedSession[]): Promise<DatedSession[]>;
  /** A title search reads the titles of this many of the newest sessions; every session when absent. */
  readonly titleSearchLimit?: number;
}

/** Reads of files at once: enough to hide the latency, few enough to stay inside the open-file limit. */
export const READS_AT_ONCE = 64;

/** `work` over `items`, `READS_AT_ONCE` in flight, results in the order of `items`. */
export async function mapConcurrently<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) results[at] = await work(items[at] as T);
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, worker));
  return results;
}

/** The sessions whose file exists, with its modified time, newest first. A session with no file is not a session. */
export async function newestFirst(machine: HostMachine, sessions: readonly Session[]): Promise<DatedSession[]> {
  const dated = await mapConcurrently(sessions, async (session) => {
    const modifiedMs = session.modifiedMs ?? (await machine.modifiedAtMs(session.path));
    return modifiedMs === undefined ? undefined : { ...session, modifiedMs };
  });
  return dated.filter((session): session is DatedSession => session !== undefined).sort((a, b) =>
    b.modifiedMs - a.modifiedMs
  );
}

/** The directory of a path. */
export const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
