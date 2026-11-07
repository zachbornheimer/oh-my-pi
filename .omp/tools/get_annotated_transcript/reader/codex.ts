import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import { blockTexts, isRecord, recordField, sessionMetadata, stringField, withRecordTimestamp } from "./records.js";
import type { JsonRecord, RecordMetadata, RecordParser } from "./records.js";
import { argumentsOf, resultText, toolCallTurn, toolResultTurn } from "./tool_turns.js";

const AGENTS_INSTRUCTIONS_HEADING = "# AGENTS.md instructions";

/** The session-start AGENTS.md block Codex sends as a user message (agentmux `codexMessageTurn`). */
function isAgentsInstructions(text: string): boolean {
  return text.startsWith(AGENTS_INSTRUCTIONS_HEADING) && text.includes("<INSTRUCTIONS>")
    && text.includes("</INSTRUCTIONS>");
}

/** agentmux `codexOutputFailed`: output a tool wrote to say it failed. */
const FAILED_OUTPUT_PREFIX = /^(?:script failed|tool failed|error:)/i;

/**
 * A function call's output is plain text, or a JSON document `{output, metadata: {exit_code}}`: the text and whether
 * the call failed (a non-zero exit code, or a failure prefix).
 */
function callOutput(wire: unknown): { readonly text: string; readonly failed: boolean } {
  const raw = typeof wire === "string" ? wire : resultText(wire);
  let text = raw;
  let exitCode = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.output === "string") {
      text = parsed.output;
      const metadata = recordField(parsed, "metadata");
      exitCode = typeof metadata?.exit_code === "number" ? metadata.exit_code : 0;
    }
  } catch {
    // plain text output
  }
  return { text, failed: exitCode !== 0 || FAILED_OUTPUT_PREFIX.test(trimSpace(text)) };
}

function functionTurn(payload: JsonRecord): TranscriptTurn[] {
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const wire = payload.arguments ?? payload.input;
    return [toolCallTurn(stringField(payload, "call_id"), stringField(payload, "name"), argumentsOf(wire))];
  }
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const { text, failed } = callOutput(payload.output);
    return [toolResultTurn(stringField(payload, "call_id"), text, failed)];
  }
  return [];
}

/**
 * Codex rollout JSONL (agentmux `transcript.ParseCodexTurns`): `response_item` records whose payload is a `message`.
 * `user` and `assistant` messages are turns; the AGENTS.md block, developer and system messages are context and are
 * not emitted. `function_call` / `custom_tool_call` payloads and their `*_output` become `tool` turns joined by `call_id`.
 */
export const codexRecordTurns: RecordParser = withRecordTimestamp((record) => {
  if (record.type !== "response_item") return [];
  const payload = recordField(record, "payload");
  if (payload === undefined) return [];
  if (payload.type !== "message") return functionTurn(payload);
  const content = payload.content;
  const text = typeof content === "string"
    ? trimSpace(content)
    : Array.isArray(content)
    ? blockTexts(content).join("\n")
    : "";
  if (text === "") return [];
  const role = stringField(payload, "role");
  if (role === "assistant") return [{ role: "agent", text }];
  if (role === "user" && !isAgentsInstructions(text)) return [{ role: "user", text }];
  return [];
});

/**
 * Codex records where it ran in `session_meta` (`cwd` and the `git.branch` it started on) and again in each
 * `turn_context` (`cwd`); a later one replaces an earlier.
 */
export const codexRecordMetadata: RecordMetadata = (record) => {
  const payload = recordField(record, "payload");
  if (payload === undefined) return {};
  if (record.type === "session_meta") return sessionMetadata(payload.cwd, recordField(payload, "git")?.branch);
  if (record.type === "turn_context") return sessionMetadata(payload.cwd, undefined);
  return {};
};
