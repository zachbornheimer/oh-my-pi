import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import { isRecord, recordField, stringField, withRecordTimestamp } from "./records.js";
import type { JsonRecord, RecordParser } from "./records.js";
import { argumentsOf, resultText, toolCallTurn, toolResultTurn } from "./tool_turns.js";

type Speaker = "user" | "agent";

function blockTurn(role: Speaker, block: JsonRecord): TranscriptTurn | undefined {
  if (block.type === "text") {
    const text = trimSpace(stringField(block, "text"));
    return text === "" ? undefined : { role, text };
  }
  if (block.type === "toolCall") {
    return toolCallTurn(stringField(block, "id"), stringField(block, "name"), argumentsOf(block.arguments));
  }
  return undefined;
}

/**
 * omp session JSONL (`~/.omp/agent/sessions/<project>/<started>_<id>.jsonl`): `message` records whose `message` has a
 * role of `user`, `assistant` or `toolResult` and `content` blocks; every turn carries the record's `timestamp`. Text
 * blocks become user or agent turns, `toolCall` blocks and `toolResult` messages become `tool` turns (joined by
 * `toolCallId`); thinking and the session's own bookkeeping records (`custom`, `title`, `model_change`) are not emitted.
 */
export const ompRecordTurns: RecordParser = withRecordTimestamp((record) => {
  if (record.type !== "message") return [];
  const message = recordField(record, "message");
  if (message === undefined) return [];
  const role = stringField(message, "role");
  if (role === "toolResult") {
    return [toolResultTurn(stringField(message, "toolCallId"), resultText(message.content), message.isError === true)];
  }
  if (role !== "user" && role !== "assistant") return [];
  const speaker: Speaker = role === "assistant" ? "agent" : "user";
  const content = message.content;
  if (typeof content === "string") {
    const text = trimSpace(content);
    return text === "" ? [] : [{ role: speaker, text }];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter(isRecord)
    .map((block) => blockTurn(speaker, block))
    .filter((turn): turn is TranscriptTurn => turn !== undefined);
});
