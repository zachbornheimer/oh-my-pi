import { LATEST_SESSION, SESSION_IDENTIFIER } from "./schemas.js";
import type { Harness, Transcript } from "./schemas.js";
import type { HostMachine } from "./host_machine.js";
import { agentmuxProjectRecordTurns } from "./agentmux_project.js";
import { claudeRecordMetadata, claudeRecordTurns } from "./claude.js";
import { codexRecordMetadata, codexRecordTurns } from "./codex.js";
import { copilotRecordMetadata, copilotRecordTurns } from "./copilot.js";
import { cursorRecordMetadata, cursorRecordTurns } from "./cursor.js";
import { cursorLegacyTranscript } from "./cursor_legacy.js";
import { hasSessionSource, searchSessions } from "./find_session.js";
import { grokCompactionTurns, grokRecordTurns, grokSummaryMetadata } from "./grok.js";
import { hermesDatabase, hermesTurns } from "./hermes.js";
import { jsonlTurns } from "./jsonl_turns.js";
import type { JsonlHarness } from "./locate.js";
import { grokSessionDirectory, isJsonlHarness, locateCursorLegacyStore, locateJsonl } from "./locate.js";
import { opencodeDatabase, opencodeTurns } from "./opencode.js";
import { piRecordMetadata, piRecordTurns } from "./pi.js";
import { mergeMetadata, metadataEntry } from "./records.js";
import type { RecordMetadata, RecordParser, SessionTurns } from "./records.js";
import type { DatedSession } from "./session_source.js";
import { isSafeSessionId } from "./sqlite_rows.js";

const RECORD_PARSERS: Readonly<Record<JsonlHarness, RecordParser>> = {
  claude: claudeRecordTurns,
  grok: grokRecordTurns,
  codex: codexRecordTurns,
  cursor: cursorRecordTurns,
  agentmux: agentmuxProjectRecordTurns,
  copilot: copilotRecordTurns,
  pi: piRecordTurns,
  omp: piRecordTurns,
};

/** What each harness's records say about where the session ran; the agentmux project transcript says nothing, and Grok keeps it in `summary.json`. */
const RECORD_METADATA: Readonly<Partial<Record<JsonlHarness, RecordMetadata>>> = {
  claude: claudeRecordMetadata,
  codex: codexRecordMetadata,
  cursor: cursorRecordMetadata,
  copilot: copilotRecordMetadata,
  pi: piRecordMetadata,
  omp: piRecordMetadata,
};

/** No transcript for a ref: the one failure of reading by id that searching by prefix or title may still answer. */
class TranscriptNotFound extends Error {}

function notFound(conversation: string, tried: readonly string[], why = "no transcript found"): TranscriptNotFound {
  return new TranscriptNotFound(`transcript: ${why} for ${conversation}; tried ${tried.join(", ")}`);
}

/**
 * Grok's own record of the session: where `summary.json` says it ran and, when `transcript` is Grok's own
 * `chat_history.jsonl`, the summaries of the turns it compacted away. That file holds only the live tail after a
 * compaction; agentmux's captured copy still holds every turn, so the summaries would only repeat them.
 */
async function grokSessionRecord(id: string, transcript: string, machine: HostMachine): Promise<SessionTurns> {
  const directory = await grokSessionDirectory(id, machine);
  if (directory === undefined) return { turns: [], metadata: {} };
  const liveTailOnly = transcript === `${directory}/chat_history.jsonl`;
  return {
    turns: liveTailOnly ? await grokCompactionTurns(directory, machine) : [],
    metadata: await grokSummaryMetadata(directory, machine),
  };
}

async function readJsonl(
  harness: JsonlHarness,
  id: string,
  conversation: string,
  machine: HostMachine,
): Promise<Transcript> {
  const located = await locateJsonl(harness, id, machine);
  const lines = located.path === undefined ? undefined : await machine.readLines(located.path);
  if (located.path === undefined || lines === undefined) {
    if (harness !== "cursor" || located.path !== undefined) throw notFound(conversation, located.tried);
    const legacy = await locateCursorLegacyStore(id, machine);
    if (legacy.path === undefined) throw notFound(conversation, [...located.tried, ...legacy.tried]);
    return cursorLegacyTranscript(legacy.path, machine);
  }
  const read = await jsonlTurns(lines, RECORD_PARSERS[harness], RECORD_METADATA[harness]);
  const own = harness === "grok" ? await grokSessionRecord(id, located.path, machine) : { turns: [], metadata: {} };
  return {
    path: located.path,
    turns: [...own.turns, ...read.turns],
    skipped_lines: read.skippedLines,
    ...metadataEntry(mergeMetadata(read.metadata, own.metadata)),
  };
}

async function readDatabase(
  database: string,
  session: Promise<SessionTurns | undefined>,
  conversation: string,
): Promise<Transcript> {
  const found = await session;
  if (found === undefined) throw notFound(conversation, [database], "no session in the database");
  return { path: database, turns: found.turns, skipped_lines: 0, ...metadataEntry(found.metadata) };
}

export interface ReadOptions {
  /** Keep the `tool` turns (calls and results). Off, the turns are only what a conversation reads. */
  readonly toolCalls?: boolean;
}

/** `transcript` with its `tool` turns left out unless `options.toolCalls` is set; a conversation never reads them. */
export function applyReadOptions(transcript: Transcript, options: ReadOptions): Transcript {
  if (options.toolCalls === true) return transcript;
  return { ...transcript, turns: transcript.turns.filter((turn) => turn.role !== "tool") };
}

async function readAllTurns(harness: Harness, id: string, machine: HostMachine): Promise<Transcript> {
  const conversation = `${harness}:${id}`;
  if (isJsonlHarness(harness)) return readJsonl(harness, id, conversation, machine);
  if (harness === "hermes") return readDatabase(hermesDatabase(machine), hermesTurns(id, machine), conversation);
  return readDatabase(opencodeDatabase(machine), opencodeTurns(id, machine), conversation);
}

/** `<id>  2026-10-21T21:31Z  <title>  (<cwd>)`: one session in a list the person chooses from. */
function sessionLine(session: DatedSession, titled: boolean): string {
  const time = new Date(session.modifiedMs).toISOString().slice(0, 16);
  const title = (session.title ?? "") === "" ? (titled ? "(untitled)" : "") : session.title;
  return `  ${session.id}  ${time}Z${title === "" ? "" : `  ${title}`}${
    (session.cwd ?? "") === "" ? "" : `  (${session.cwd})`
  }`;
}

/** The session `identifier` names when it is not a full id: its prefix, `latest`, or its title. Throws, listing the candidates, when it names none or several. */
async function resolveSession(
  harness: Harness,
  identifier: string,
  machine: HostMachine,
  missing: Error | undefined,
): Promise<string> {
  const conversation = `${harness}:${identifier}`;
  if (!hasSessionSource(harness)) {
    throw missing ?? new Error(`transcript: ${conversation} cannot be searched; ${harness} refs take one full id`);
  }
  const search = await searchSessions(harness, identifier, machine);
  if (search.kind === "found") return search.session.id;
  if (search.kind === "ambiguous") {
    const more = search.total > search.shown.length ? `\n  … and ${search.total - search.shown.length} older` : "";
    throw new Error(
      `transcript: ${search.total} sessions ${search.what} for ${conversation}; use the full id of one:\n${
        search.shown.map((session) => sessionLine(session, search.titled)).join("\n")
      }${more}`,
    );
  }
  const what = identifier === LATEST_SESSION
    ? `no top-level ${harness} session to take as the latest`
    : `no ${harness} session id starts with "${identifier}"${
      search.titled ? " and no top-level session's title contains it" : ""
    }`;
  const recent = search.recent.length === 0
    ? ""
    : `\nRecent sessions:\n${search.recent.map((session) => sessionLine(session, search.titled)).join("\n")}`;
  throw new TranscriptNotFound(
    `${missing?.message ?? `transcript: no transcript found for ${conversation}`}; ${what}${recent}`,
  );
}

/**
 * Reads the transcript of `<harness>:<identifier>` from this machine into normalized turns, oldest first. The identifier
 * is a full session id; failing that the start of one, `latest` (the newest top-level session), or for a harness with
 * titles, words of the title (`find_session.ts`). A session found that way is named in the result's `conversation`.
 * Tool calls and their results are kept only when `options.toolCalls` is set; a conversation never reads them.
 */
export async function readTranscript(
  harness: Harness,
  identifier: string,
  machine: HostMachine,
  options: ReadOptions = {},
): Promise<Transcript> {
  if (!SESSION_IDENTIFIER.test(identifier)) {
    throw new Error(
      `transcript: session identifier "${identifier}" is empty, has a character that is not allowed, or starts or ends with a space`,
    );
  }
  let missing: TranscriptNotFound | undefined;
  if (identifier !== LATEST_SESSION && isSafeSessionId(identifier)) {
    try {
      return applyReadOptions(await readAllTurns(harness, identifier, machine), options);
    } catch (error) {
      if (!(error instanceof TranscriptNotFound)) throw error;
      missing = error;
    }
  }
  const id = await resolveSession(harness, identifier, machine, missing);
  const transcript = await readAllTurns(harness, id, machine);
  return applyReadOptions({ ...transcript, conversation: `${harness}:${id}` }, options);
}
