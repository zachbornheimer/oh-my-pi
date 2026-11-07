import { type Infer, z } from "./shape.js";
import { TOOL_OUTPUT_HEAD_CHARS } from "./schemas.js";
import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import type { HostMachine } from "./host_machine.js";
import { isoFromEpochMillis, sessionMetadata, stamped } from "./records.js";
import type { SessionTurns } from "./records.js";
import { assertSafeSessionId, queryRows } from "./sqlite_rows.js";
import { argumentsOf, toolCallTurn, toolResultTurn } from "./tool_turns.js";

const DATABASE = ".local/share/opencode/opencode.db";
const partRow = z.object({
  role: z.string().nullable(),
  /** `text` or `tool`: the part kinds that are read. */
  type: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  /** A tool part's call id, tool name, status and arguments (JSON text). */
  call_id: z.string().nullable().optional(),
  tool: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  input: z.string().nullable().optional(),
  /** What the tool returned, or the error it failed with, cut to its first `TOOL_OUTPUT_HEAD_CHARS`; null when it has not finished. */
  output: z.string().nullable().optional(),
  /** Unix milliseconds the message was created (`message.time_created`). */
  created: z.number().nullable().optional(),
});
const sessionRow = z.object({ id: z.string(), directory: z.string().nullable().optional() });

export function opencodeDatabase(machine: HostMachine): string {
  return `${machine.homeDirectory}/${DATABASE}`;
}

function partTurns(row: Infer<typeof partRow>): TranscriptTurn[] {
  if (row.type === "tool") {
    const id = row.call_id ?? "";
    const call = toolCallTurn(id, row.tool ?? "", argumentsOf(row.input ?? ""));
    const result = row.output === null || row.output === undefined
      ? []
      : [toolResultTurn(id, row.output, row.status === "error")];
    return [call, ...result];
  }
  const text = trimSpace(row.text ?? "");
  return text === "" ? [] : [{ role: row.role === "assistant" ? "agent" : "user", text }];
}

/**
 * The turns of one OpenCode session from its SQLite store (agentmux `transcript.ParseOpenCodeTurns`): the `text` parts
 * of each message in creation order, a user or agent turn by the message's role, and the `tool` parts among them as a
 * call and, once it finished, its result (an error's message is the output of a result that is an error). Reasoning, step
 * and patch parts are not conversation. Only those parts are selected, and a tool's output only to its first
 * `TOOL_OUTPUT_HEAD_CHARS` characters, which keeps the output small for a session with large tool output. The session's
 * `directory` is its cwd. Returns undefined when the database has no such session.
 */
export async function opencodeTurns(id: string, machine: HostMachine): Promise<SessionTurns | undefined> {
  assertSafeSessionId(id);
  const database = opencodeDatabase(machine);
  const [known] = await queryRows(
    machine,
    database,
    "SELECT id, directory FROM session WHERE id = ?",
    sessionRow,
    [id],
  );
  if (known === undefined) return undefined;
  const rows = await queryRows(
    machine,
    database,
    `SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS type, `
      + `json_extract(p.data, '$.text') AS text, json_extract(p.data, '$.callID') AS call_id, `
      + `json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.state.status') AS status, `
      + `json_extract(p.data, '$.state.input') AS input, `
      + `CASE WHEN json_type(p.data, '$.state.output') = 'text' THEN substr(json_extract(p.data, '$.state.output'), 1, ${TOOL_OUTPUT_HEAD_CHARS}) `
      + `WHEN json_type(p.data, '$.state.error') = 'text' THEN substr(json_extract(p.data, '$.state.error'), 1, ${TOOL_OUTPUT_HEAD_CHARS}) END AS output, `
      + `m.time_created AS created `
      + `FROM part p JOIN message m ON m.id = p.message_id `
      + `WHERE p.session_id = ? AND json_extract(p.data, '$.type') IN ('text', 'tool') `
      + `ORDER BY m.time_created, m.id, p.time_created, p.id`,
    partRow,
    [id],
  );
  const turns = rows.flatMap((row) => partTurns(row).map((turn) => stamped(turn, isoFromEpochMillis(row.created))));
  return { turns, metadata: sessionMetadata(known.directory, undefined) };
}
