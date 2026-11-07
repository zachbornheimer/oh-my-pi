import { type Classification, classify, settle, type Settled } from "./classify.js";
import type { ModelStep } from "./omp_model.js";

/** The closed vocabulary of hardening phases, in run order. */
export const PLAN_PHASES = ["happy_path", "structural", "edge", "production"] as const;

export type PlanPhase = (typeof PLAN_PHASES)[number];

/** An unsure pick runs first rather than being skipped or held back behind hardening it may not need. */
export const UNSURE_PLAN_PHASE: PlanPhase = "happy_path";

export const NO_WORDS_MESSAGE = "the user's words are required";

/** Mastra's `plan_phase.yaml`, unchanged: the question, the 0.6 threshold, the four categories and the examples. */
export const PHASE_CLASSIFICATION: Classification = {
  question:
    "Which hardening phase does this planned step belong to, judged against the overall request in context (a step that IS the requested feature is happy_path even if it sounds like validation or error handling)?",
  threshold: 0.6,
  categories: [
    {
      id: "happy_path",
      criteria: "The smallest slice that makes the feature work at all for the ordinary, expected case.",
    },
    {
      id: "structural",
      criteria:
        "Reworking the shape of the happy-path solution once it works: splitting functions, naming, removing duplication, wiring it into the surrounding structure.",
    },
    {
      id: "edge",
      criteria:
        "Handling unusual, boundary, or adversarial inputs the happy path does not cover (empty input, malformed data, concurrent access, malicious input).",
    },
    {
      id: "production",
      criteria:
        "Making an already-working, already-structured change safe to run for real: monitoring, docs, rollout, performance under real load.",
    },
  ],
  examples: [
    { text: 'Add a Greeting(name) function returning "hello, <name>"', category: "happy_path" },
    {
      text: "Validate email format on signup (request: build the signup form validation feature)",
      category: "happy_path",
    },
    { text: "Split the 300-line handler into named steps now that it works", category: "structural" },
    { text: "Add a table test covering the empty name case", category: "edge" },
    { text: "Add a dashboard alert for Greeting error rate before rollout", category: "production" },
  ],
};

export type PlanPhaseResult = Settled<PlanPhase>;

/** The result as the tool returns it: `evidence` is the category the model picked. */
export interface PlanPhaseOutput {
  value: PlanPhase;
  certain: boolean;
  evidence: string;
}

export interface PlanPhaseDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  signal?: AbortSignal;
}

/** Classifies one planned step into its hardening phase with one model call. Failures read `classify phase: <cause>`. */
export async function runPlanPhase(text: unknown, deps: PlanPhaseDeps): Promise<PlanPhaseOutput> {
  const words = typeof text === "string" ? text.trim() : "";
  if (words === "") throw new Error(NO_WORDS_MESSAGE);
  try {
    const pick = await classify(deps.step, PHASE_CLASSIFICATION, words, deps.signal);
    return settle(PHASE_CLASSIFICATION, pick, PLAN_PHASES, UNSURE_PLAN_PHASE);
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`classify phase: ${(error as Error).message}`, { cause: error });
  }
}
