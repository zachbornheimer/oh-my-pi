import type { Turn } from "./context.js";
import type { Source } from "./types.js";

/** Characters of the digest; a longer conversation keeps its start and, more of, its end. */
export const DIGEST_BUDGET = 40000;
const START_SHARE = 0.4;
const USER_CHARS = 500;
const AGENT_CHARS = 240;
const TOOL_CHARS = 200;

const flat = (text: string, limit: number): string => {
  const squashed = text.replace(/\s+/g, " ").trim();
  return squashed.length <= limit ? squashed : `${squashed.slice(0, limit)}…`;
};

interface Entry {
  readonly id: number;
  readonly line: string;
}

function entryOf(turn: Turn, id: number): Entry | undefined {
  if (turn.role === "user" && turn.text.trim() !== "") {
    return { id, line: `[${id}] user: ${flat(turn.text, USER_CHARS)}` };
  }
  if (turn.role === "agent" && turn.text.trim() !== "") {
    return { id, line: `[${id}] agent: ${flat(turn.text, AGENT_CHARS)}` };
  }
  if (turn.role === "tool" && turn.tool_call !== undefined) {
    return {
      id,
      line: `[${id}] tool ${turn.tool_call.name}: ${flat(JSON.stringify(turn.tool_call.input), TOOL_CHARS)}`,
    };
  }
  return undefined;
}

/** Entries from the front up to `budget` characters. */
function within(entries: readonly Entry[], budget: number): Entry[] {
  const kept: Entry[] = [];
  let used = 0;
  for (const entry of entries) {
    used += entry.line.length + 1;
    if (used > budget) break;
    kept.push(entry);
  }
  return kept;
}

/** A conversation as a source: what the user asked, what the agent said and every tool it called, numbered by turn. */
export function conversationSource(ref: string, turns: readonly Turn[]): Source {
  const entries = turns.flatMap((turn, index) => entryOf(turn, index + 1) ?? []);
  const size = entries.reduce((total, entry) => total + entry.line.length + 1, 0);
  const whole = size <= DIGEST_BUDGET;
  const head = whole ? entries : within(entries, DIGEST_BUDGET * START_SHARE);
  const tail = whole ? [] : within([...entries].reverse(), DIGEST_BUDGET * (1 - START_SHARE)).reverse();
  const left = entries.length - head.length - tail.length;
  const shown = [...head, ...tail];
  return {
    ref,
    kind: "conversation",
    body: [
      ...head.map((entry) => entry.line),
      ...(left > 0 ? [`(${left} turns left out)`] : []),
      ...tail.map((entry) => entry.line),
    ].join("\n"),
    anchors: shown.map((entry) => String(entry.id)),
    truncated: left > 0,
  };
}
