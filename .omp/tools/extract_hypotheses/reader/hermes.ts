import { type Infer, z } from "./shape.js";
import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import type { HostMachine } from "./host_machine.js";
import { isoFromEpochSeconds, isRecord, sessionMetadata, stamped, stringField } from "./records.js";
import type { SessionTurns } from "./records.js";
import { assertSafeSessionId, queryRows } from "./sqlite_rows.js";
import { argumentsOf, toolCallTurn, toolResultTurn } from "./tool_turns.js";

const DATABASE = ".hermes/state.db";
const messageRow = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().nullable().optional(),
  tool_call_id: z.string().nullable().optional(),
  tool_calls: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  /** Unix seconds (a REAL) the row was written. */
  timestamp: z.number().nullable().optional(),
});
const sessionRow = z.object({
  id: z.string(),
  cwd: z.string().nullable().optional(),
  git_branch: z.string().nullable().optional(),
});

export function hermesDatabase(machine: HostMachine): string {
  return `${machine.homeDirectory}/${DATABASE}`;
}

function hermesToolCalls(wire: string | null | undefined): TranscriptTurn[] {
  if (wire === undefined || wire === null || wire === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((call) => {
    if (!isRecord(call)) return [];
    const fn = isRecord(call.function) ? call.function : call;
    const id = stringField(call, "id") || stringField(call, "call_id");
    const name = stringField(fn, "name") || stringField(call, "name");
    if (id === "" && name === "") return [];
    return [toolCallTurn(id, name, argumentsOf(fn.arguments ?? call.arguments))];
  });
}

function turnsOfRow(row: Infer<typeof messageRow>): TranscriptTurn[] {
  const at = isoFromEpochSeconds(row.timestamp);
  return rowTurns(row).map((turn) => stamped(turn, at));
}

function rowTurns(row: Infer<typeof messageRow>): TranscriptTurn[] {
  if (row.role === "tool") {
    const id = row.tool_call_id ?? "";
    return [toolResultTurn(id, row.content ?? "", false)];
  }
  const text = trimSpace(row.content ?? "");
  const calls = hermesToolCalls(row.tool_calls);
  const spoken: TranscriptTurn[] = text === "" ? [] : [{ role: row.role === "user" ? "user" : "agent", text }];
  return [...spoken, ...calls];
}

/**
 * The turns of one Hermes session from its `state.db`: active user, assistant and tool rows in insertion order, and the
 * `cwd` and `git_branch` its `sessions` row recorded. Hidden, failed and display-only rows are not conversation. Tool
 * calls are kept; `readTranscript` drops them unless `toolCalls` is set. Returns undefined when the database has no
 * such session.
 */
export async function hermesTurns(id: string, machine: HostMachine): Promise<SessionTurns | undefined> {
  assertSafeSessionId(id);
  const database = hermesDatabase(machine);
  const [known] = await queryRows(
    machine,
    database,
    "SELECT id, cwd, git_branch FROM sessions WHERE id = ?",
    sessionRow,
    [id],
  );
  if (known === undefined) return undefined;
  const rows = await queryRows(
    machine,
    database,
    "SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp FROM messages WHERE session_id = ? AND active = 1 "
      + "AND ((role IN ('user', 'assistant') AND (display_kind IS NULL OR display_kind = '')) OR role = 'tool') "
      + "ORDER BY id",
    messageRow,
    [id],
  );
  return { turns: rows.flatMap(turnsOfRow), metadata: sessionMetadata(known.cwd, known.git_branch) };
}
