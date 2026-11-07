import { LATEST_SESSION, TITLED_HARNESSES } from "./schemas.js";
import type { Harness } from "./schemas.js";
import type { HostMachine } from "./host_machine.js";
import { hermesSessions, opencodeSessions } from "./list_database_sessions.js";
import {
  claudeSessions,
  codexSessions,
  copilotSessions,
  cursorSessions,
  grokSessions,
  ompSessions,
  piSessions,
} from "./list_file_sessions.js";
import { newestFirst } from "./session_source.js";
import type { DatedSession, SessionSource } from "./session_source.js";

/** How each harness's sessions are listed. `agentmux` names a project, not a session, so only its full id is read. */
const SESSION_SOURCES: Readonly<Partial<Record<Harness, SessionSource>>> = {
  claude: claudeSessions,
  grok: grokSessions,
  codex: codexSessions,
  cursor: cursorSessions,
  copilot: copilotSessions,
  pi: piSessions,
  omp: ompSessions,
  hermes: hermesSessions,
  opencode: opencodeSessions,
};

/** Sessions shown in a list of candidates or of recent sessions. */
export const SESSIONS_SHOWN = 15;
/** Sessions read for their kind at once while looking for the newest top-level one. */
const LATEST_BATCH = 10;

export type SessionSearch =
  | { readonly kind: "found"; readonly session: DatedSession }
  | {
    readonly kind: "ambiguous";
    /** What the sessions have in common, for the message: `start with "x"`. */
    readonly what: string;
    /** At most `SESSIONS_SHOWN` of them, newest first. */
    readonly shown: readonly DatedSession[];
    readonly total: number;
    readonly titled: boolean;
  }
  | {
    /** `recent` is the newest top-level sessions, for the person to choose from; `titled` says whether titles were searched. */
    readonly kind: "none";
    readonly recent: readonly DatedSession[];
    readonly titled: boolean;
  };

export const hasSessionSource = (harness: Harness): boolean => SESSION_SOURCES[harness] !== undefined;

/** The newest sessions that are not a subagent's, kinds read a batch at a time so a long history is not read whole. */
async function newestTopLevel(
  machine: HostMachine,
  source: SessionSource,
  dated: readonly DatedSession[],
  count: number,
): Promise<DatedSession[]> {
  const found: DatedSession[] = [];
  for (let at = 0; at < dated.length && found.length < count; at += LATEST_BATCH) {
    const described = await source.describe(machine, dated.slice(at, at + LATEST_BATCH));
    found.push(...described.filter((session) => session.subagent !== true));
  }
  return found.slice(0, count);
}

/** One session is the answer; any other number is not an answer to pick from, so it is reported as it is. */
function oneOf(
  what: string,
  matches: readonly DatedSession[],
  shown: readonly DatedSession[],
  titled: boolean,
): SessionSearch {
  const [only] = matches;
  return matches.length === 1 && only !== undefined
    ? { kind: "found", session: shown[0] ?? only }
    : { kind: "ambiguous", what, shown, total: matches.length, titled };
}

/**
 * The session of `harness` that `identifier` names, by the rules the assume-session skill's `find-transcript.sh` applied:
 * `latest` is the newest top-level session; otherwise the sessions whose id starts with it, and when none does, for a
 * harness with titles, the top-level sessions whose title contains it, ignoring case. One match is the session; several
 * are ambiguous and are never resolved by picking one. A subagent's session is found by its id, never by `latest` or a title.
 */
export async function searchSessions(
  harness: Harness,
  identifier: string,
  machine: HostMachine,
): Promise<SessionSearch> {
  const source = SESSION_SOURCES[harness];
  if (source === undefined) return { kind: "none", recent: [], titled: false };
  const titled = (TITLED_HARNESSES as readonly string[]).includes(harness);
  const stubs = await source.list(machine);

  if (identifier === LATEST_SESSION) {
    const [newest] = await newestTopLevel(machine, source, await newestFirst(machine, stubs), 1);
    return newest === undefined ? { kind: "none", recent: [], titled } : { kind: "found", session: newest };
  }

  const byId = await newestFirst(machine, stubs.filter((session) => session.id.startsWith(identifier)));
  if (byId.length > 0) {
    const shown = await source.describe(machine, byId.slice(0, SESSIONS_SHOWN));
    return oneOf(`start with "${identifier}"`, byId, shown, titled);
  }

  const all = await newestFirst(machine, stubs);
  if (titled) {
    const needle = identifier.toLowerCase();
    const described = await source.describe(machine, all.slice(0, source.titleSearchLimit ?? all.length));
    const byTitle = described.filter((session) =>
      session.subagent !== true && (session.title ?? "").toLowerCase().includes(needle)
    );
    if (byTitle.length > 0) {
      return oneOf(`have a title containing "${identifier}"`, byTitle, byTitle.slice(0, SESSIONS_SHOWN), titled);
    }
  }
  return { kind: "none", recent: await newestTopLevel(machine, source, all, SESSIONS_SHOWN), titled };
}
