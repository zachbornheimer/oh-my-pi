import { classify } from "./classify.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import {
  CERTAIN,
  type Certainty,
  checkGoalIds,
  type DependencyGoal,
  edgeFor,
  type GoalDependency,
  interpretPairOrder,
  type PairOrder,
  PAIR_CLASSIFICATION,
  pairsOf,
  pairText,
  UNSURE,
  UNSURE_PAIR_ORDER,
} from "./pairs.js";

/** Pairs judged at once. */
export const MAX_CONCURRENT_PAIRS = 8;

export interface DependencyInference {
  edges: GoalDependency[];
  /** The edges that were a guess (the pair's judge was unsure or failed), a subset of `edges`. */
  guessed: GoalDependency[];
  certainty: Certainty;
}

export interface InferDependencyDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  signal?: AbortSignal;
  /** Called after each pair settles, for progress. */
  onPair?: (done: number, total: number) => void;
}

interface PairJudgement {
  readonly order: PairOrder;
  readonly settled: boolean;
}

const UNSURE_JUDGEMENT: PairJudgement = { order: UNSURE_PAIR_ORDER, settled: false };

/**
 * Which planned goals must wait for which others, judged once per unordered pair, so two goals can never depend on
 * each other. A pair whose judge is below the threshold or fails is a guess: the later goal is taken to depend on
 * the earlier one and the edge is listed in `guessed`. Only an abort fails the whole call.
 */
export async function runInferDependency(
  goals: readonly DependencyGoal[],
  deps: InferDependencyDeps,
): Promise<DependencyInference> {
  checkGoalIds(goals);
  const pairs = pairsOf(goals.length);
  let done = 0;
  const judged = await mapLimit(pairs, MAX_CONCURRENT_PAIRS, async ({ earlier, later }): Promise<PairJudgement> => {
    const result = await judgePair(goals[earlier]!, goals[later]!, deps);
    done += 1;
    deps.onPair?.(done, pairs.length);
    return result;
  });
  if (deps.signal?.aborted) throw new Error("infer dependency: run cancelled");

  const edges: GoalDependency[] = [];
  const guessed: GoalDependency[] = [];
  pairs.forEach(({ earlier, later }, index) => {
    const judgement = judged[index]!;
    const edge = edgeFor(judgement.order, goals[earlier]!.id, goals[later]!.id);
    if (edge === undefined) return;
    edges.push(edge);
    if (!judgement.settled) guessed.push(edge);
  });
  return { edges, guessed, certainty: guessed.length > 0 ? UNSURE : CERTAIN };
}

async function judgePair(first: DependencyGoal, second: DependencyGoal, deps: InferDependencyDeps): Promise<PairJudgement> {
  if (deps.signal?.aborted) return UNSURE_JUDGEMENT;
  try {
    const pick = await classify(deps.step, PAIR_CLASSIFICATION, pairText(first, second), deps.signal);
    const order = interpretPairOrder(pick.choice);
    if (order === undefined || pick.probability < PAIR_CLASSIFICATION.threshold) return UNSURE_JUDGEMENT;
    return { order, settled: true };
  } catch {
    return UNSURE_JUDGEMENT;
  }
}
