// The transcript record a session export carries, and how a source becomes one.
//
// A session export is the document the annotator reads: the user's items and the agent's response items, turn by turn.
// Copied from `@zab-ai/ai`'s `transcript.ts` with the schema library replaced by plain types and a hand check.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { conversationRefOf } from "./reader/conversation_ref.js";
import { COMPACTION_SUMMARY } from "./reader/schemas.js";
import type { TranscriptTurn } from "./reader/schemas.js";
import type { TurnSource } from "./reader/turn_source.js";

/** A transcript path, or `<harness>:<id>` such as `omp:2ed0c871-…`. */
export type Source = string;

export type Format = "default" | "raw";
export const FORMATS: readonly Format[] = ["default", "raw"];

/** The forensics reading of one item of a session. */
export interface Annotation {
  happened: string;
  cost?: string;
  waste?: string;
  /** A user item that corrected the agent's course. */
  correction: boolean;
  /** The tokens the item's model call used. Absent: the transcript records no usage for the item. */
  tokens?: { in: number; out: number; cache_read: number; cache_write: number };
  /** The item's estimated USD at the local price table. Absent when no usage was recorded, or its model has no price row. */
  est_usd?: number;
}

/** One item of a session export, as the harness wrote it (every other key kept), with its reading once annotated. */
export interface Item {
  id: number | string;
  annotation?: Annotation;
  [key: string]: unknown;
}

export interface ExportTurn {
  user?: Item[];
  response?: Item[];
  [key: string]: unknown;
}

/** The same document before and after annotation; annotation adds `annotation` to every item and nothing else. */
export interface SessionExport {
  /** `<harness>:<id>` */
  conversation: string;
  source?: string;
  turns: ExportTurn[];
  [key: string]: unknown;
}

/** Every item of the export in session order: each turn's user items, then its response items. */
export const itemsOf = (session: SessionExport): Item[] =>
  session.turns.flatMap((turn) => [...(turn.user ?? []), ...(turn.response ?? [])]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `value` is not a session export, or undefined when it is one. */
export function exportProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "the document is not an object";
  if (typeof value.conversation !== "string") return "`conversation` must be a string";
  if (value.source !== undefined && typeof value.source !== "string") return "`source` must be a string";
  if (!Array.isArray(value.turns)) return "`turns` must be an array";
  for (const [index, turn] of value.turns.entries()) {
    if (!isObject(turn)) return `turns[${index}] is not an object`;
    for (const side of ["user", "response"] as const) {
      const items = turn[side];
      if (items === undefined) continue;
      if (!Array.isArray(items)) return `turns[${index}].${side} must be an array`;
      for (const [at, item] of items.entries()) {
        if (!isObject(item) || (typeof item.id !== "number" && typeof item.id !== "string")) {
          return `turns[${index}].${side}[${at}] needs an \`id\` that is a number or a string`;
        }
      }
    }
  }
  return undefined;
}

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
type RecordedUsage = { input: number; output: number; cache_read: number; cache_write: number; model?: string };
type AgentItem = {
  id: number;
  source: "agent";
  timestamp?: number;
  text: string;
  tool_calls: ToolCall[];
  usage?: RecordedUsage;
};
type SystemItem = {
  id: number;
  source: "system";
  timestamp?: number;
  tool_call_id?: string;
  synthetic_reason?: string;
  text?: string;
  content: string;
  is_error?: true;
};
type BuiltTurn = { user: { id: number; timestamp?: number; text: string }[]; response: (AgentItem | SystemItem)[] };

const epoch = (turn: TranscriptTurn): { timestamp?: number } => {
  if (turn.timestamp === undefined) return {};
  const parsed = Date.parse(turn.timestamp);
  return Number.isNaN(parsed) ? {} : { timestamp: parsed / 1000 };
};

/**
 * The turns as a session export: a person's text opens a turn; an agent's text is an item that takes the tool calls
 * after it; a tool's result is a system item and closes the agent's item. Timestamps are Unix seconds.
 */
export function exportOf(conversation: string, source: string, turns: readonly TranscriptTurn[]): SessionExport {
  const out: BuiltTurn[] = [];
  let id = 0;
  let open: AgentItem | undefined;
  const current = (): BuiltTurn => {
    if (out.length === 0) out.push({ user: [], response: [] });
    return out[out.length - 1]!;
  };
  /** A harness repeats a message's usage on every record of it; the last one carries the final counts. */
  const latestUsage = new Map<string, RecordedUsage>();
  for (const turn of turns) {
    if (turn.usage !== undefined && turn.message_id !== undefined) latestUsage.set(turn.message_id, turn.usage);
  }
  const attached = new Set<string>();
  /** A message's usage goes on its first item only, so a message is never billed twice. */
  const usageOf = (turn: TranscriptTurn): { usage?: RecordedUsage } => {
    const key = turn.message_id;
    const recorded = key === undefined ? turn.usage : latestUsage.get(key);
    if (recorded === undefined || (key !== undefined && attached.has(key))) return {};
    if (key !== undefined) attached.add(key);
    return { usage: recorded };
  };
  for (const turn of turns) {
    if (turn.role === "user") {
      out.push({ user: [{ id: ++id, ...epoch(turn), text: turn.text }], response: [] });
      open = undefined;
    } else if (turn.role === "agent") {
      open = { id: ++id, source: "agent", ...epoch(turn), text: turn.text, tool_calls: [], ...usageOf(turn) };
      current().response.push(open);
    } else if (turn.tool_call !== undefined) {
      if (open === undefined) {
        open = { id: ++id, source: "agent", ...epoch(turn), text: "", tool_calls: [], ...usageOf(turn) };
        current().response.push(open);
      }
      open.tool_calls.push({ id: turn.tool_call.id, name: turn.tool_call.name, arguments: turn.tool_call.input });
    } else if (turn.tool_result !== undefined) {
      const { id: tool_call_id, output: content, is_error } = turn.tool_result;
      current().response.push({
        id: ++id,
        source: "system",
        ...epoch(turn),
        tool_call_id,
        content,
        ...(is_error ? { is_error: true } : {}),
      });
      open = undefined;
    } else if (turn.role === "context" && turn.synthetic_reason === COMPACTION_SUMMARY) {
      current().response.push({
        id: ++id,
        source: "system",
        ...epoch(turn),
        synthetic_reason: COMPACTION_SUMMARY,
        text: turn.text,
        content: turn.text,
      });
      open = undefined;
    }
  }
  return { conversation, source, turns: out as unknown as ExportTurn[] };
}

/**
 * Resolve a source to a session export: a session-export `.json` path parses as it is, an omp session file or
 * `omp:<id>` reads natively, and any other conversation ref goes through the transcript source.
 */
export async function loadTranscript(
  source: Source,
  transcripts: TurnSource,
  home: string = homedir(),
): Promise<SessionExport> {
  if (await isFile(source)) {
    if (source.endsWith(".json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(source, "utf8"));
      } catch (error) {
        throw new Error(`${source} is not a session export: ${(error as Error).message}`);
      }
      const problem = exportProblem(parsed);
      if (problem !== undefined) throw new Error(`${source} is not a session export: ${problem}`);
      return parsed as SessionExport;
    }
    return exportOf(source, source, ompTurnsOf(await readFile(source, "utf8")));
  }
  const ompId = ompIdOf(source);
  if (ompId !== undefined) {
    const file = await findOmpSession(ompId, home);
    return exportOf(`omp:${ompId}`, file, ompTurnsOf(await readFile(file, "utf8")));
  }
  const ref = conversationRefOf(source);
  const transcript = await transcripts.readTurns(ref, { toolCalls: true });
  return exportOf(transcript.conversation ?? ref, transcript.path, transcript.turns);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The omp session id a source names: `omp:<id>` or a bare session id; `undefined` for anything else. */
function ompIdOf(source: string): string | undefined {
  const ref = source.startsWith("omp:") ? source.slice("omp:".length) : source;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref) ? ref : undefined;
}

/** The omp session file of an id under this machine's omp sessions dir. */
async function findOmpSession(id: string, home: string = homedir()): Promise<string> {
  const root = join(home, ".omp", "agent", "sessions");
  for (const project of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, project)).catch(() => [] as string[])) {
      if (name.endsWith(`_${id}.jsonl`)) return join(root, project, name);
    }
  }
  throw new Error(`omp:${id}: no session file under ${root}`);
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** The usage an omp assistant message records (`usage.{input,output,cacheRead,cacheWrite}`, `model`), when it records one. */
function ompUsageOf(message: Record<string, unknown>): RecordedUsage | undefined {
  const usage = message.usage;
  if (!isObject(usage) || (typeof usage.input !== "number" && typeof usage.output !== "number")) return undefined;
  return {
    input: numberOf(usage.input),
    output: numberOf(usage.output),
    cache_read: numberOf(usage.cacheRead),
    cache_write: numberOf(usage.cacheWrite),
    ...(typeof message.model === "string" && message.model !== "" ? { model: message.model } : {}),
  };
}

/**
 * One omp session file as normalized turns: user and agent text blocks become turns, `toolCall` blocks and
 * `toolResult` messages become tool turns (joined by `toolCallId`), the session's own bookkeeping is not emitted. An
 * assistant message's recorded usage rides on its turns so the annotator can read it.
 */
export function ompTurnsOf(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: { type?: unknown; id?: unknown; message?: Record<string, unknown>; timestamp?: unknown };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const role = message.role;
    if (role === "toolResult") {
      turns.push({
        role: "tool",
        text: blockTextOf(message.content),
        ...(timestamp === undefined ? {} : { timestamp }),
        tool_result: {
          id: typeof message.toolCallId === "string" ? message.toolCallId : "",
          output: blockTextOf(message.content),
          is_error: message.isError === true,
        },
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const usage = role === "assistant" ? ompUsageOf(message) : undefined;
    const messageId = typeof entry.id === "string" ? entry.id : undefined;
    const carried = {
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(usage === undefined || messageId === undefined ? {} : { usage, message_id: messageId }),
    };
    const blocks = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
    for (const block of blocks) {
      const typed = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim() !== "") {
        turns.push({ role: role === "assistant" ? "agent" : "user", text: typed.text.trim(), ...carried });
      } else if (typed.type === "toolCall") {
        turns.push({
          role: "tool",
          text: "",
          ...carried,
          tool_call: {
            id: typeof typed.id === "string" ? typed.id : "",
            name: typeof typed.name === "string" ? typed.name : "",
            input: (isObject(typed.arguments) ? typed.arguments : {}) as Record<string, unknown>,
          },
        });
      }
    }
  }
  return turns;
}

function blockTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .join("\n")
    .trim();
}
