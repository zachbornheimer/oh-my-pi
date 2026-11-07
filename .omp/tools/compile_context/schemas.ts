/**
 * compile_context's types and its input reading. Mirrors agentmux's Go structs: a `null` or missing string, list, object,
 * number or boolean reads as Go's zero value ("", [], {}, 0, false), so a missing field is the run's validation error
 * and not a schema error. A value of the wrong type is refused naming its path.
 */

/** Kinds of item a compiled context bundle can hold (agentmux `ContextKind*`). */
export const CONTEXT_KINDS = ["project", "intent", "work_item", "obligation", "evidence"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** How compile_context measured size and what it never used (agentmux `ContextBasis`). */
export const CONTEXT_BASIS = "estimate:runes/4;deterministic;no-transcript;no-model";

export interface Origin {
  kind: string;
  ref?: string;
}

export interface Obligation {
  id: string;
  text: string;
  kind: string;
  status: string;
  origin: Origin;
  evidence?: string;
  blocked_on?: string;
  supersedes?: string;
  superseded_by?: string;
  goal_ids?: string[];
}

export interface Decision {
  name: string;
  choice: string;
  origin: Origin;
}

export interface Fact {
  name: string;
  value: string;
  origin: Origin;
}

/** Durable project state (agentmux `project.ProjectState`). Read by the caller from its store, never from transcripts. */
export interface ProjectState {
  project_id: string;
  name?: string;
  intent?: string;
  obligations: Obligation[];
  decisions?: Decision[];
  facts?: Fact[];
  skills?: string[];
  runs?: string[];
  rev: number;
}

export interface WorkItem {
  id: string;
  text: string;
  /** Empty means every live obligation is needed. */
  obligation_ids: string[];
}

export interface ContextEvidence {
  id: string;
  source: string;
  ref: string;
  text: string;
  relevance: number;
  required: boolean;
}

/** Zero means unlimited for that dimension. */
export interface ContextBudget {
  max_items: number;
  max_chars: number;
  max_tokens: number;
}

export interface ContextProvenance {
  source: string;
  ref: string;
}

export interface ContextItem {
  kind: ContextKind;
  id: string;
  text: string;
  required?: boolean;
  relevance?: number;
  provenance: ContextProvenance;
}

export interface OmittedContext {
  kind: ContextKind;
  id: string;
  reason: string;
  provenance: ContextProvenance;
}

export interface CompileContextInput {
  state: ProjectState;
  work: WorkItem;
  evidence: ContextEvidence[];
  budget: ContextBudget;
}

export interface CompileContextResult {
  project_id: string;
  rev: number;
  items: ContextItem[];
  omitted: OmittedContext[];
  chars: number;
  estimated_tokens: number;
  basis: string;
  budget: { max_items?: number; max_chars?: number; max_tokens?: number };
}

const INPUT_ERROR = "compile_context: invalid input: ";

function fail(path: string, wanted: string, value: unknown): never {
  throw new Error(`${INPUT_ERROR}${path} must be ${wanted}, got ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, path: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") fail(path, "a string", value);
  return value;
}

function optionalStr(value: unknown, path: string): string | undefined {
  return value === null || value === undefined ? undefined : str(value, path);
}

function integer(value: unknown, path: string): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) fail(path, "an integer", value);
  return value;
}

function finite(value: unknown, path: string): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || Number.isNaN(value)) fail(path, "a number", value);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "boolean") fail(path, "true or false", value);
  return value;
}

function list<T>(value: unknown, path: string, item: (entry: unknown, at: string) => T): T[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "a list", value);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function strings(value: unknown, path: string): string[] {
  return list(value, path, str);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) fail(path, "an object", value);
  return value;
}

function origin(value: unknown, path: string): Origin {
  const raw = record(value, path);
  const ref = optionalStr(raw.ref, `${path}.ref`);
  return { kind: str(raw.kind, `${path}.kind`), ...(ref === undefined ? {} : { ref }) };
}

function obligation(value: unknown, path: string): Obligation {
  const raw = record(value, path);
  const result: Obligation = {
    id: str(raw.id, `${path}.id`),
    text: str(raw.text, `${path}.text`),
    kind: str(raw.kind, `${path}.kind`),
    status: str(raw.status, `${path}.status`),
    origin: origin(raw.origin, `${path}.origin`),
  };
  for (const key of ["evidence", "blocked_on", "supersedes", "superseded_by"] as const) {
    const text = optionalStr(raw[key], `${path}.${key}`);
    if (text !== undefined) result[key] = text;
  }
  if (raw.goal_ids !== null && raw.goal_ids !== undefined) result.goal_ids = strings(raw.goal_ids, `${path}.goal_ids`);
  return result;
}

function projectState(value: unknown, path: string): ProjectState {
  const raw = record(value, path);
  const state: ProjectState = {
    project_id: str(raw.project_id, `${path}.project_id`),
    obligations: list(raw.obligations, `${path}.obligations`, obligation),
    rev: integer(raw.rev, `${path}.rev`),
  };
  const name = optionalStr(raw.name, `${path}.name`);
  if (name !== undefined) state.name = name;
  const intent = optionalStr(raw.intent, `${path}.intent`);
  if (intent !== undefined) state.intent = intent;
  if (raw.decisions !== null && raw.decisions !== undefined) {
    state.decisions = list(raw.decisions, `${path}.decisions`, (entry, at) => {
      const decision = record(entry, at);
      return {
        name: str(decision.name, `${at}.name`),
        choice: str(decision.choice, `${at}.choice`),
        origin: origin(decision.origin, `${at}.origin`),
      };
    });
  }
  if (raw.facts !== null && raw.facts !== undefined) {
    state.facts = list(raw.facts, `${path}.facts`, (entry, at) => {
      const fact = record(entry, at);
      return {
        name: str(fact.name, `${at}.name`),
        value: str(fact.value, `${at}.value`),
        origin: origin(fact.origin, `${at}.origin`),
      };
    });
  }
  if (raw.skills !== null && raw.skills !== undefined) state.skills = strings(raw.skills, `${path}.skills`);
  if (raw.runs !== null && raw.runs !== undefined) state.runs = strings(raw.runs, `${path}.runs`);
  return state;
}

function workItem(value: unknown, path: string): WorkItem {
  const raw = record(value, path);
  return {
    id: str(raw.id, `${path}.id`),
    text: str(raw.text, `${path}.text`),
    obligation_ids: strings(raw.obligation_ids, `${path}.obligation_ids`),
  };
}

function evidence(value: unknown, path: string): ContextEvidence {
  const raw = record(value, path);
  return {
    id: str(raw.id, `${path}.id`),
    source: str(raw.source, `${path}.source`),
    ref: str(raw.ref, `${path}.ref`),
    text: str(raw.text, `${path}.text`),
    relevance: finite(raw.relevance, `${path}.relevance`),
    required: bool(raw.required, `${path}.required`),
  };
}

function budget(value: unknown, path: string): ContextBudget {
  const raw = record(value, path);
  return {
    max_items: integer(raw.max_items, `${path}.max_items`),
    max_chars: integer(raw.max_chars, `${path}.max_chars`),
    max_tokens: integer(raw.max_tokens, `${path}.max_tokens`),
  };
}

/** The input as Go would decode it: nulls and missing fields are zero values; a wrong type is refused naming its path. */
export function readInput(raw: unknown): CompileContextInput {
  const input = record(raw, "input");
  return {
    state: projectState(input.state, "state"),
    work: workItem(input.work, "work"),
    evidence: list(input.evidence, "evidence", evidence),
    budget: budget(input.budget, "budget"),
  };
}
