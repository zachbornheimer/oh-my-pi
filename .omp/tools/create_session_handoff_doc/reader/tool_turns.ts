import { TOOL_OUTPUT_HEAD_CHARS } from "./schemas.js";
import type { TranscriptTurn } from "./schemas.js";
import { outputSignalsOf } from "./session_context.js";
import { blockTexts, isRecord } from "./records.js";

/** The `tool` turn of an agent calling `name`. */
export function toolCallTurn(id: string, name: string, input: Readonly<Record<string, unknown>>): TranscriptTurn {
  return { role: "tool", text: "", tool_call: { id, name, input: { ...input } } };
}

/**
 * The `tool` turn of a call's result; the output keeps its first `TOOL_OUTPUT_HEAD_CHARS` characters. An output that was
 * cut carries the `signals` of the whole of it. Only the first `2 * TOOL_OUTPUT_HEAD_CHARS` UTF-16 units are split into
 * characters, so a multi-megabyte output costs one scan, not an array of its characters.
 */
export function toolResultTurn(id: string, output: string, isError: boolean): TranscriptTurn {
  const head = output.length <= TOOL_OUTPUT_HEAD_CHARS
    ? output
    : Array.from(output.slice(0, 2 * TOOL_OUTPUT_HEAD_CHARS)).slice(0, TOOL_OUTPUT_HEAD_CHARS).join("");
  const cut = head.length < output.length;
  return {
    role: "tool",
    text: "",
    tool_result: { id, output: head, is_error: isError, ...(cut ? { signals: outputSignalsOf(output) } : {}) },
  };
}

/** The arguments of a call a harness wrote as a JSON string: an object stays one, anything else is kept under `raw`. */
export function argumentsOf(wire: unknown): Record<string, unknown> {
  if (isRecord(wire)) return { ...wire };
  if (typeof wire !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(wire);
    return isRecord(parsed) ? { ...parsed } : { raw: wire };
  } catch {
    return wire === "" ? {} : { raw: wire };
  }
}

/** The text of a tool result's `content`: a string, or `{type, text}` blocks joined by newlines. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? blockTexts(content).join("\n") : "";
}
