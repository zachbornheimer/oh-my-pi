import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import { isRecord, recordField, sessionMetadata, stringField, withRecordTimestamp } from "./records.js";
import type { JsonRecord, RecordMetadata, RecordParser } from "./records.js";
import { argumentsOf, resultText, toolCallTurn, toolResultTurn } from "./tool_turns.js";

function numberOf(record: JsonRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

type Speaker = "user" | "agent";

function blockTurn(role: Speaker, block: JsonRecord): TranscriptTurn | undefined {
  if (block.type === "text") {
    const text = trimSpace(stringField(block, "text"));
    return text === "" ? undefined : { role, text };
  }
  if (block.type === "tool_use") {
    return toolCallTurn(stringField(block, "id"), stringField(block, "name"), argumentsOf(block.input));
  }
  if (block.type === "tool_result") {
    const output = trimSpace(stringField(block, "text")) || resultText(block.content);
    return toolResultTurn(stringField(block, "tool_use_id"), output, block.is_error === true);
  }
  return undefined;
}

/**
 * Claude Code session JSONL (agentmux `transcript.ParseClaudeTurns`): `user` and `assistant` records carry a message whose
 * content is a string or typed blocks; every turn of a record carries the record's `timestamp`. Text becomes a user or agent turn by the message's role; `tool_use` and
 * `tool_result` blocks become `tool` turns (joined by id); thinking is not emitted.
 */
export const claudeRecordTurns: RecordParser = withRecordTimestamp((record) => {
  if (record.type !== "user" && record.type !== "assistant") return [];
  const message = recordField(record, "message");
  if (message === undefined) return [];
  const role: Speaker = stringField(message, "role") === "assistant" ? "agent" : "user";
  const content = message.content;
  const spoken = typeof content === "string"
    ? (trimSpace(content) === "" ? [] : [{ role, text: trimSpace(content) }])
    : Array.isArray(content)
    ? content.filter(isRecord).flatMap((block) => {
      const turn = blockTurn(role, block);
      return turn === undefined ? [] : [turn];
    })
    : [];
  if (role !== "agent" || spoken.length === 0) return spoken;
  const id = stringField(message, "id");
  const usage = recordField(message, "usage");
  const recorded = usage === undefined
    ? {}
    : {
      usage: {
        input: numberOf(usage, "input_tokens"),
        output: numberOf(usage, "output_tokens"),
        cache_read: numberOf(usage, "cache_read_input_tokens"),
        cache_write: numberOf(usage, "cache_creation_input_tokens"),
        ...(stringField(message, "model") === "" ? {} : { model: stringField(message, "model") }),
      },
    };
  return spoken.map((turn) => ({ ...turn, ...(id === "" ? {} : { message_id: id }), ...recorded }));
});

/** Claude stamps every `user` record with the `cwd` and `gitBranch` it was written in. */
export const claudeRecordMetadata: RecordMetadata = (record) =>
  record.type === "user" ? sessionMetadata(record.cwd, record.gitBranch) : {};
