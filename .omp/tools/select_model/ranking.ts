import {
  DECISION_CATALOG,
  DECISION_FALLBACK_MODEL_ID,
  DECISION_MODEL_ENV,
  DEFAULT_DECISION_MODEL_ID,
  DEFAULT_LANGUAGE_MODEL,
  type DecisionEntry,
  decisionEntry,
  LANGUAGE_MODEL_ENV,
  languageId,
  type ModelStrength,
  strengthRank,
} from "./catalog.js";
import type { ModelKind } from "./need.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Comma-separated ids in rank order; blank or unset is no pin. */
function pinnedIds(value: string | undefined): string[] {
  return (value ?? "").trim().split(",").map((id) => id.trim()).filter((id) => id !== "");
}

/** What one million input and one million output tokens cost (agentmux `listPrice`). */
function listPrice(entry: DecisionEntry): number {
  return entry.listPrice.inputPerMillion + entry.listPrice.outputPerMillion;
}

/** A model every route to which is free, or that is marked so, answers only when named (agentmux `reachedByNameOnly`). */
function reachedByNameOnly(entry: DecisionEntry): boolean {
  return listPrice(entry) === 0 || entry.namedOnly === true;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A decision model that meets the need, with the facts the ranking orders it by (agentmux `ranked`). */
interface Fit {
  readonly entry: DecisionEntry;
  /** 1 for a model of unknown strength, so every vetted model ranks ahead of it. */
  readonly unvetted: number;
  /** How far the model's strength sits above the need; the smallest wins. */
  readonly surplus: number;
  readonly price: number;
}

function fitFor(entry: DecisionEntry, needed: number): Fit | undefined {
  const rank = strengthRank(entry.strength);
  if (reachedByNameOnly(entry) || rank < needed) return undefined;
  return { entry, unvetted: rank === 0 ? 1 : 0, surplus: rank - needed, price: listPrice(entry) };
}

/**
 * Decision models that can answer unnamed, best fit first (agentmux `rank`): a model of unknown strength last, then
 * the strength that meets the need most closely, then the lower list price, then id. `need` is the weakest strength
 * the work can use; unknown accepts any.
 */
export function rankDecisionModels(
  catalog: readonly DecisionEntry[] = DECISION_CATALOG,
  need: ModelStrength = "unknown",
): string[] {
  const needed = strengthRank(need);
  return catalog
    .flatMap((entry) => fitFor(entry, needed) ?? [])
    .sort((a, b) =>
      a.unvetted - b.unvetted || a.surplus - b.surplus || a.price - b.price || compareIds(a.entry.id, b.entry.id)
    )
    .map((fit) => fit.entry.id);
}

/**
 * The ranked decision models with the hosted default first and the local fallback last (agentmux
 * `withDefaultDecisionOrder`). A model that is not in the catalog or too weak for `need` is left out.
 */
export function withDefaultDecisionOrder(
  ranked: readonly string[],
  catalog: readonly DecisionEntry[] = DECISION_CATALOG,
  need: ModelStrength = "unknown",
): string[] {
  const needed = strengthRank(need);
  const canAnswer = (id: string): boolean => {
    const entry = catalog.find((candidate) => candidate.id === id);
    return entry !== undefined && strengthRank(entry.strength) >= needed;
  };
  const between = ranked.filter((id) => id !== DEFAULT_DECISION_MODEL_ID && id !== DECISION_FALLBACK_MODEL_ID);
  return [
    ...(canAnswer(DEFAULT_DECISION_MODEL_ID) ? [DEFAULT_DECISION_MODEL_ID] : []),
    ...between,
    ...(canAnswer(DECISION_FALLBACK_MODEL_ID) ? [DECISION_FALLBACK_MODEL_ID] : []),
  ];
}

/**
 * The models that can answer a need: the ids the environment names for its kind, else the default language model for
 * a language need, else the ranked decision models in the default order (agentmux `model.For`). An id the catalog
 * does not know is an error naming it.
 */
export function modelsFor(kind: ModelKind, env: Env): string[] {
  if (kind === "language") {
    const named = pinnedIds(env[LANGUAGE_MODEL_ENV]);
    return (named.length > 0 ? named : [DEFAULT_LANGUAGE_MODEL]).map(languageId);
  }
  const named = pinnedIds(env[DECISION_MODEL_ENV]);
  if (named.length > 0) return named.map((id) => decisionEntry(id).id);
  const ranked = withDefaultDecisionOrder(rankDecisionModels());
  if (ranked.length === 0) throw new Error(`no registered model can answer a ${kind} need`);
  return ranked;
}
