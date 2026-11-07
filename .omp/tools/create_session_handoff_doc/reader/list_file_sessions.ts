import type { HostMachine } from "./host_machine.js";
import { cursorTitles } from "./list_database_sessions.js";
import { isRecord, recordField, stringField } from "./records.js";
import type { JsonRecord } from "./records.js";
import { directoryOf, mapConcurrently } from "./session_source.js";
import type { DatedSession, Session, SessionSource } from "./session_source.js";

const AGENTMUX_TRANSCRIPTS = ".config/agentmux/transcripts";
const JSONL = ".jsonl";
/** Cursor's transcript titles are looked up this many sessions to a query. */
const TITLES_PER_QUERY = 100;
/** The 60 newest Cursor sessions are all a title search reads: every title is a lookup in a database of tens of gigabytes. */
const CURSOR_TITLE_SEARCH_LIMIT = 60;

const home = (machine: HostMachine, relative: string): string => `${machine.homeDirectory}/${relative}`;
const present = <T>(value: T | undefined): value is T => value !== undefined;

/** The first session of each id, so a session listed by its own store wins over agentmux's captured copy of it. */
function distinct(sessions: readonly Session[]): Session[] {
  const byId = new Map<string, Session>();
  for (const session of sessions) if (!byId.has(session.id)) byId.set(session.id, session);
  return [...byId.values()];
}

/** The copies agentmux captured of a harness's sessions, `<agentmux name>.<id>.jsonl`. */
async function capturedSessions(machine: HostMachine, agentmuxName: string): Promise<Session[]> {
  const directory = home(machine, AGENTMUX_TRANSCRIPTS);
  const prefix = `${agentmuxName}.`;
  return (await machine.listDirectory(directory))
    .filter((name) => name.startsWith(prefix) && name.endsWith(JSONL))
    .map((name) => ({ id: name.slice(prefix.length, -JSONL.length), path: `${directory}/${name}` }));
}

/** `<root>/<project>/<subdirectory>/<name>` for every project of `root`; `pick` turns a name into a session or leaves it out. */
async function inProjects(
  machine: HostMachine,
  root: string,
  subdirectory: string,
  pick: (directory: string, name: string) => Session | undefined,
): Promise<Session[]> {
  const base = home(machine, root);
  const perProject = await mapConcurrently(await machine.listDirectory(base), async (project) => {
    const directory = `${base}/${project}${subdirectory}`;
    return (await machine.listDirectory(directory)).map((name) => pick(directory, name));
  });
  return perProject.flat().filter(present);
}

const withoutDescription = async (
  _machine: HostMachine,
  sessions: readonly DatedSession[],
): Promise<DatedSession[]> => [...sessions];

/** The first `count` lines of a file that are JSON objects. */
async function firstRecords(machine: HostMachine, path: string, count: number): Promise<JsonRecord[]> {
  const lines = await machine.readLines(path);
  const records: JsonRecord[] = [];
  if (lines === undefined) return records;
  let read = 0;
  for await (const line of lines) {
    if (++read > count) break;
    try {
      const record: unknown = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // a line that is not JSON holds no title
    }
  }
  return records;
}

/** `~/.claude/projects/<project>/<id>.jsonl`. Claude Code names no session. */
export const claudeSessions: SessionSource = {
  async list(machine) {
    const own = await inProjects(
      machine,
      ".claude/projects",
      "",
      (directory, name) =>
        name.endsWith(JSONL) ? { id: name.slice(0, -JSONL.length), path: `${directory}/${name}` } : undefined,
    );
    return distinct([...own, ...(await capturedSessions(machine, "claude-code"))]);
  },
  describe: withoutDescription,
};

const CODEX_ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** `~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl`. Codex names no session. */
export const codexSessions: SessionSource = {
  async list(machine) {
    const base = home(machine, ".codex/sessions");
    const own: Session[] = [];
    for (const year of await machine.listDirectory(base)) {
      for (const month of await machine.listDirectory(`${base}/${year}`)) {
        for (const day of await machine.listDirectory(`${base}/${year}/${month}`)) {
          const directory = `${base}/${year}/${month}/${day}`;
          for (const name of await machine.listDirectory(directory)) {
            const id = CODEX_ROLLOUT.exec(name)?.[1];
            if (id !== undefined) own.push({ id, path: `${directory}/${name}` });
          }
        }
      }
    }
    return distinct([...own, ...(await capturedSessions(machine, "codex"))]);
  },
  describe: withoutDescription,
};

/** The `summary.json` beside a Grok session's transcript: its title, directory and kind. */
async function grokSummary(machine: HostMachine, session: DatedSession): Promise<DatedSession> {
  const text = await machine.readTextFile(`${directoryOf(session.path)}/summary.json`);
  let summary: JsonRecord = {};
  try {
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    if (isRecord(parsed)) summary = parsed;
  } catch {
    // a summary that does not parse names nothing
  }
  return {
    ...session,
    title: stringField(summary, "generated_title") || stringField(summary, "session_summary"),
    cwd: stringField(recordField(summary, "info") ?? {}, "cwd"),
    subagent: summary.session_kind === "subagent",
  };
}

/** `~/.grok/sessions/<url-encoded cwd>/<id>/chat_history.jsonl`, named and classified by `summary.json`. */
export const grokSessions: SessionSource = {
  async list(machine) {
    const own = await inProjects(
      machine,
      ".grok/sessions",
      "",
      (directory, id) => ({ id, path: `${directory}/${id}/chat_history.jsonl` }),
    );
    return distinct([...own, ...(await capturedSessions(machine, "grok"))]);
  },
  describe: (machine, sessions) => mapConcurrently(sessions, (session) => grokSummary(machine, session)),
};

/** `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`, named by Cursor's own database. */
export const cursorSessions: SessionSource = {
  async list(machine) {
    const own = await inProjects(
      machine,
      ".cursor/projects",
      "/agent-transcripts",
      (directory, id) => ({ id, path: `${directory}/${id}/${id}${JSONL}` }),
    );
    return distinct([...own, ...(await capturedSessions(machine, "cursor"))]);
  },
  async describe(machine, sessions) {
    const titles = new Map<string, string>();
    for (let at = 0; at < sessions.length; at += TITLES_PER_QUERY) {
      const ids = sessions.slice(at, at + TITLES_PER_QUERY).map((session) => session.id);
      for (const [id, title] of await cursorTitles(machine, ids)) titles.set(id, title);
    }
    return sessions.map((session) => ({ ...session, title: titles.get(session.id) ?? "" }));
  },
  titleSearchLimit: CURSOR_TITLE_SEARCH_LIMIT,
};

const YAML_QUOTES = /^(["'])(.*)\1$/;

/** The value of a top-level `key: value` line of a small YAML file. */
function yamlValue(text: string, key: string): string {
  const value = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  return YAML_QUOTES.exec(value)?.[2] ?? value;
}

/** `~/.copilot/session-state/<id>/events.jsonl`, named by the `workspace.yaml` beside it. */
export const copilotSessions: SessionSource = {
  async list(machine) {
    const base = home(machine, ".copilot/session-state");
    return (await machine.listDirectory(base)).map((id) => ({ id, path: `${base}/${id}/events${JSONL}` }));
  },
  describe: (machine, sessions) =>
    mapConcurrently(sessions, async (session) => {
      const workspace = (await machine.readTextFile(`${directoryOf(session.path)}/workspace.yaml`)) ?? "";
      return { ...session, title: yamlValue(workspace, "name"), cwd: yamlValue(workspace, "cwd") };
    }),
};

const TIME_AND_ID = /^[^.].*_([^_/]+)\.jsonl$/;

/** `<root>/<cwd>/<time>_<id>.jsonl` of pi or omp: the `.<name>.lock.os` files and the per-session directories are not sessions. */
function timeAndIdSessions(root: string): SessionSource["list"] {
  return (machine) =>
    inProjects(machine, root, "", (directory, name) => {
      const id = TIME_AND_ID.exec(name)?.[1];
      return id === undefined ? undefined : { id, path: `${directory}/${name}` };
    });
}

/** pi's header holds the session's directory and no title. */
export const piSessions: SessionSource = {
  list: timeAndIdSessions(".pi/agent/sessions"),
  describe: (machine, sessions) =>
    mapConcurrently(sessions, async (session) => {
      const header = (await firstRecords(machine, session.path, 3)).find((record) => record.type === "session");
      return { ...session, cwd: stringField(header ?? {}, "cwd") };
    }),
};

/** omp rewrites a first-line `title` entry in place as it names the session; the `session` header holds the directory. */
export const ompSessions: SessionSource = {
  list: timeAndIdSessions(".omp/agent/sessions"),
  describe: (machine, sessions) =>
    mapConcurrently(sessions, async (session) => {
      const records = await firstRecords(machine, session.path, 3);
      return {
        ...session,
        title: stringField(records.find((record) => record.type === "title") ?? {}, "title").trim(),
        cwd: stringField(records.find((record) => record.type === "session") ?? {}, "cwd"),
      };
    }),
};
