import type { SessionContext } from "./reader/session_context.js";

export type { SessionContext };

/** Who spoke a turn. Text the harness wrote itself (a hook's feedback, a reminder) is not a turn of the conversation. */
export type Turn = {
  role: "user" | "assistant" | "tool";
  text: string;
  /** Set on a `tool` turn that is the agent calling a tool. */
  tool_call?: { id: string; name: string; input: Record<string, unknown> };
  /** Set on a `tool` turn that is a tool call's result, joined to its call by `id`. */
  tool_result?: { id: string; output: string; is_error: boolean };
};

export interface Source {
  /** The file or database the turns were read from. */
  path: string;
  /** Every turn the source returned, tool calls and results included, before anything is left out of the document. */
  total_turns: number;
}

export interface HandoffOutput {
  conversation: string;
  markdown: string;
  context: SessionContext;
  source: Source;
}

/** What the read step hands the render step. */
export interface SessionTurns {
  conversation: string;
  source: Source;
  turns: Turn[];
  context: SessionContext;
  /** What the harness itself summarized of turns it compacted away, oldest first; the live `turns` start after them. */
  compacted: string[];
}
