import { compareBytes, quote, trimSpace } from "./go_text.js";

/** Pure reconciliation of verified result decisions into proposed obligation changes. Nothing is persisted. */

const NAME = "reconcile_results";

export const VERIFICATION_STATUSES = ["satisfied", "failed", "verifier_failure", "indeterminate"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type Disposition = "satisfied" | "blocked" | "unresolved" | "unchanged";

export interface Origin {
  kind: string;
  ref: string;
}
export interface Obligation {
  id: string;
  text: string;
  kind: string;
  status: string;
  origin: Origin;
  evidence: string;
  blocked_on: string;
  supersedes: string;
  superseded_by: string;
  goal_ids: string[];
}
export interface ProjectState {
  project_id: string;
  name: string;
  intent: string;
  obligations: Obligation[];
  decisions: { name: string; choice: string; origin: Origin }[];
  facts: { name: string; value: string; origin: Origin }[];
  skills: string[];
  runs: string[];
  rev: number;
}
export interface ResultDecision {
  obligation_id: string;
  status: string;
  evidence: string;
  execution_completed: boolean;
  failure: { class: string; next_action: string; signature: string; rationale: string[] } | null;
}
export interface ReconcileResultsInput {
  state: ProjectState;
  results: ResultDecision[];
}
export interface Change {
  action: "satisfy" | "block";
  id: string;
  evidence?: string;
  blocked_on?: string;
}
export interface ReconciledResult {
  obligation_id: string;
  verification: VerificationStatus;
  disposition: Disposition;
  change?: Change;
  next_action?: string;
  reason: string;
}
export interface Reconciliation {
  project_id: string;
  results: ReconciledResult[];
  changes?: Change[];
  unaffected?: string[];
  projected: Record<string, unknown> & { project_id: string; rev: number };
}

// ---- input: JSON null or a missing field reads as Go's zero value, as the Go structs decode ----

type Raw = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new Error(`${NAME}: invalid input: ${path} must be ${expected}`);
}
function str(value: unknown, path: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") fail(path, "a string");
  return value;
}
function obj(value: unknown, path: string): Raw {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(path, "an object");
  return value as Raw;
}
function list<T>(value: unknown, path: string, item: (entry: unknown, at: string) => T): T[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "an array");
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}
function origin(value: unknown, path: string): Origin {
  const raw = obj(value, path);
  return { kind: str(raw.kind, `${path}.kind`), ref: str(raw.ref, `${path}.ref`) };
}

/** Reads the caller's JSON into the full shape; a wrong type is refused naming the field. */
export function normalizeInput(input: unknown): ReconcileResultsInput {
  const root = obj(input, "input");
  const state = obj(root.state, "state");
  const rev = state.rev ?? 0;
  if (typeof rev !== "number" || !Number.isInteger(rev)) fail("state.rev", "an integer");
  return {
    state: {
      project_id: str(state.project_id, "state.project_id"),
      name: str(state.name, "state.name"),
      intent: str(state.intent, "state.intent"),
      obligations: list(state.obligations, "state.obligations", (entry, at) => {
        const o = obj(entry, at);
        return {
          id: str(o.id, `${at}.id`),
          text: str(o.text, `${at}.text`),
          kind: str(o.kind, `${at}.kind`),
          status: str(o.status, `${at}.status`),
          origin: origin(o.origin, `${at}.origin`),
          evidence: str(o.evidence, `${at}.evidence`),
          blocked_on: str(o.blocked_on, `${at}.blocked_on`),
          supersedes: str(o.supersedes, `${at}.supersedes`),
          superseded_by: str(o.superseded_by, `${at}.superseded_by`),
          goal_ids: list(o.goal_ids, `${at}.goal_ids`, (g, gat) => str(g, gat)),
        };
      }),
      decisions: list(state.decisions, "state.decisions", (entry, at) => {
        const d = obj(entry, at);
        return { name: str(d.name, `${at}.name`), choice: str(d.choice, `${at}.choice`), origin: origin(d.origin, `${at}.origin`) };
      }),
      facts: list(state.facts, "state.facts", (entry, at) => {
        const f = obj(entry, at);
        return { name: str(f.name, `${at}.name`), value: str(f.value, `${at}.value`), origin: origin(f.origin, `${at}.origin`) };
      }),
      skills: list(state.skills, "state.skills", (s, at) => str(s, at)),
      runs: list(state.runs, "state.runs", (s, at) => str(s, at)),
      rev,
    },
    results: list(root.results, "results", (entry, at) => {
      const r = obj(entry, at);
      const completed = r.execution_completed ?? false;
      if (typeof completed !== "boolean") fail(`${at}.execution_completed`, "a boolean");
      const failure =
        r.failure === null || r.failure === undefined
          ? null
          : (() => {
              const f = obj(r.failure, `${at}.failure`);
              return {
                class: str(f.class, `${at}.failure.class`),
                next_action: str(f.next_action, `${at}.failure.next_action`),
                signature: str(f.signature, `${at}.failure.signature`),
                rationale: list(f.rationale, `${at}.failure.rationale`, (x, xat) => str(x, xat)),
              };
            })();
      return {
        obligation_id: str(r.obligation_id, `${at}.obligation_id`),
        status: str(r.status, `${at}.status`),
        evidence: str(r.evidence, `${at}.evidence`),
        execution_completed: completed,
        failure,
      };
    }),
  };
}

// ---- decisions ----

/** The failure class each non-success status implies. */
const FAILURE_CLASS_FOR: ReadonlyMap<string, string> = new Map([
  ["failed", "implementation"],
  ["verifier_failure", "environment"],
  ["indeterminate", "evidence"],
]);

interface CanonicalDecision extends ResultDecision {
  readonly status: VerificationStatus;
}

/**
 * Validates, trims, dedupes identical repeats, and orders by obligation id so the outcome does not depend on
 * input order. Every bad decision is reported, joined by newlines.
 */
function canonicalDecisions(input: readonly ResultDecision[]): CanonicalDecision[] {
  if (input.length === 0) throw new Error(`${NAME}: results is empty; supply at least one verified decision`);
  const byId = new Map<string, CanonicalDecision>();
  const errors: string[] = [];
  for (const raw of input) {
    const decision = { ...raw, obligation_id: trimSpace(raw.obligation_id), evidence: trimSpace(raw.evidence) };
    const problem = invalidReason(decision);
    if (problem !== undefined) {
      errors.push(problem);
      continue;
    }
    const previous = byId.get(decision.obligation_id);
    if (previous === undefined) {
      byId.set(decision.obligation_id, decision as CanonicalDecision);
    } else if (previous.status !== decision.status || previous.evidence !== decision.evidence) {
      errors.push(
        `${NAME}: obligation ${quote(decision.obligation_id)} has contradictory decisions (${previous.status} vs ${decision.status})`,
      );
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return [...byId.values()].sort((a, b) => compareBytes(a.obligation_id, b.obligation_id));
}

function invalidReason(decision: ResultDecision): string | undefined {
  const id = quote(decision.obligation_id);
  if (decision.obligation_id === "") return `${NAME}: decision has no obligation_id`;
  if (decision.evidence === "") return `${NAME}: obligation ${id} needs evidence; an executor claim is not evidence`;
  const failure = decision.failure ?? undefined;
  if (decision.status === "satisfied") {
    return failure === undefined ? undefined : `${NAME}: obligation ${id} is satisfied but carries a failure classification`;
  }
  const implied = FAILURE_CLASS_FOR.get(decision.status);
  if (implied === undefined) return `${NAME}: obligation ${id} has unknown verification status ${quote(decision.status)}`;
  if (failure !== undefined && failure.class !== implied) {
    return `${NAME}: obligation ${id} status ${decision.status} implies ${implied} failure, got ${failure.class}`;
  }
  return undefined;
}

// ---- applying a change to the state ----

function isLive(obligation: Obligation): boolean {
  return obligation.status === "open" || obligation.status === "blocked";
}

function applyChange(state: ProjectState, change: Change): ProjectState {
  const id = trimSpace(change.id);
  if (id === "") throw new Error("apply change: obligation id is empty");
  const index = state.obligations.findIndex((obligation) => obligation.id === id);
  const current = state.obligations[index];
  if (current === undefined) throw new Error(`apply change ${change.action}: obligation ${quote(id)} not found`);
  const updated = change.action === "satisfy" ? satisfy(current, change) : block(current, change);
  return { ...state, obligations: state.obligations.map((obligation, at) => (at === index ? updated : obligation)) };
}

function satisfy(current: Obligation, change: Change): Obligation {
  const evidence = trimSpace(change.evidence ?? "");
  if (evidence === "") throw new Error(`satisfy ${quote(current.id)}: evidence is required`);
  requireLive(current, "satisfy");
  return { ...current, status: "satisfied", evidence, blocked_on: "" };
}

function block(current: Obligation, change: Change): Obligation {
  const blockedOn = trimSpace(change.blocked_on ?? "");
  if (blockedOn === "") throw new Error(`block ${quote(current.id)}: blocked_on is required`);
  requireLive(current, "block");
  return { ...current, status: "blocked", blocked_on: blockedOn };
}

function requireLive(current: Obligation, verb: string): void {
  if (!isLive(current)) throw new Error(`${verb} ${quote(current.id)}: status ${current.status} is not live`);
}

// ---- output encoding: empty strings and lists are omitted, as Go's `omitempty` does ----

function present<K extends string, V extends string | readonly unknown[]>(key: K, value: V): { [P in K]?: V } {
  return value.length === 0 ? {} : ({ [key]: value } as { [P in K]: V });
}
function encodeOrigin(value: Origin): { kind: string; ref?: string } {
  return { kind: value.kind, ...present("ref", value.ref) };
}
function encodeState(state: ProjectState): Reconciliation["projected"] {
  return {
    project_id: state.project_id,
    ...present("name", state.name),
    ...present("intent", state.intent),
    ...present(
      "obligations",
      state.obligations.map((o) => ({
        id: o.id,
        text: o.text,
        kind: o.kind,
        status: o.status,
        origin: encodeOrigin(o.origin),
        ...present("evidence", o.evidence),
        ...present("blocked_on", o.blocked_on),
        ...present("supersedes", o.supersedes),
        ...present("superseded_by", o.superseded_by),
        ...present("goal_ids", o.goal_ids),
      })),
    ),
    ...present("decisions", state.decisions.map((d) => ({ name: d.name, choice: d.choice, origin: encodeOrigin(d.origin) }))),
    ...present("facts", state.facts.map((f) => ({ name: f.name, value: f.value, origin: encodeOrigin(f.origin) }))),
    ...present("skills", state.skills),
    ...present("runs", state.runs),
    rev: state.rev,
  };
}

// ---- the fold ----

/** Marks an obligation blocked by a broken verifier. */
const VERIFIER_FAILURE_PREFIX = "verifier_failure: ";

interface Folded {
  readonly record: ReconciledResult;
  readonly state: ProjectState;
}

/** Folds verified decisions into obligation changes. A proposal only: nothing is persisted. */
export function reconcileResults(raw: unknown): Reconciliation {
  const input = normalizeInput(raw);
  if (trimSpace(input.state.project_id) === "") throw new Error(`${NAME}: state.project_id is empty`);
  const decisions = canonicalDecisions(input.results);
  let state = input.state;
  const touched = new Set<string>();
  const results: ReconciledResult[] = [];
  const changes: Change[] = [];
  const errors: string[] = [];
  for (const decision of decisions) {
    try {
      const folded = reconcileOne(state, decision);
      state = folded.state;
      touched.add(decision.obligation_id);
      results.push(inWireOrder(folded.record));
      if (folded.record.change !== undefined) changes.push(folded.record.change);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const unaffected = state.obligations.filter((o) => isLive(o) && !touched.has(o.id)).map((o) => o.id);
  return {
    project_id: input.state.project_id,
    results,
    ...(changes.length > 0 ? { changes } : {}),
    ...(unaffected.length > 0 ? { unaffected } : {}),
    projected: encodeState(state),
  };
}

/** The keys in the order the agentmux original writes them, so the JSON text is the same too. */
function inWireOrder(record: ReconciledResult): ReconciledResult {
  return {
    obligation_id: record.obligation_id,
    verification: record.verification,
    disposition: record.disposition,
    ...(record.change === undefined ? {} : { change: record.change }),
    ...(record.next_action === undefined ? {} : { next_action: record.next_action }),
    reason: record.reason,
  };
}

function reconcileOne(state: ProjectState, decision: CanonicalDecision): Folded {
  const current = state.obligations.find((o) => o.id === decision.obligation_id);
  if (current === undefined) {
    throw new Error(`${NAME}: obligation ${quote(decision.obligation_id)} not found in project ${quote(state.project_id)}`);
  }
  const nextAction = decision.failure?.next_action ?? "";
  const record: ReconciledResult = {
    obligation_id: decision.obligation_id,
    verification: decision.status,
    disposition: "unresolved",
    ...(nextAction === "" ? {} : { next_action: nextAction }),
    reason: "",
  };
  if (decision.status === "satisfied") return satisfyDecision(state, current, decision, record);
  if (current.status === "satisfied") {
    throw new Error(
      `${NAME}: obligation ${quote(current.id)} is already satisfied; refusing to reopen it on a ${decision.status} result`,
    );
  }
  if (decision.status === "verifier_failure") return blockDecision(state, current, decision, record);
  return unresolvedDecision(state, current, decision, record);
}

function satisfyDecision(state: ProjectState, current: Obligation, decision: CanonicalDecision, record: ReconciledResult): Folded {
  if (current.status === "satisfied" && current.evidence === decision.evidence) {
    return unchanged(state, record, "already satisfied with the same evidence");
  }
  if (current.status === "satisfied") {
    throw new Error(`${NAME}: obligation ${quote(current.id)} is already satisfied with different evidence`);
  }
  const change: Change = { action: "satisfy", id: current.id, evidence: decision.evidence };
  return applyDecision(state, change, "satisfied", "verification satisfied with evidence", record);
}

function blockDecision(state: ProjectState, current: Obligation, decision: CanonicalDecision, record: ReconciledResult): Folded {
  const blockedOn = VERIFIER_FAILURE_PREFIX + decision.evidence;
  if (current.status === "blocked" && current.blocked_on === blockedOn) {
    return unchanged(state, record, "already blocked on the same verifier failure");
  }
  const change: Change = { action: "block", id: current.id, blocked_on: blockedOn };
  return applyDecision(
    state,
    change,
    "blocked",
    "verifier failure says nothing about the work; blocked until verification can run",
    record,
  );
}

function unresolvedDecision(state: ProjectState, current: Obligation, decision: CanonicalDecision, record: ReconciledResult): Folded {
  if (!isLive(current)) {
    throw new Error(`${NAME}: obligation ${quote(current.id)} has status ${current.status} and cannot take a ${decision.status} result`);
  }
  const reason = `verification ${decision.status}; obligation stays ${current.status}`;
  return { record: { ...record, disposition: "unresolved", reason }, state };
}

function unchanged(state: ProjectState, record: ReconciledResult, reason: string): Folded {
  return { record: { ...record, disposition: "unchanged", reason }, state };
}

function applyDecision(
  state: ProjectState,
  change: Change,
  disposition: Disposition,
  reason: string,
  record: ReconciledResult,
): Folded {
  try {
    return { record: { ...record, disposition, reason, change }, state: applyChange(state, change) };
  } catch (error) {
    throw new Error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
