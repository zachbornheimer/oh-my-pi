import { createHash } from "node:crypto";

export type FailureClass = "implementation" | "environment" | "evidence";
export type NextAction =
  | "retry_with_failure_evidence"
  | "rerun_verification"
  | "repair_environment"
  | "strengthen_verification"
  | "request_context"
  | "escalate"
  | "request_human";

export interface CriterionVerdict {
  criterion?: string | null;
  status?: string | null;
  reason?: string | null;
}
export interface VerificationOutcome {
  status?: string | null;
  criteria?: CriterionVerdict[] | null;
}
export interface AttemptRecord {
  signature?: string | null;
  action?: string | null;
}
export interface ClassifyInput {
  outcome?: VerificationOutcome | null;
  history?: AttemptRecord[] | null;
  environment_fixed?: boolean | null;
}
export interface FailureClassification {
  class: FailureClass;
  next_action: NextAction;
  signature: string;
  rationale: string[];
}

/** The reason a criterion stays undecided that changes the advice. */
export const MISSING_EVIDENCE = "missing_evidence";

/** Each class's actions, cheapest first. */
const ACTION_LADDERS: Readonly<Record<FailureClass, readonly NextAction[]>> = {
  implementation: ["retry_with_failure_evidence", "escalate", "request_human"],
  environment: ["rerun_verification", "repair_environment", "request_human"],
  evidence: ["strengthen_verification", "request_human"],
};

/** Evidence that is absent rather than weak: asking for context is cheaper than a stronger verifier. */
const MISSING_CONTEXT_LADDER: readonly NextAction[] = ["request_context", "strengthen_verification", "request_human"];

/** The environment ladder without the rerun: a failure that stays until repaired cannot be cleared by rerunning. */
const FIXED_ENVIRONMENT_LADDER: readonly NextAction[] = ["repair_environment", "request_human"];

const SIGNATURE_BYTES = 8;

const CLASS_OF_STATUS = new Map<string, FailureClass>([
  ["failed", "implementation"],
  ["verifier_failure", "environment"],
  ["indeterminate", "evidence"],
]);

/** Go's `strings.Compare`: by UTF-8 bytes (the default JS sort uses UTF-16 units and disagrees outside ASCII). */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

interface Normalized {
  status: string;
  criteria: { criterion: string; status: string; reason: string }[];
  history: { signature: string; action: string }[];
  environmentFixed: boolean;
}

function text(value: unknown, where: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`classify_failure: ${where} must be a string`);
  return value;
}

function normalize(input: ClassifyInput): Normalized {
  const outcome = input.outcome ?? {};
  const criteria = (outcome.criteria ?? []).map((verdict, index) => ({
    criterion: text(verdict?.criterion, `outcome.criteria[${index}].criterion`),
    status: text(verdict?.status, `outcome.criteria[${index}].status`),
    reason: text(verdict?.reason, `outcome.criteria[${index}].reason`),
  }));
  const history = (input.history ?? []).map((attempt, index) => ({
    signature: text(attempt?.signature, `history[${index}].signature`),
    action: text(attempt?.action, `history[${index}].action`),
  }));
  return {
    status: text(outcome.status, "outcome.status"),
    criteria,
    history,
    environmentFixed: input.environment_fixed === true,
  };
}

/** Classifies a non-satisfied outcome and recommends the first ladder action not already tried against this exact failure. */
export function classifyFailure(input: ClassifyInput): FailureClassification {
  const outcome = normalize(input);
  const failureClass = failureClassOf(outcome.status);
  const signature = failureSignature(outcome.criteria);
  const ladder = ladderFor(failureClass, outcome);
  const { action, repeated } = firstUntriedAction(ladder, signature, outcome.history);
  const rationale = [`verification ${outcome.status} maps to ${failureClass} failure`];
  if (repeated.length > 0) {
    rationale.push(`already tried with no change in evidence: ${repeated.join(", ")}`);
  }
  return { class: failureClass, next_action: action, signature, rationale };
}

function failureClassOf(status: string): FailureClass {
  if (status === "satisfied") {
    throw new Error("classify_failure: outcome is satisfied; there is no failure to classify");
  }
  // A Map, not an object lookup: a status such as "constructor" must not resolve through Object.prototype.
  const failureClass = CLASS_OF_STATUS.get(status);
  if (failureClass === undefined) {
    throw new Error(`classify_failure: unknown verification status ${JSON.stringify(status)}`);
  }
  return failureClass;
}

function ladderFor(failureClass: FailureClass, outcome: Normalized): readonly NextAction[] {
  if (failureClass === "environment" && outcome.environmentFixed) return FIXED_ENVIRONMENT_LADDER;
  if (failureClass === "evidence" && hasMissingEvidence(outcome.criteria)) return MISSING_CONTEXT_LADDER;
  return ACTION_LADDERS[failureClass];
}

/** Walks the ladder past actions already tried against this signature: the failure is identical, so repeating adds nothing. */
function firstUntriedAction(
  ladder: readonly NextAction[],
  signature: string,
  history: readonly { signature: string; action: string }[],
): { action: NextAction; repeated: string[] } {
  const repeated: string[] = [];
  for (const action of ladder) {
    if (!history.some((attempt) => attempt.signature === signature && attempt.action === action)) {
      return { action, repeated };
    }
    repeated.push(action);
  }
  return { action: "request_human", repeated };
}

function hasMissingEvidence(criteria: readonly { status: string; reason: string }[]): boolean {
  return criteria.some((verdict) => verdict.status === "indeterminate" && verdict.reason === MISSING_EVIDENCE);
}

/** A stable digest of which criteria are unresolved and why: sha256 of the sorted `criterion:status:reason` lines. */
export function failureSignature(criteria: readonly { criterion: string; status: string; reason: string }[]): string {
  const parts = criteria
    .filter((verdict) => verdict.status !== "satisfied")
    .map((verdict) => `${verdict.criterion}:${verdict.status}:${verdict.reason}`)
    .sort(compareBytes);
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, SIGNATURE_BYTES * 2);
}

/** The text the model reads: the classification as compact lines. */
export function classificationText(result: FailureClassification): string {
  return [
    `class: ${result.class}`,
    `next_action: ${result.next_action}`,
    `signature: ${result.signature}`,
    ...result.rationale.map((line) => `- ${line}`),
  ].join("\n");
}
