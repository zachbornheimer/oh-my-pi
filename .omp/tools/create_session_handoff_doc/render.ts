import { isHumanAsk } from "./reader/human_voice.js";
import { type Harness, HARNESSES } from "./reader/schemas.js";
import type { SessionContext, SessionTurns, Turn } from "./types.js";

/** agentmux `summarize.maxRecentTurns`, `maxToolFailures` and `maxSubagentHints`: how many of each the document lists. */
export const MAX_RECENT_TURNS = 6;
export const MAX_TOOL_FAILURES = 8;
export const MAX_SUBAGENT_HINTS = 8;

const NOT_EXTRACTED_GOAL = "_Not extracted — read the full transcript._";

/** agentmux `summarize.isAgentTool`: tool names that start a subagent. */
const AGENT_TOOLS = new Set(["task", "agent", "teammate", "spawn_agent"]);
/** agentmux `summarize.toolInputDescription`: the input fields that describe a subagent's job, first non-blank wins. */
const DESCRIPTION_KEYS = ["description", "prompt", "task"];

const HARNESS_LABELS: Readonly<Record<Harness, string>> = {
  agentmux: "Agentmux project",
  grok: "Grok",
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  hermes: "Hermes",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  pi: "pi",
  omp: "omp",
};

interface Insights {
  readonly goal: string;
  readonly recentTurns: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly toolFailures: readonly string[];
  readonly subagents: readonly string[];
  readonly lastRole: Turn["role"] | undefined;
}

/** agentmux `strings.Fields` + `strings.Join`: one line, whitespace runs collapsed. Nothing is cut. */
function singleLine(text: string): string {
  return text.split(/\s+/).filter((word) => word !== "").join(" ");
}

function descriptionOf(input: Readonly<Record<string, unknown>>): string {
  for (const key of DESCRIPTION_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function failureOf(output: string): string {
  const body = singleLine(output);
  return body === "" ? "tool error" : `tool error: ${body}`;
}

/** agentmux `summarize.extractInsights`, over normalized turns: the goal, the recent turns, tool errors and subagents. */
function extractInsights(turns: readonly Turn[]): Insights {
  let goal = "";
  const spoken: { role: "user" | "assistant"; text: string }[] = [];
  const toolFailures: string[] = [];
  const subagents: string[] = [];
  for (const turn of turns) {
    if (turn.role === "user" || turn.role === "assistant") {
      const text = turn.text.trim();
      // Harness noise is user-role text that no human wrote; agent replies are kept as they are.
      if (text === "" || (turn.role === "user" && !isHumanAsk(text))) continue;
      if (goal === "" && turn.role === "user") goal = text;
      spoken.push({ role: turn.role, text });
    }
    if (turn.tool_result?.is_error === true && toolFailures.length < MAX_TOOL_FAILURES) {
      toolFailures.push(failureOf(turn.tool_result.output));
    }
    const call = turn.tool_call;
    if (call !== undefined && AGENT_TOOLS.has(call.name.toLowerCase()) && subagents.length < MAX_SUBAGENT_HINTS) {
      const description = descriptionOf(call.input);
      subagents.push(
        description === ""
          ? `subagent tool: ${call.name}`
          : `subagent tool: ${call.name} — ${singleLine(description)}`,
      );
    }
  }
  return {
    goal,
    recentTurns: spoken.slice(-MAX_RECENT_TURNS),
    toolFailures,
    subagents,
    lastRole: turns.at(-1)?.role,
  };
}

function harnessLabel(conversation: string): string {
  const harness = HARNESSES.find((name) => conversation.startsWith(`${name}:`));
  return harness === undefined ? conversation.slice(0, conversation.indexOf(":")) : HARNESS_LABELS[harness];
}

const sessionId = (conversation: string): string => conversation.slice(conversation.indexOf(":") + 1);

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

function goalSection(info: Insights): string[] {
  return ["## Current Goal", "", info.goal === "" ? NOT_EXTRACTED_GOAL : info.goal, ""];
}

const UNKNOWN_WORKING_DIRECTORY = "unknown (the harness's transcript does not record it)";

const asCode = (path: string): string => `\`${path}\``;

function linksSection(source: SessionTurns["source"], context: SessionContext): string[] {
  return [
    "## Links & Artifact Paths",
    "",
    `- Full transcript (${source.total_turns} turns): ${asCode(source.path)}`,
    `- Working directory: ${context.working_dir === null ? UNKNOWN_WORKING_DIRECTORY : asCode(context.working_dir)}`,
    `- Git branch: ${context.git_branch === null ? "unknown" : asCode(context.git_branch)}`,
    ...(context.worktrees.length === 0 ? [] : [`- Worktrees: ${context.worktrees.map(asCode).join(", ")}`]),
    ...(context.other_projects.length === 0
      ? []
      : [`- Other projects touched: ${context.other_projects.map(asCode).join(", ")}`]),
    "",
  ];
}

const SESSION_END_TEXT: Readonly<Record<SessionContext["session_end"], string>> = {
  natural: "the agent spoke last",
  awaiting_response: "a message is waiting for an answer",
  unknown: "unknown",
};

function statusSection(conversation: string, info: Insights, context: SessionContext): string[] {
  return [
    "## Current Status",
    "",
    `- Source session: \`${conversation}\``,
    `- Last turn: ${info.lastRole ?? "none (the session has no turns)"}`,
    `- Session end: ${SESSION_END_TEXT[context.session_end]}`,
    `- Tests: ${context.test_status}`,
    `- Git status: ${context.git_status}`,
    ...(context.last_user_message === null ? [] : [`- Last user message: ${singleLine(context.last_user_message)}`]),
    "- Stopped reason: not classified (agentmux's stop detector is not ported)",
    "",
  ];
}

/** What the harness itself summarized of turns it compacted away; the live turns below start after them. */
function compactedSection(compacted: readonly string[]): string[] {
  return compacted.length === 0
    ? []
    : ["## Compacted Earlier Turns", "", ...compacted.flatMap((summary) => [summary, ""])];
}

function recentTurnsSection(info: Insights): string[] {
  const heading = ["## Recent Turns", ""];
  if (info.recentTurns.length === 0) return [...heading, "_No user/assistant turns extracted._", ""];
  return [
    ...heading,
    ...info.recentTurns.map((turn) => `- **${capitalize(turn.role)}:** ${singleLine(turn.text)}`),
    "",
  ];
}

function listSection(heading: string, items: readonly string[], none: string): string[] {
  return [heading, "", ...(items.length === 0 ? [none] : items.map((item) => `- ${item}`)), ""];
}

const TAKEOVER_INSTRUCTIONS = [
  "- Read the full transcript before resuming work.",
  "- Preserve the transcript path above in the new provider's handoff context.",
  "- Identify the repo, dirty worktrees, active branches, subagents, and last failing command from the transcript before editing files.",
  "- Continue from the current goal; do not redo completed steps listed above.",
];

/**
 * The takeover handoff Markdown of a session, in agentmux's `summarize` order (internal/summarize/render_claude.go):
 * goal, links, status, recent turns, known failures, previous subagents, takeover instructions. Deterministic: the same
 * turns give the same document, with no clock, no model and no file read.
 */
export function renderHandoff(session: SessionTurns): string {
  const info = extractInsights(session.turns);
  const lines = [
    `# Handoff Context - ${harnessLabel(session.conversation)} session ${sessionId(session.conversation)}`,
    "",
    ...goalSection(info),
    ...compactedSection(session.compacted),
    ...linksSection(session.source, session.context),
    ...statusSection(session.conversation, info, session.context),
    ...recentTurnsSection(info),
    ...listSection("## Known Failures / Tool Hints", info.toolFailures, "- None extracted from tool results."),
    ...listSection(
      "## Errors Seen",
      session.context.errors_seen.map(singleLine),
      "- No error output seen in tool results.",
    ),
    ...listSection("## Side Effects", session.context.side_effects, "- None detected in shell commands."),
    ...listSection("## Previous Subagents", info.subagents, "- None detected."),
    "## Takeover Instructions",
    "",
    ...TAKEOVER_INSTRUCTIONS,
  ];
  return `${lines.join("\n")}\n`;
}
