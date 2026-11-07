import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import { blockTexts, isRecord, recordField, sessionMetadata, stringField, unwrapUserQuery } from "./records.js";
import type { RecordMetadata, RecordParser } from "./records.js";
import { argumentsOf, toolCallTurn } from "./tool_turns.js";

/** The wrappers Cursor puts its own metadata in at the start of a user message. */
const SYSTEM_TAGS = "plugin_info|user_info|system_notification|additional_data";
const SYSTEM_LEAD = new RegExp(`^\\s*<(?:${SYSTEM_TAGS})`, "i");
const SYSTEM_BLOCK = new RegExp(`<(?:${SYSTEM_TAGS})[^>]*>[\\s\\S]*?</(?:${SYSTEM_TAGS})>`, "gi");
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const TIMESTAMP_TAG = /<timestamp>[^<]*<\/timestamp>/g;
const WORKSPACE_PATH = /Workspace Path:[ \t]*(.+)/;

/**
 * A user message with Cursor's system-injection wrappers removed (read-transcript.py `_strip_cursor_system_injection`):
 * the `<user_query>` content when there is one, else the text without its system blocks and `<timestamp>` tags.
 * `undefined` when nothing real remains. Text that does not begin with a system tag is returned as it is, so prose
 * with an incidental tag in it passes through.
 */
export function stripCursorSystemInjection(text: string): string | undefined {
  if (!SYSTEM_LEAD.test(text)) return text;
  const query = USER_QUERY.exec(text);
  const cleaned = query === null
    ? trimSpace(text.replace(SYSTEM_BLOCK, "").replace(TIMESTAMP_TAG, ""))
    : trimSpace(query[1] ?? "");
  return cleaned === "" ? undefined : cleaned;
}

/** The directory Cursor's `<user_info>` block names after `Workspace Path:`; `undefined` when the text has none. */
export function cursorWorkspacePath(text: string): string | undefined {
  const path = trimSpace(WORKSPACE_PATH.exec(text)?.[1] ?? "");
  return path === "" ? undefined : path;
}

/** The ask a user message holds: system wrappers stripped, `<user_query>` unwrapped; `""` when there is none. */
export function cursorUserAsk(text: string): string {
  const stripped = stripCursorSystemInjection(text);
  return stripped === undefined ? "" : unwrapUserQuery(stripped);
}

/** The text of a message `content`: a string, or the `text` blocks joined by newlines. */
export function cursorContentText(content: unknown): string {
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? blockTexts(content, "text") : [];
  return trimSpace(texts.join("\n"));
}

/**
 * An assistant message's `tool_use` blocks as calls. Cursor transcripts carry no result for a call and often no id, so
 * a call without one is named `<tool>#<position in the message>`.
 */
function toolCalls(content: unknown): TranscriptTurn[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, position) => {
    if (!isRecord(block) || block.type !== "tool_use") return [];
    const name = stringField(block, "name");
    return [toolCallTurn(stringField(block, "id") || `${name}#${position}`, name, argumentsOf(block.input))];
  });
}

/**
 * Cursor agent transcript, `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`: one record per message,
 * `{role, message: {content}}` with content a string or `{type, text}` blocks. A user message wraps the ask in
 * `<user_query>` after a `<timestamp>` line, and Cursor's own `<user_info>`-style blocks are not the person's words; the
 * ask is what is kept. An assistant message's `tool_use` blocks are tool calls; status records are skipped.
 * agentmux has no Cursor turn parser, so this one follows the same rules as its Grok one.
 */
export const cursorRecordTurns: RecordParser = (record) => {
  const role = stringField(record, "role");
  if (role !== "user" && role !== "assistant") return [];
  const message = recordField(record, "message");
  if (message === undefined) return [];
  const text = cursorContentText(message.content);
  if (role === "assistant") {
    return [...(text === "" ? [] : [{ role: "agent" as const, text }]), ...toolCalls(message.content)];
  }
  const ask = cursorUserAsk(text);
  return ask === "" ? [] : [{ role: "user", text: ask }];
};

/** Cursor records no cwd of its own; the `Workspace Path:` line of the `<user_info>` block in a user message is all there is. */
export const cursorRecordMetadata: RecordMetadata = (record) => {
  if (stringField(record, "role") !== "user") return {};
  const content = recordField(record, "message")?.content;
  return sessionMetadata(cursorWorkspacePath(cursorContentText(content)), undefined);
};
