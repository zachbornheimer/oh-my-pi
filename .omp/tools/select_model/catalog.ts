/**
 * The registered semantic models, as agentmux registers them (the Mastra twin's `src/runtime/catalog.ts`, copied).
 * These are agentmux's own routes (TypeSafe Jev and Ollama decision models, OpenRouter/Ollama/local/omp language
 * routes), not omp's model roles.
 */

/** How capable a model is, weakest first (agentmux `prompt.ModelStrength`); `unknown` is a model nobody has vetted. */
export type ModelStrength = "routine" | "reasoning" | "deep" | "unknown";

const STRENGTH_ORDER: readonly ModelStrength[] = ["unknown", "routine", "reasoning", "deep"];

/** Strengths by rank, weakest first; `unknown` is rank 0 (agentmux `ModelStrength.Rank`). */
export function strengthRank(strength: ModelStrength): number {
  return STRENGTH_ORDER.indexOf(strength);
}

/** USD per million input and output tokens. */
export interface ListPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

const FREE: ListPrice = { inputPerMillion: 0, outputPerMillion: 0 };

export interface DecisionEntry {
  readonly id: string;
  readonly strength: ModelStrength;
  readonly listPrice: ListPrice;
  /** Answers only when a run or call names it, even though its list price is not zero. Absent: it may be ranked. */
  readonly namedOnly?: boolean;
}

/** Decision models by id. Prices are USD per million tokens (agentmux models/pricing.yaml). */
export const DECISION_CATALOG: readonly DecisionEntry[] = [
  { id: "ollama/nimble", strength: "unknown", listPrice: FREE },
  { id: "ollama/clef", strength: "unknown", listPrice: FREE },
  { id: "typesafe/jev-1.13", strength: "unknown", listPrice: { inputPerMillion: 0.042, outputPerMillion: 0 } },
  {
    id: "openrouter/~typesafe/jev-latest",
    strength: "unknown",
    listPrice: { inputPerMillion: 0.042, outputPerMillion: 0 },
    namedOnly: true,
  },
];

/** The hosted decision model that answers first: the runtime's default route (agentmux `DefaultDecisionModelID`). */
export const DEFAULT_DECISION_MODEL_ID = "openrouter/~typesafe/jev-latest";
/** The free local decision model that answers last when the hosted one cannot (agentmux `DefaultDecisionFallbackModelID`). */
export const DECISION_FALLBACK_MODEL_ID = "ollama/nimble";
/** The language model an unpinned text task is answered by. */
export const DEFAULT_LANGUAGE_MODEL = "openrouter/auto";

/** The environment variables that pin the models, comma-separated ids in rank order. */
export const DECISION_MODEL_ENV = "AGENTMUX_DECISION_MODEL";
export const LANGUAGE_MODEL_ENV = "AGENTMUX_LANGUAGE_MODEL";

/** Language models are named by route: `openrouter/<slug>`, `ollama/<name>`, `local/<provider>/<model>`, or `omp/<role>`. */
const LANGUAGE_ROUTES: readonly string[] = ["openrouter", "ollama", "local", "omp"];

export function decisionEntry(id: string): DecisionEntry {
  const entry = DECISION_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) {
    const known = DECISION_CATALOG.map((candidate) => candidate.id).join(", ");
    throw new Error(`unknown decision model "${id}": known models are ${known}`);
  }
  return entry;
}

/** The id of a well-formed language route; throws naming the routes otherwise. */
export function languageId(id: string): string {
  const slash = id.indexOf("/");
  const route = slash > 0 ? id.slice(0, slash) : "";
  if (!LANGUAGE_ROUTES.includes(route) || id.slice(slash + 1) === "") {
    throw new Error(`unknown language model "${id}": use ${LANGUAGE_ROUTES.map((name) => `${name}/<model>`).join(", ")}`);
  }
  return id;
}
