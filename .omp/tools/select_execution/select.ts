/** Planning policy for select_execution. Pure: nothing is run and no model is called. */

export const COMPUTE_CLASSES = ["deterministic", "structured_inference", "generative", "native_agent", "human"] as const;
export type ComputeClass = (typeof COMPUTE_CLASSES)[number];
export const TASK_SHAPES = [
  "deterministic",
  "classification",
  "selection",
  "decomposition",
  "implementation",
  "description",
] as const;
export type TaskShape = (typeof TASK_SHAPES)[number];
export const MATURITIES = ["draft", "working", "production"] as const;
export const VERIFIER_STRENGTHS = ["none", "weak", "strong"] as const;
export const SELECTION_STATUS = "selected";

/** The tool's input as the caller sends it; every field may be absent or null and is normalised here. */
export interface SelectExecutionInput {
  capability?: string | null;
  shape?: string | null;
  maturity?: string | null;
  verifier?: string | null;
  required_tools?: string[] | null;
  permissions?: string[] | null;
  human_approval?: boolean | null;
  credentials?: boolean | null;
  prior?: { class?: string | null; failed?: boolean | null; no_new_information?: boolean | null } | null;
  constraints?: { require_class?: string | null; forbid?: string[] | null } | null;
}

export interface FallbackPolicy {
  same_class_retries: number;
  retry_needs_new_information: boolean;
  escalate_to: ComputeClass[];
  on_exhausted: "escalate" | "blocked";
}

export interface ExecutionSelection {
  compute_class: ComputeClass;
  strategy: { kind: string; tools?: string[]; permissions?: string[] };
  rationale: string[];
  fallback: FallbackPolicy;
  gates?: string[];
  status: typeof SELECTION_STATUS;
}

/** The most a class may be retried, and only with new information. */
const SAME_CLASS_RETRIES = 1;

const STRATEGY_KINDS: Readonly<Record<ComputeClass, string>> = {
  deterministic: "zero_model_deterministic",
  structured_inference: "structured_decision_inference",
  generative: "generative_api",
  native_agent: "native_coding_harness",
  human: "human_decision",
};

const SHAPE_CLASSES: Readonly<Record<TaskShape, ComputeClass>> = {
  deterministic: "deterministic",
  classification: "structured_inference",
  selection: "structured_inference",
  decomposition: "structured_inference",
  implementation: "generative",
  description: "generative",
};

/** The classes to move to when a class does not deliver, cheapest first. */
const ESCALATIONS: Readonly<Record<ComputeClass, readonly ComputeClass[]>> = {
  deterministic: ["structured_inference", "generative", "human"],
  structured_inference: ["generative", "human"],
  generative: ["human"],
  native_agent: ["human"],
  human: [],
};

/** A request after validation: enums are narrowed, lists are sorted and unique, defaults applied. */
interface NormalizedRequest {
  readonly capability: string;
  readonly shape: TaskShape;
  readonly maturity: string;
  readonly verifier: string;
  readonly tools: readonly string[];
  readonly permissions: readonly string[];
  readonly humanApproval: boolean;
  readonly credentials: boolean;
  readonly prior: { readonly class: string; readonly failed: boolean; readonly noNewInformation: boolean } | undefined;
  readonly requireClass: ComputeClass | undefined;
  readonly forbid: readonly ComputeClass[];
}

/** Plans compute for the request: class, backing strategy, fallback policy. It never runs anything. */
export function selectExecution(input: SelectExecutionInput | null | undefined): ExecutionSelection {
  const request = normalize(input);
  const { base, forced, why } = baseClass(request);
  if (forced !== undefined && request.requireClass !== undefined && request.requireClass !== base) {
    throw new Error(`select_execution: ${why} conflicts with require_class ${request.requireClass}`);
  }
  const chosen = chooseClass(request, base, forced !== undefined);
  const rationale = [why];
  if (chosen !== base) {
    rationale.push(`${base} was unavailable or already failed without new information; escalated to ${chosen}`);
  }
  const gates = gatesFor(request);
  return {
    compute_class: chosen,
    strategy: {
      kind: STRATEGY_KINDS[chosen],
      ...(request.tools.length > 0 ? { tools: [...request.tools] } : {}),
      ...(request.permissions.length > 0 ? { permissions: [...request.permissions] } : {}),
    },
    rationale,
    fallback: fallbackFor(request, chosen),
    ...(gates.length > 0 ? { gates } : {}),
    status: SELECTION_STATUS,
  };
}

function normalize(input: SelectExecutionInput | null | undefined): NormalizedRequest {
  const source = input ?? {};
  const rawShape = source.shape ?? "";
  const rawMaturity = source.maturity ?? "";
  const rawVerifier = source.verifier ?? "";
  const requireRaw = source.constraints?.require_class ?? "";
  const forbidRaw = source.constraints?.forbid ?? [];
  const prior = source.prior
    ? {
        class: source.prior.class ?? "",
        failed: source.prior.failed ?? false,
        noNewInformation: source.prior.no_new_information ?? false,
      }
    : undefined;
  const capability = (source.capability ?? "").trim();
  if (capability === "") throw new Error("select_execution: capability is required");
  const shape = TASK_SHAPES.find((candidate) => candidate === rawShape);
  if (shape === undefined) {
    throw new Error(`select_execution: unknown shape ${quote(rawShape)} for capability ${capability}`);
  }
  const maturity = rawMaturity === "" ? "working" : rawMaturity;
  const verifier = rawVerifier === "" ? "none" : rawVerifier;
  if (!MATURITIES.some((candidate) => candidate === maturity)) {
    throw new Error(`select_execution: unknown maturity ${quote(maturity)} for capability ${capability}`);
  }
  if (!VERIFIER_STRENGTHS.some((candidate) => candidate === verifier)) {
    throw new Error(`select_execution: unknown verifier ${quote(verifier)} for capability ${capability}`);
  }
  for (const name of [requireRaw, ...forbidRaw, ...(prior ? [prior.class] : [])]) {
    if (name !== "" && !isComputeClass(name)) {
      throw new Error(`select_execution: unknown compute class ${quote(name)} for capability ${capability}`);
    }
  }
  return {
    capability,
    shape,
    maturity,
    verifier,
    tools: sortedUnique(source.required_tools ?? []),
    permissions: sortedUnique(source.permissions ?? []),
    humanApproval: source.human_approval ?? false,
    credentials: source.credentials ?? false,
    prior,
    requireClass: isComputeClass(requireRaw) ? requireRaw : undefined,
    forbid: sortedUnique(forbidRaw).filter(isComputeClass),
  };
}

/** The class the request calls for. `forced` is set when an explicit requirement, not the task shape, decided it. */
function baseClass(request: NormalizedRequest): { base: ComputeClass; forced?: "human" | "required"; why: string } {
  if (request.humanApproval || request.credentials) {
    return {
      base: "human",
      forced: "human",
      why: "explicit approval or credentials are required, so a human must act",
    };
  }
  if (request.requireClass !== undefined) {
    return {
      base: request.requireClass,
      forced: "required",
      why: `caller explicitly requires ${request.requireClass}`,
    };
  }
  const base = SHAPE_CLASSES[request.shape];
  return { base, why: `${request.shape} work is backed by ${base} compute` };
}

function chooseClass(request: NormalizedRequest, base: ComputeClass, forced: boolean): ComputeClass {
  const candidates = forced ? [base] : [base, ...ESCALATIONS[base]];
  const stuck = request.prior?.failed === true && request.prior.noNewInformation;
  for (const candidate of candidates) {
    if (request.forbid.includes(candidate) || (stuck && candidate === request.prior?.class)) continue;
    return candidate;
  }
  throw new Error(
    `select_execution: no allowed class remains for capability ${request.capability} (base ${base}, forbidden [${request.forbid.join(" ")}], no-new-information retry ${stuck}); new information is required`,
  );
}

function fallbackFor(request: NormalizedRequest, chosen: ComputeClass): FallbackPolicy {
  const failedHere = request.prior?.failed === true && request.prior.class === chosen;
  const retries = chosen === "human" || failedHere ? 0 : SAME_CLASS_RETRIES;
  const escalateTo = ESCALATIONS[chosen].filter((candidate) => !request.forbid.includes(candidate));
  return {
    same_class_retries: retries,
    retry_needs_new_information: retries > 0,
    escalate_to: [...escalateTo],
    on_exhausted: escalateTo.length === 0 ? "blocked" : "escalate",
  };
}

/** Asks for human review when a production result has no strong check. */
function gatesFor(request: NormalizedRequest): string[] {
  return request.maturity === "production" && request.verifier !== "strong" ? ["human_review"] : [];
}

function isComputeClass(name: string): name is ComputeClass {
  return COMPUTE_CLASSES.some((candidate) => candidate === name);
}

/** Compare by UTF-8 bytes, as Go sorts strings. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  const sorted = [...values].sort(compareBytes);
  return sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
