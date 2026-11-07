import { conversationRefOf } from "./reader/conversation_ref.js";
import { COMPACTION_SUMMARY, type TranscriptTurn } from "./reader/schemas.js";
import { sessionContextOf } from "./reader/session_context.js";
import type { TurnSource } from "./reader/turn_source.js";
import { renderHandoff } from "./render.js";
import type { HandoffOutput, Turn } from "./types.js";

/**
 * The reader's turn as this document's `Turn`. `agent` becomes `assistant`; a user turn the harness wrote itself
 * (`synthetic_reason`: hook feedback, reminders) is machinery and left out, as are reasoning, context and unknown turns.
 */
export function turnOf(turn: TranscriptTurn): Turn | undefined {
  switch (turn.role) {
    case "user":
      return turn.synthetic_reason === undefined ? { role: "user", text: turn.text } : undefined;
    case "agent":
      return { role: "assistant", text: turn.text };
    case "tool":
      return {
        role: "tool",
        text: turn.text,
        ...(turn.tool_call === undefined ? {} : { tool_call: turn.tool_call }),
        ...(turn.tool_result === undefined ? {} : { tool_result: turn.tool_result }),
      };
    default:
      return undefined;
  }
}

/** Read the session through `source` (tool calls included) and render its takeover handoff document. No model, no writes. */
export async function createSessionHandoffDoc(conversation: string, source: TurnSource): Promise<HandoffOutput> {
  const asked = conversationRefOf(conversation);
  const { path, turns: read, conversation: found, metadata } = await source.readTurns(asked, { toolCalls: true });
  const session = {
    conversation: found ?? asked,
    source: { path, total_turns: read.length },
    turns: read.flatMap((turn) => turnOf(turn) ?? []),
    context: sessionContextOf({ turns: read, metadata }),
    compacted: read.filter((turn) => turn.synthetic_reason === COMPACTION_SUMMARY).map((turn) => turn.text),
  };
  return {
    conversation: session.conversation,
    markdown: renderHandoff(session),
    context: session.context,
    source: session.source,
  };
}
