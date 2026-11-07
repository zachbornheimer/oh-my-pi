import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import { blockTexts, isRecord, recordField, sessionMetadata, stringField, withRecordTimestamp } from "./records.js";
import type { JsonRecord, RecordMetadata, RecordParser } from "./records.js";
import { argumentsOf, resultText, toolCallTurn, toolResultTurn } from "./tool_turns.js";

function assistantBlockTurn(block: JsonRecord): TranscriptTurn[] {
  if (block.type === "text") {
    const text = trimSpace(stringField(block, "text"));
    return text === "" ? [] : [{ role: "agent", text }];
  }
  if (block.type === "toolCall") {
    return [toolCallTurn(stringField(block, "id"), stringField(block, "name"), argumentsOf(block.arguments))];
  }
  return [];
}

/**
 * Session JSONL of pi (`~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl`) and of omp, which writes the same session format
 * (`~/.omp/agent/sessions/...`): a `session` header, then one tree entry per line; a `message` entry carries a message
 * whose `content` is a string or typed blocks, and each turn is stamped with its entry's `timestamp`. A `user` message
 * is a user turn; an `assistant` message's `text` blocks are agent turns and its `toolCall` blocks are calls; a
 * `toolResult` message answers a call by `toolCallId` and says whether it failed in `isError`. Thinking, the system and
 * developer messages and every other entry (model changes, titles, injected context, usage) are not emitted.
 */
export const piRecordTurns: RecordParser = withRecordTimestamp((record) => {
  if (record.type !== "message") return [];
  const message = recordField(record, "message");
  if (message === undefined) return [];
  const content = message.content;
  switch (message.role) {
    case "user": {
      const text = typeof content === "string"
        ? trimSpace(content)
        : Array.isArray(content)
        ? blockTexts(content, "text").join("\n")
        : "";
      return text === "" ? [] : [{ role: "user", text }];
    }
    case "assistant":
      return Array.isArray(content) ? content.filter(isRecord).flatMap(assistantBlockTurn) : [];
    case "toolResult":
      return [toolResultTurn(stringField(message, "toolCallId"), resultText(content), message.isError === true)];
    default:
      return [];
  }
});

/** The `session` header of a pi or omp session records the `cwd` it ran in. */
export const piRecordMetadata: RecordMetadata = (record) =>
  record.type === "session" ? sessionMetadata(record.cwd, undefined) : {};
