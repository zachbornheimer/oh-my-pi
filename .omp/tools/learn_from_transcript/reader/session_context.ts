import { type Infer, z } from "./shape.js";
import { isHumanAsk } from "./human_voice.js";
import type { OutputSignals, SessionMetadata, TranscriptTurn } from "./schemas.js";

/**
 * What a person taking over a session wants to know about where it stands, read from its normalized turns and from what the
 * harness itself recorded about where it ran. A deterministic port of the assume-session skill's `extract-context.py`:
 * no model, no clock, no file read. Anything the session does not show stays unknown (`null`, `"unknown"` or empty).
 */
export const GIT_STATUSES = ["clean", "dirty", "unknown"] as const;
export const TEST_STATUSES = ["passing", "failing", "unknown"] as const;
export const SESSION_ENDS = ["natural", "awaiting_response", "unknown"] as const;

export const session_context_schema = z.object({
  /** The directory the harness recorded the session ran in. Never guessed from commands or from where the transcript is stored. */
  working_dir: z.string().nullable(),
  /** Worktrees the session created or switched to: `git worktree add <path>`, `wt switch <branch|pr:N>`, an agent's own isolated worktree. */
  worktrees: z.array(z.string()),
  /** Other project roots (first five path components) of files the session read or wrote outside the working directory. */
  other_projects: z.array(z.string()),
  /** The branch the harness recorded; failing that the last one a `git checkout`/`git switch`/`wt switch` named. */
  git_branch: z.string().nullable(),
  /** From the last `git status` the session ran, when the session ran one. */
  git_status: z.enum(GIT_STATUSES),
  /** The last thing a person (not a hook, a reminder or an interruption) said, whole. */
  last_user_message: z.string().nullable(),
  test_status: z.enum(TEST_STATUSES),
  /** `natural`: the agent spoke last. `awaiting_response`: a user message is unanswered. `unknown`: it ended on a tool result or has no turns. */
  session_end: z.enum(SESSION_ENDS),
  /** The last few tool outputs (and error-like agent text where the transcript holds no tool results), each cut to its head. */
  errors_seen: z.array(z.string()),
  /** Outward or irreversible actions found in shell commands: pushes, commits, PRs, migrations. */
  side_effects: z.array(z.string()),
});
export type SessionContext = Infer<typeof session_context_schema>;

/** What `sessionContextOf` reads of a session: its turns (tool turns included) and the metadata the harness recorded. */
export interface SessionRecord {
  readonly turns: readonly TranscriptTurn[];
  readonly metadata?: SessionMetadata | undefined;
}

const MAX_ERROR_SNIPPET = 500;
const MAX_ERRORS_KEPT = 5;

/** Directories under a home directory that hold a tool's own files, not a project. */
const CONFIG_DIRS = new Set([
  ".claude",
  ".cursor",
  ".codex",
  ".config",
  ".local",
  ".cache",
  ".npm",
  ".cargo",
  ".rustup",
  ".pyenv",
  ".rbenv",
  ".nvm",
]);
const SYSTEM_DIRS = new Set(["tmp", "private", "var", "etc", "usr", "opt", "proc", "sys"]);
const PROJECT_ROOT_DEPTH = 5;

/** The likely project root of an absolute file path: its first five components (`/`, then four), unless it lies in a system or tool-config directory. */
function guessProjectRoot(filePath: string): string | undefined {
  if (!filePath.startsWith("/")) return undefined;
  const parts = ["/", ...filePath.split("/").filter((part) => part !== "")];
  if (parts.length < PROJECT_ROOT_DEPTH) return undefined;
  if (SYSTEM_DIRS.has(parts[1] as string)) return undefined;
  if (CONFIG_DIRS.has(parts[3] as string)) return undefined;
  return `/${parts.slice(1, PROJECT_ROOT_DEPTH).join("/")}`;
}

const RE_TEST_FAIL_LINE = /^--- FAIL:/m;
const RE_TEST_OK_LINE = /^ok\s+\S+\s+\d+\.\d+s/m;
const RE_FAILED = /\bFAILED\b/;
const RE_TEST_WORD = /test|spec|suite/i;
const RE_PASSED = /\bPASS(ED)?\b/;
const RE_ERROR = /\b(error:|Error:|ERROR:|panic:|fatal:)/;

/** What a test run or a failure looks like in `text`. A reader that cuts a tool output to its head records this first. */
export function outputSignalsOf(text: string): OutputSignals {
  return {
    go_fail_line: RE_TEST_FAIL_LINE.test(text),
    go_ok_line: RE_TEST_OK_LINE.test(text),
    failed_in_test_output: RE_FAILED.test(text) && RE_TEST_WORD.test(text),
    passed_word: RE_PASSED.test(text),
    error_marker: RE_ERROR.test(text),
  };
}

interface Findings {
  testStatus: SessionContext["test_status"];
  readonly errors: string[];
}

/** Updates the test status and the error list from one tool output; `signals` are those of the whole output when `text` is only its head. */
function classifyOutput(text: string, findings: Findings, signals: OutputSignals = outputSignalsOf(text)): void {
  if (text === "") return;
  const snippet = text.slice(0, MAX_ERROR_SNIPPET);
  if (signals.go_fail_line) {
    findings.testStatus = "failing";
    findings.errors.push(snippet);
  } else if (signals.go_ok_line && findings.testStatus !== "failing") {
    findings.testStatus = "passing";
  }
  if (signals.failed_in_test_output) {
    findings.testStatus = "failing";
    findings.errors.push(snippet);
  } else if (signals.passed_word && findings.testStatus === "unknown") {
    findings.testStatus = "passing";
  }
  if (signals.error_marker) findings.errors.push(snippet);
}

const RE_GIT_PUSH = /\bgit\s+push\b/;
const RE_GIT_COMMIT = /\bgit\s+commit\b/;
const RE_COMMIT_MSG_DQ = /\bgit\s+commit\b[^\n]*-m\s+"([^"$\n]{1,80})"/;
const RE_COMMIT_MSG_SQ = /\bgit\s+commit\b[^\n]*-m\s+'([^'$\n]{1,80})'/;
const RE_PR_CREATE = /\bgh\s+pr\s+create\b/;
const RE_PR_MERGE = /\bgh\s+pr\s+merge\b/;
const RE_TITLE_DQ = /--title\s+"([^"]{1,80})"/;
const RE_TITLE_SQ = /--title\s+'([^']{1,80})'/;
const RE_MIGRATION =
  /\batlas\s+migrate\s+apply\b|\bmigrate\s+up\b|\bsupabase\s+db\s+push\b|\bmake\s+migrate\b|migrations\/[^\s]+\.sql\b/i;
const RE_WT_STEP_COMMIT = /\bwt step commit\b|\bwt\b[^\n]*\bstep\s+commit\b/;
const RE_GIT_WORKTREE_ADD = /\bgit\s+worktree\s+add\b/g;
const RE_GIT_CHECKOUT = /\bgit\s+(?:checkout|switch)\b/g;
const RE_WT_SWITCH = /\bwt\s(?:[^;\n|&]+?\s)?switch\b/g;
const RE_COMMAND_CUT = /\s*(?:&&|\|\||[;\n|])/;
const RE_GIT_STATUS = /\bgit\s+status\b/;

const GIT_WORKTREE_VALUE_FLAGS = new Set(["-b", "-B", "--reason"]);
const WT_SWITCH_VALUE_FLAGS = new Set(["--format", "--base", "-b", "-x", "--execute", "--path"]);
const NO_FLAGS: ReadonlySet<string> = new Set();

/** The words of the command that starts at `start`, up to the next `&&`, `||`, `;`, newline or pipe. */
function tailTokens(text: string, start: number): string[] {
  return (text.slice(start).split(RE_COMMAND_CUT)[0] ?? "").split(/\s+/).filter((token) => token !== "");
}

/** The first word that is not a flag, skipping the value of a flag that takes one (`-b <branch>`). */
function firstPositional(tokens: readonly string[], valueFlags: ReadonlySet<string>): string | undefined {
  let at = 0;
  while (at < tokens.length && (tokens[at] as string).startsWith("-")) {
    const token = tokens[at] as string;
    const key = token.split("=", 1)[0] as string;
    at += !token.includes("=") && valueFlags.has(key) ? 2 : 1;
  }
  return tokens[at];
}

interface VcsEvent {
  readonly at: number;
  readonly kind: "worktree" | "both" | "branch";
  readonly value: string;
}

/** Worktree paths or ids, in command order, and the last branch named by the git and wt commands in `text`. */
function vcsIdents(text: string): { readonly worktrees: string[]; readonly branch: string | undefined } {
  const events: VcsEvent[] = [];
  const add = (pattern: RegExp, kind: VcsEvent["kind"], valueFlags: ReadonlySet<string>): void => {
    for (const match of text.matchAll(pattern)) {
      const value = firstPositional(tailTokens(text, match.index + match[0].length), valueFlags);
      if (value !== undefined) events.push({ at: match.index, kind, value });
    }
  };
  add(RE_GIT_WORKTREE_ADD, "worktree", GIT_WORKTREE_VALUE_FLAGS);
  add(RE_WT_SWITCH, "both", WT_SWITCH_VALUE_FLAGS);
  add(RE_GIT_CHECKOUT, "branch", NO_FLAGS);
  events.sort((a, b) =>
    a.at - b.at || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
  );
  const worktrees: string[] = [];
  let branch: string | undefined;
  for (const event of events) {
    if (event.kind !== "branch") worktrees.push(event.value);
    if (event.kind !== "worktree") branch = event.value;
  }
  return { worktrees, branch };
}

/** The outward or irreversible actions in a shell command, as short sentences. `git worktree add` is a worktree, not a side effect. */
function sideEffectsOf(command: string): string[] {
  const found: string[] = [];
  if (RE_GIT_PUSH.test(command)) found.push("pushed to remote");
  if (RE_GIT_COMMIT.test(command)) {
    const message = RE_COMMIT_MSG_DQ.exec(command) ?? RE_COMMIT_MSG_SQ.exec(command);
    found.push(message === null ? "committed" : `committed: "${(message[1] as string).trim()}"`);
  } else if (RE_WT_STEP_COMMIT.test(command)) {
    found.push("committed");
  }
  const title = (): string | undefined => (RE_TITLE_DQ.exec(command) ?? RE_TITLE_SQ.exec(command))?.[1]?.trim();
  if (RE_PR_CREATE.test(command)) found.push(title() === undefined ? "opened PR" : `opened PR: "${title()}"`);
  if (RE_PR_MERGE.test(command)) found.push(title() === undefined ? "merged PR" : `merged PR: "${title()}"`);
  if (RE_MIGRATION.test(command)) found.push("applied migration");
  return found;
}

/** A tool that runs a shell command: Bash, Shell, Codex's exec, `run_terminal_command`, and MCP tools that end in `run` or `run_command`. */
const SHELL_TOOL =
  /(^|[_.-])(bash|shell|exec|exec_command|execute_bash|run_terminal_command|run_command|shell_command|agentmux_run|terminal)$/;
const COMMAND_KEYS = ["command", "cmd"] as const;

/** The shell text a tool call runs, or "" when the call is not a shell tool. Codex's `exec` carries a script, kept as `raw`. */
function commandOf(name: string, input: Readonly<Record<string, unknown>>): string {
  if (!SHELL_TOOL.test(name.toLowerCase())) return "";
  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.filter((part): part is string => typeof part === "string").join(" ");
  }
  return typeof input.raw === "string" ? input.raw : "";
}

/** Tools that open a file; the file's project is another project when it is outside the working directory. */
const FILE_TOOLS = new Set(["read", "edit", "write", "multiedit", "notebookedit", "view", "create"]);
const PATH_KEYS = ["file_path", "path", "filePath"] as const;

function filePathOf(name: string, input: Readonly<Record<string, unknown>>): string | undefined {
  if (!FILE_TOOLS.has(name.toLowerCase())) return undefined;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

const AUTO_MANAGED_WORKTREE = "(auto-managed worktree)";

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Which of a session's last turns says how it ended; undefined for turns that do not say (context, reasoning). */
function endOf(turn: TranscriptTurn): SessionContext["session_end"] | undefined {
  switch (turn.role) {
    case "agent":
      return "natural";
    case "user":
      return turn.text.trim() === "" ? undefined : "awaiting_response";
    case "tool":
      // A call is part of an agent's message; a result with nothing after it is a session that stopped mid-step.
      return turn.tool_result === undefined ? "natural" : "unknown";
    default:
      return undefined;
  }
}

/**
 * The context of a session. One pass over `session.turns`; cost is linear in the turns and in the head of each tool output.
 * Shell commands come from tool calls only (a harness's own prose is not evidence that a command ran); the directory and
 * the branch come from `session.metadata`, which readers fill from the harness's native records.
 */
export function sessionContextOf(session: SessionRecord): SessionContext {
  const findings: Findings = { testStatus: "unknown", errors: [] };
  const worktrees: string[] = [];
  const sideEffects: string[] = [];
  const otherProjects: string[] = [];
  const workingDir = session.metadata?.cwd ?? null;
  let commandBranch: string | undefined;
  let gitStatus: SessionContext["git_status"] = "unknown";
  let lastUserMessage: string | null = null;
  const gitStatusCalls = new Set<string>();
  const hasToolResults = session.turns.some((turn) => turn.tool_result !== undefined);

  for (const turn of session.turns) {
    if (turn.role === "user") {
      const text = turn.text.trim();
      if (turn.synthetic_reason === undefined && text !== "" && isHumanAsk(text)) lastUserMessage = text;
    } else if (turn.role === "agent" && !hasToolResults) {
      // A transcript with no tool results (Cursor's) shows test runs and failures only in what the agent said.
      classifyOutput(turn.text, findings);
    }
    const call = turn.tool_call;
    if (call !== undefined) {
      if (call.name === "Agent" && call.input.isolation === "worktree") worktrees.push(AUTO_MANAGED_WORKTREE);
      const command = commandOf(call.name, call.input);
      if (command !== "") {
        const idents = vcsIdents(command);
        worktrees.push(...idents.worktrees);
        if (idents.branch !== undefined) commandBranch = idents.branch;
        sideEffects.push(...sideEffectsOf(command));
        if (RE_GIT_STATUS.test(command)) gitStatusCalls.add(call.id);
      }
      const filePath = filePathOf(call.name, call.input);
      const project = filePath === undefined || workingDir === null || filePath.startsWith(workingDir)
        ? undefined
        : guessProjectRoot(filePath);
      if (project !== undefined && !workingDir?.startsWith(`${project}/`)) otherProjects.push(project);
    }
    const result = turn.tool_result;
    if (result !== undefined) {
      classifyOutput(result.output, findings, result.signals);
      if (gitStatusCalls.has(result.id)) gitStatus = gitStatusOf(result.output, gitStatus);
    }
  }

  const lastTurn = [...session.turns].reverse().find((turn) => endOf(turn) !== undefined);
  return {
    working_dir: workingDir,
    worktrees: distinct(worktrees),
    other_projects: distinct(otherProjects),
    git_branch: session.metadata?.git_branch ?? commandBranch ?? null,
    git_status: gitStatus,
    last_user_message: lastUserMessage,
    test_status: findings.testStatus,
    session_end: lastTurn === undefined ? "unknown" : (endOf(lastTurn) ?? "unknown"),
    errors_seen: findings.errors.slice(-MAX_ERRORS_KEPT),
    side_effects: distinct(sideEffects),
  };
}

const RE_GIT_CLEAN = /nothing to commit, working (?:tree|directory) clean/;
const RE_GIT_DIRTY = /^(?:Changes (?:not staged for commit|to be committed)|Untracked files):|^[ MADRCU?!]{2} \S/m;

/** `clean` or `dirty` from the output of `git status` (long or porcelain form); `previous` when the output says neither. */
function gitStatusOf(output: string, previous: SessionContext["git_status"]): SessionContext["git_status"] {
  if (RE_GIT_DIRTY.test(output)) return "dirty";
  if (RE_GIT_CLEAN.test(output)) return "clean";
  return previous;
}
