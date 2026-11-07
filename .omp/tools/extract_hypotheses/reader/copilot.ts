import type { TranscriptTurn } from "./schemas.js";
import { trimSpace } from "./gotext.js";
import { isRecord, recordField, sessionMetadata, stringField, withRecordTimestamp } from "./records.js";
import type { JsonRecord, RecordMetadata, RecordParser } from "./records.js";
import { argumentsOf, toolCallTurn, toolResultTurn } from "./tool_turns.js";

function speech(role: "user" | "agent", text: string): TranscriptTurn[] {
  const spoken = trimSpace(text);
  return spoken === "" ? [] : [{ role, text: spoken }];
}

/** An assistant message's tool requests: `{toolCallId, name, arguments}` each. */
function requestedCalls(data: JsonRecord): TranscriptTurn[] {
  const requests = Array.isArray(data.toolRequests) ? data.toolRequests.filter(isRecord) : [];
  return requests.map((request) =>
    toolCallTurn(stringField(request, "toolCallId"), stringField(request, "name"), argumentsOf(request.arguments))
  );
}

/** A finished tool execution: its result's text, or the error it failed with. */
function executionResult(data: JsonRecord): TranscriptTurn {
  const failed = data.success === false;
  const output = failed
    ? stringField(recordField(data, "error") ?? {}, "message")
    : stringField(recordField(data, "result") ?? {}, "content");
  return toolResultTurn(stringField(data, "toolCallId"), output, failed);
}

/**
 * GitHub Copilot CLI `~/.copilot/session-state/<id>/events.jsonl`: one `{type, data, timestamp}` event per line, each turn
 * stamped with its event's `timestamp`. `user.message` carries what the person typed in `content` (`transformedContent`,
 * the prompt with the harness's additions, is not read) and `assistant.message` the model's text and its `toolRequests`.
 * `tool.execution_complete` is a call's result, joined to its request by `toolCallId`. Reasoning, the system prompt,
 * model calls and every other event are not emitted.
 */
export const copilotRecordTurns: RecordParser = withRecordTimestamp((record) => {
  const data = recordField(record, "data");
  if (data === undefined) return [];
  switch (record.type) {
    case "user.message":
      return speech("user", stringField(data, "content"));
    case "assistant.message":
      return [...speech("agent", stringField(data, "content")), ...requestedCalls(data)];
    case "tool.execution_complete":
      return [executionResult(data)];
    default:
      return [];
  }
});

/** Copilot's `session.start` event records the `cwd` and git `branch` the session began in. */
export const copilotRecordMetadata: RecordMetadata = (record) => {
  if (record.type !== "session.start") return {};
  const context = recordField(recordField(record, "data") ?? {}, "context");
  return context === undefined ? {} : sessionMetadata(context.cwd, context.branch);
};
