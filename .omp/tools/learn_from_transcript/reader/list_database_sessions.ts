import { type Infer, z } from "./shape.js";
import type { HostMachine } from "./host_machine.js";
import { hermesDatabase } from "./hermes.js";
import { opencodeDatabase } from "./opencode.js";
import type { DatedSession, SessionSource } from "./session_source.js";
import { isSafeSessionId, queryRows } from "./sqlite_rows.js";

const CURSOR_STATE_DATABASE = "Library/Application Support/Cursor/User/globalStorage/state.vscdb";

const hermesRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  /** Unix seconds (a REAL) of the last activity, else of the start. */
  at: z.number(),
});

const opencodeRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  directory: z.string().nullable(),
  /** Unix milliseconds the session last changed. */
  updated: z.number(),
  /** Set on a session a task tool started for another session. */
  parent_id: z.string().nullable(),
});

/** Hermes keeps every session, with its title, in one table of `state.db`; nothing there marks a subagent. */
export const hermesSessions: SessionSource = {
  async list(machine) {
    const path = hermesDatabase(machine);
    const rows = await queryRows(
      machine,
      path,
      "SELECT id, title, cwd, COALESCE(last_activity_at, started_at) AS at FROM sessions",
      hermesRow,
    );
    return rows.map((row): DatedSession => ({
      id: row.id,
      path,
      modifiedMs: Math.trunc(row.at * 1000),
      title: row.title ?? "",
      cwd: row.cwd ?? "",
      subagent: false,
    }));
  },
  describe: async (_machine, sessions) => [...sessions],
};

/** OpenCode keeps every session, with its title, in one table of `opencode.db`; a session with a `parent_id` is a subagent's. */
export const opencodeSessions: SessionSource = {
  async list(machine) {
    const path = opencodeDatabase(machine);
    const rows = await queryRows(
      machine,
      path,
      "SELECT id, title, directory, time_updated AS updated, parent_id FROM session",
      opencodeRow,
    );
    return rows.map((row): DatedSession => ({
      id: row.id,
      path,
      modifiedMs: row.updated,
      title: row.title ?? "",
      cwd: row.directory ?? "",
      subagent: row.parent_id !== null,
    }));
  },
  describe: async (_machine, sessions) => [...sessions],
};

const cursorTitleRow = z.object({ key: z.string(), name: z.string().nullable() });
const COMPOSER_KEY = "composerData:";

/**
 * What Cursor calls each composer: `composerData:<id>`'s `name` in the editor's `state.vscdb`, found by exact keys, one
 * query for all of `ids`; never a scan of the database's values, which is tens of gigabytes. A machine with no Cursor
 * database has no titles.
 */
export async function cursorTitles(machine: HostMachine, ids: readonly string[]): Promise<Map<string, string>> {
  const database = `${machine.homeDirectory}/${CURSOR_STATE_DATABASE}`;
  const safe = ids.filter(isSafeSessionId);
  if (safe.length === 0 || !(await machine.isFile(database))) return new Map();
  const keys = safe.map((id) => `'${COMPOSER_KEY}${id}'`).join(", ");
  const rows = await queryRows(
    machine,
    database,
    `SELECT key, json_extract(value, '$.name') AS name FROM cursorDiskKV WHERE key IN (${keys})`,
    cursorTitleRow,
  );
  return new Map(
    rows.flatMap((row) => (row.name === null ? [] : [[row.key.slice(COMPOSER_KEY.length), row.name] as const])),
  );
}
