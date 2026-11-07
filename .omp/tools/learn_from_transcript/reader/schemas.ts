/**
 * The normalized transcript every harness reader produces. Copied from the Mastra `transcript/schemas.ts`, with the
 * schema objects reduced to plain types and the Mastra-thread and execution refs left out.
 */

/**
 * The harnesses a conversation ref can name. `agentmux:<project id>` is a project's combined transcript; `pi` and `omp`
 * write the same session format.
 */
export const HARNESSES = [
  "agentmux",
  "grok",
  "claude",
  "cursor",
  "codex",
  "hermes",
  "opencode",
  "copilot",
  "pi",
  "omp",
] as const;
export type Harness = (typeof HARNESSES)[number];

export const CONVERSATION_REF = new RegExp(`^(${HARNESSES.join("|")}):[^\\s:]+$`);
export const CONVERSATION_REF_MESSAGE = `must be "<harness>:<id>" where harness is one of ${HARNESSES.join(", ")}`;

/** The identifier that finds the newest top-level session of a harness. */
export const LATEST_SESSION = "latest";

/** The harnesses whose sessions have a title a person can search by. */
export const TITLED_HARNESSES = [
  "grok",
  "cursor",
  "copilot",
  "omp",
  "hermes",
  "opencode",
] as const satisfies readonly Harness[];

/** Characters an identifier never holds: path separators, shell metacharacters and quotes, and control characters. */
const FORBIDDEN_IN_IDENTIFIER = String.raw`/;\\$"'|&<>\x00-\x1f`;
const IDENTIFIER_EDGE = `[^\\s${FORBIDDEN_IN_IDENTIFIER}]`;
const IDENTIFIER = `${IDENTIFIER_EDGE}(?:[^${FORBIDDEN_IN_IDENTIFIER}]*${IDENTIFIER_EDGE})?`;

/**
 * What can follow `<harness>:` to find a session: a full id, the start of one, `latest`, or words of the session's title
 * (spaces and colons allowed, not at either end). The characters of `FORBIDDEN_IN_IDENTIFIER` are refused so an identifier
 * can never reach a path, a shell or a query.
 */
export const SESSION_IDENTIFIER = new RegExp(`^${IDENTIFIER}$`);

/** A conversation as a person names it: `<harness>:<identifier>`. A superset of `CONVERSATION_REF`, which is a full id. */
export const CONVERSATION_LOOKUP = new RegExp(`^(${HARNESSES.join("|")}):${IDENTIFIER}$`);
export const CONVERSATION_LOOKUP_MESSAGE =
  `must be "<harness>:<id>" where harness is one of ${
    HARNESSES.join(", ")
  } and id is a full session id, the start of one, `
  + `"${LATEST_SESSION}", or words of the session's title (titles: ${TITLED_HARNESSES.join(", ")}); `
  + `id has no / ; \\ $ " ' | & < > or control characters`;

/** The harness named by a conversation ref that matched `CONVERSATION_REF`. */
export function harnessOf(conversation: string): Harness {
  return conversation.slice(0, conversation.indexOf(":")) as Harness;
}

/**
 * The `synthetic_reason` of a `context` turn whose text is a harness's own summary of the turns it compacted away (Grok's
 * `compaction/segment_NNN.md`). It stands in for turns the transcript no longer holds; it is not something anyone said.
 */
export const COMPACTION_SUMMARY = "compaction-summary";

/** The roles a turn can have. Only `user` and `agent` turns are part of a conversation. */
export const TURN_ROLES = ["user", "agent", "reasoning", "tool", "context", "unknown"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

/** Characters kept of one tool result's output, from its start: a transcript parsed with tool calls stays bounded. */
export const TOOL_OUTPUT_HEAD_CHARS = 2000;

/** A tool the agent called: the harness's own call id, the tool's name and its arguments. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * What a test run or a failure looks like in a tool's whole output, found before `output` was cut to its head, so that
 * what lies past the head still counts (`outputSignalsOf`, `session_context.ts`).
 */
export interface OutputSignals {
  /** A line of the whole output starts `--- FAIL:` (Go). */
  go_fail_line: boolean;
  /** A line of the whole output looks like `ok  pkg  0.512s` (Go). */
  go_ok_line: boolean;
  /** The word FAILED appears in an output that also mentions a test, spec or suite. */
  failed_in_test_output: boolean;
  /** The word PASS or PASSED appears. */
  passed_word: boolean;
  /** `error:`, `Error:`, `ERROR:`, `panic:` or `fatal:` appears. */
  error_marker: boolean;
}

/** What a tool call returned; `output` is cut to `TOOL_OUTPUT_HEAD_CHARS`. `signals` is set only when it was cut. */
export interface ToolResult {
  id: string;
  output: string;
  is_error: boolean;
  signals?: OutputSignals;
}

/** The tokens a model call used. `cache_read` and `cache_write` are 0 when the harness records none. */
export interface TurnUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  model?: string;
}

/** One normalized turn of a transcript. */
export interface TranscriptTurn {
  role: TurnRole;
  text: string;
  /** Set on a `tool` turn that is the agent calling a tool. */
  tool_call?: ToolCall;
  /** Set on a `tool` turn that is a tool call's result, joined to its call by `id`. */
  tool_result?: ToolResult;
  /** Set when the harness wrote this user turn itself (Grok `synthetic_reason`); such a turn is never a human ask. */
  synthetic_reason?: string;
  /** When the harness recorded this turn, ISO-8601 UTC to the second; absent when the harness records no time. */
  timestamp?: string;
  /** Which model message an agent turn belongs to, set when the harness records messages whole. */
  message_id?: string;
  usage?: TurnUsage;
  /** Which session the turn belongs to, when one transcript interleaves several (a project's combined transcript). */
  session?: string;
}

/** What the harness itself recorded about where a session ran; a field the harness does not record is absent. */
export interface SessionMetadata {
  /** The directory the session ran in; the last one recorded when it changed. */
  cwd?: string;
  /** The git branch the session was on; the last one recorded. */
  git_branch?: string;
}

/** The transcript read for a ref: where it came from and its normalized turns, oldest first. */
export interface Transcript {
  /** Where the transcript file (or database) read is. */
  path: string;
  /** `<harness>:<full id>` of the session that was read, set when the ref named it by a prefix, `latest` or its title. */
  conversation?: string;
  metadata?: SessionMetadata;
  turns: TranscriptTurn[];
  /** How many lines of the file were not valid JSON and were left out. */
  skipped_lines: number;
}
