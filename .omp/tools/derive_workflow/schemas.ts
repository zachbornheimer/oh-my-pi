/** The types the derive_workflow tool passes between its steps, and the grammar of a workflow's name. */

/** The skill directory name the workflow renders to: lower-case words joined by hyphens. */
export const isWorkflowName = (name: string): boolean => {
  const [first = "", ...rest] = name.split("-");
  return /^[a-z][a-z0-9]*$/.test(first) && rest.every((word) => /^[a-z0-9]+$/.test(word));
};
export const WORKFLOW_NAME_MESSAGE = 'must be lower-case words joined by hyphens, such as "webmaster" or "new-site"';

export const STEP_KINDS = ["command", "judgment", "approval", "edit"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const FAILURE_POLICIES = ["stop", "retry_once", "ask"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];

/** Where a step comes from in the source: a tool call of a transcript, or a line of a document. */
export type Evidence = { readonly turn_id: number; readonly call_id: string } | { readonly line: number };

/** The tool output a transcript turn keeps: its first characters. */
export const TOOL_OUTPUT_HEAD_CHARS = 2000;

/** One normalized turn of a transcript. Only `user` and `agent` turns are a conversation; `tool` turns carry a call or a result. */
export interface TranscriptTurn {
  readonly role: "user" | "agent" | "tool" | "context";
  readonly text: string;
  readonly tool_call?: { readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };
  readonly tool_result?: { readonly id: string; readonly output: string; readonly is_error: boolean };
  readonly synthetic_reason?: string;
}

export interface Transcript {
  readonly path: string;
  readonly turns: readonly TranscriptTurn[];
  readonly skipped_lines: number;
}

/** A document the reader read: where it is and its text. */
export interface SourceDocument {
  readonly path: string;
  readonly text: string;
}

/** What the tool has read of the source: a transcript with its tool calls, or a document. */
export interface DeriveInput {
  readonly source: string;
  readonly name?: string;
  readonly from_turn?: number;
  readonly to_turn?: number;
  readonly transcript?: Transcript;
  readonly document?: SourceDocument;
}

export interface Step {
  readonly key: string;
  readonly title: string;
  readonly kind: StepKind;
  /** The command to run; only a `command` step has one. `{name}` marks an input. */
  readonly run?: string;
  /** The inputs this step uses, by name. */
  readonly needs?: string[];
  readonly requires: string[];
  /** An atask-grammar check, or `states: ...` for a gate with no command. */
  readonly check?: string;
  readonly on_failure: FailurePolicy;
  readonly evidence: Evidence[];
}

export interface WorkflowInput {
  readonly name: string;
  readonly description: string;
  /** The literal the workflow was derived from, shown as an example. */
  readonly example?: string;
}

export interface Dropped {
  readonly reads: number;
  readonly retries: number;
  readonly failed: number;
  readonly incidental: number;
}

export const APPLY_OUTCOMES = ["written", "exists"] as const;

export interface Workflow {
  readonly name: string;
  readonly description: string;
  readonly trigger: { readonly usage: string; readonly argument_hint?: string };
  readonly inputs: WorkflowInput[];
  readonly steps: Step[];
  readonly rules: string[];
  readonly outputs: { readonly name: string; readonly where: string }[];
  /** Each input's original literal by input name, so a `{name}` rendering can be turned back into the source's words. */
  readonly literals: Record<string, string>;
  readonly skill_markdown: string;
  readonly source: {
    readonly ref?: string;
    readonly path?: string;
    readonly candidates_seen: number;
    readonly candidates_kept: number;
    readonly dropped: Dropped;
  };
  /** Set only when `apply` was true: where the SKILL.md went, or the existing file it refused to overwrite. */
  readonly applied?: { readonly path: string; readonly outcome: (typeof APPLY_OUTCOMES)[number] };
}

/** A conversation ref as `source` names it: `<harness>:<id>`. */
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
export const isConversationRef = (source: string): boolean => CONVERSATION_REF.test(source);
