import { trimSpace } from "./gotext.js";

/**
 * Which user-role text a person wrote. A harness delivers its own machinery (hook feedback, reminders, command echoes,
 * environment dumps) in the same role as the human's words; these tests tell them apart. Shared by the conversation
 * excerpt, the handoff document and the session context, so the three agree on what a human said.
 */

/** agentmux `agentsystem.OpenTag`: wraps every block agentmux injects into an agent's context. */
const AGENTMUX_OPEN_TAG = "<agentmux-system>";

/** Prefixes (agentmux `transcript.IsHarnessNoiseText`) of user-role text that no human wrote and that says nothing to the model. */
const NOISE_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<system-reminder>",
  "Base directory for this skill:",
  "Heartbeat (",
  "This session is being continued from a previous conversation",
  "<open_and_recently_viewed_files>",
  "<agent_transcripts>",
  AGENTMUX_OPEN_TAG,
  "[tool_result",
];

/** Prefixes of user-role text the harness wrote to instruct the model. */
const SYSTEM_PREFIXES = [
  "<task-notification>",
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
];

/**
 * A hook talking to the model (`Stop hook feedback:`, `PostToolUse hook feedback:`, ...): the first line is one
 * non-blank word-led label ending in "hook feedback:".
 */
const HOOK_FEEDBACK_FIRST_LINE = /^\S.*\bhook feedback:/;

/** Grok session-preamble tags whose presence, with no `<user_query>` beside them, marks the whole turn as preamble. */
const ENV_DUMP_TAGS = ["<user_info>", "<git_status>"];
const USER_QUERY_OPEN = "<user_query>";

/** agentmux `transcript.IsHarnessNoiseText`. Empty text is noise. */
export function isHarnessNoiseText(text: string): boolean {
  const trimmed = trimSpace(text);
  return trimmed === "" || NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** agentmux `transcript.IsUnwrappedEnvDumpText`. */
export function isUnwrappedEnvDumpText(text: string): boolean {
  return ENV_DUMP_TAGS.some((tag) => text.includes(tag)) && !text.includes(USER_QUERY_OPEN);
}

/** Whether user-role `text` (trimmed) is the harness instructing the model: a hook's feedback, a task notification, an interruption. */
export function isSystemText(text: string): boolean {
  return SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix)) || HOOK_FEEDBACK_FIRST_LINE.test(text);
}

/** Whether user-role `text` is something a human asked: not noise, not an environment dump, and not the harness instructing the model. */
export function isHumanAsk(text: string): boolean {
  const trimmed = trimSpace(text);
  return !isHarnessNoiseText(trimmed) && !isUnwrappedEnvDumpText(trimmed) && !isSystemText(trimmed);
}
