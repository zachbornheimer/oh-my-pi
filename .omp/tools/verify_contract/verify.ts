import { quote } from "./gotext.js";

/** The closed set of verification statuses. */
export const VERIFICATION_STATUSES = ["satisfied", "failed", "verifier_failure", "indeterminate"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Why a criterion could not be decided. */
export type IndeterminateReason =
  | "missing_evidence"
  | "contradictory_evidence"
  | "insufficient_strength"
  | "non_discriminating";

export interface Criterion {
  id: string;
  description: string;
  min_strength: string;
}

/** One deterministic check's report. `strength` and `result` stay open strings here; `verifyContract` rejects unknown ones. */
export interface Observation {
  criterion: string;
  source: string;
  result: string;
  strength: string;
  detail: string;
  passes_on_known_bad_basis: boolean;
}

export interface VerifyContractInput {
  contract: string;
  criteria: Criterion[];
  evidence: Observation[];
  execution_completed: boolean;
}

export interface CriterionVerdict {
  criterion: string;
  status: VerificationStatus;
  reason?: IndeterminateReason;
  sources?: string[];
  details?: string[];
}

export interface VerificationOutcome {
  status: VerificationStatus;
  criteria: CriterionVerdict[];
}

const INVALID = "invalid input for verify_contract";

function bad(where: string, expected: string): never {
  throw new Error(`${INVALID}: ${where}: expected ${expected}`);
}

/** Text; a missing or `null` value is the empty string. */
function text(value: unknown, where: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") bad(where, "a string");
  return value;
}

/** A flag; a missing or `null` value is false. */
function flag(value: unknown, where: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") bad(where, "true or false");
  return value;
}

/** A list of objects; a missing or `null` value is the empty list. */
function list(value: unknown, where: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(where, "an array");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) bad(`${where}[${index}]`, "an object");
    return item as Record<string, unknown>;
  });
}

/**
 * The call's arguments with absent and `null` fields read as their empty value, the way the Go original decoded them,
 * and any wrongly typed field refused. Whether the values make sense is `verifyContract`'s judgment.
 */
export function normalizeInput(params: unknown): VerifyContractInput {
  if (params === undefined || params === null) return { contract: "", criteria: [], evidence: [], execution_completed: false };
  if (typeof params !== "object" || Array.isArray(params)) bad("the call", "an object");
  const input = params as Record<string, unknown>;
  return {
    contract: text(input.contract, "contract"),
    criteria: list(input.criteria, "criteria").map((item, index) => ({
      id: text(item.id, `criteria[${index}].id`),
      description: text(item.description, `criteria[${index}].description`),
      min_strength: text(item.min_strength, `criteria[${index}].min_strength`),
    })),
    evidence: list(input.evidence, "evidence").map((item, index) => ({
      criterion: text(item.criterion, `evidence[${index}].criterion`),
      source: text(item.source, `evidence[${index}].source`),
      result: text(item.result, `evidence[${index}].result`),
      strength: text(item.strength, `evidence[${index}].strength`),
      detail: text(item.detail, `evidence[${index}].detail`),
      passes_on_known_bad_basis: flag(item.passes_on_known_bad_basis, `evidence[${index}].passes_on_known_bad_basis`),
    })),
    execution_completed: flag(input.execution_completed, "execution_completed"),
  };
}

/** Statuses from most to least severe: a real failure outranks a verifier failure, which outranks an undecided criterion. */
const FOLD_ORDER: readonly VerificationStatus[] = ["failed", "verifier_failure", "indeterminate"];

/** Decides each criterion from its own evidence, then folds the verdicts into one outcome. */
export function verifyContract(input: VerifyContractInput): VerificationOutcome {
  const byCriterion = groupEvidence(input);
  const criteria = input.criteria.map((criterion) => judgeCriterion(criterion, byCriterion.get(criterion.id) ?? []));
  return { status: foldVerdicts(criteria), criteria };
}

function groupEvidence(input: VerifyContractInput): Map<string, Observation[]> {
  if (input.criteria.length === 0) {
    throw new Error(`verify_contract: contract ${quote(input.contract)} declares no criteria`);
  }
  const declared = new Set<string>();
  for (const criterion of input.criteria) {
    if (criterion.id === "" || declared.has(criterion.id)) {
      throw new Error(
        `verify_contract: criterion id ${quote(criterion.id)} is empty or duplicated in contract ${quote(input.contract)}`,
      );
    }
    const unknown = unknownStrength(criterion.min_strength);
    if (unknown) throw new Error(`verify_contract: criterion ${quote(criterion.id)}: ${unknown}`);
    declared.add(criterion.id);
  }
  const grouped = new Map<string, Observation[]>();
  for (const observation of input.evidence) {
    if (!declared.has(observation.criterion)) {
      throw new Error(
        `verify_contract: evidence from ${quote(observation.source)} names undeclared criterion ${quote(observation.criterion)}`,
      );
    }
    validateObservation(observation);
    grouped.set(observation.criterion, [...(grouped.get(observation.criterion) ?? []), observation]);
  }
  return grouped;
}

/** The error text for a strength outside the closed set, or undefined when it is valid (empty is valid). */
function unknownStrength(strength: string): string | undefined {
  return strength === "" || strength === "weak" || strength === "strong"
    ? undefined
    : `unknown evidence strength ${quote(strength)}`;
}

/** Strength is checked first, then the result; a failure must carry detail so it is always actionable. */
function validateObservation(observation: Observation): void {
  const unknown = unknownStrength(observation.strength);
  if (unknown) throw new Error(`verify_contract: evidence from ${quote(observation.source)}: ${unknown}`);
  switch (observation.result) {
    case "pass":
    case "verifier_error":
      return;
    case "fail":
      if (observation.detail === "") {
        throw new Error(
          `verify_contract: failing evidence from ${quote(observation.source)} for ${quote(observation.criterion)} needs detail to be actionable`,
        );
      }
      return;
    default:
      throw new Error(
        `verify_contract: evidence from ${quote(observation.source)} has unknown result ${quote(observation.result)}`,
      );
  }
}

/** A strong criterion refuses weak evidence; every other minimum accepts any strength. */
function meetsMinimum(strength: string, minimum: string): boolean {
  return minimum !== "strong" || strength !== "weak";
}

function judgeCriterion(criterion: Criterion, evidence: readonly Observation[]): CriterionVerdict {
  const sources: string[] = [];
  const details: string[] = [];
  let passes = 0;
  let weakPasses = 0;
  let nonDiscriminating = 0;
  let fails = 0;
  let errors = 0;
  for (const observation of evidence) {
    sources.push(observation.source);
    if (observation.result === "fail") {
      fails += 1;
      details.push(observation.detail);
    } else if (observation.result === "verifier_error") {
      errors += 1;
      if (observation.detail !== "") details.push(observation.detail);
    } else if (observation.passes_on_known_bad_basis) {
      nonDiscriminating += 1;
    } else if (meetsMinimum(observation.strength, criterion.min_strength)) {
      passes += 1;
    } else {
      weakPasses += 1;
    }
  }
  const { status, reason } = decide({ passes, weakPasses, nonDiscriminating, fails, errors });
  return {
    criterion: criterion.id,
    status,
    ...(reason ? { reason } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(details.length > 0 ? { details } : {}),
  };
}

interface Tally {
  readonly passes: number;
  readonly weakPasses: number;
  readonly nonDiscriminating: number;
  readonly fails: number;
  readonly errors: number;
}

/** First matching rule wins. */
function decide(tally: Tally): { status: VerificationStatus; reason?: IndeterminateReason } {
  if (tally.fails > 0 && tally.passes > 0) return { status: "indeterminate", reason: "contradictory_evidence" };
  if (tally.fails > 0) return { status: "failed" };
  if (tally.passes > 0) return { status: "satisfied" };
  if (tally.errors > 0) return { status: "verifier_failure" };
  if (tally.nonDiscriminating > 0) return { status: "indeterminate", reason: "non_discriminating" };
  if (tally.weakPasses > 0) return { status: "indeterminate", reason: "insufficient_strength" };
  return { status: "indeterminate", reason: "missing_evidence" };
}

function foldVerdicts(verdicts: readonly CriterionVerdict[]): VerificationStatus {
  const seen = new Set(verdicts.map((verdict) => verdict.status));
  return FOLD_ORDER.find((status) => seen.has(status)) ?? "satisfied";
}
