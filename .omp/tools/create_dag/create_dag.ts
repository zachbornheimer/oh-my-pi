import { assembleDag, type Judged } from "./assemble.js";
import { judgeAtomicity } from "./atomicity.js";
import { applyPair, askEdge, orderedMutex, type PairOutcome, sharesDeclaredResource } from "./judge.js";
import { observeWork } from "./observe.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import { parseRequest, readRequest } from "./request.js";
import type { CreateDagResult, DagNode } from "./types.js";

/** Pairs judged at once. */
export const MAX_CONCURRENT_PAIRS = 8;

export interface CreateDagDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  signal?: AbortSignal;
  /** Called with a short phrase as each phase starts, for progress. */
  onPhase?: (phase: string) => void;
}

/** Every pair of nodes, in node order: a declared shared resource is a mutex, any other pair is put to the model. */
async function judgePairs(nodes: readonly DagNode[], deps: CreateDagDeps): Promise<Judged> {
  const pairs = nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => [a, b] as const));
  const outcomes: PairOutcome[] = await mapLimit(pairs, MAX_CONCURRENT_PAIRS, async ([a, b]) => {
    deps.signal?.throwIfAborted();
    return sharesDeclaredResource(a, b)
      ? { mutex: orderedMutex(a.ID, b.ID) }
      : applyPair(a, b, await askEdge(a, b, deps.step, deps.signal));
  });
  return {
    edges: outcomes.flatMap((outcome) => (outcome.edge ? [outcome.edge] : [])),
    mutexes: outcomes.flatMap((outcome) => (outcome.mutex ? [outcome.mutex] : [])),
    uncertainty: outcomes.flatMap((outcome) => (outcome.uncertainty ? [outcome.uncertainty] : [])),
  };
}

/**
 * Work units in, a validated semantic dependency graph out. `request` is `{units?, text?}`; no units means `text` is
 * one unit, and text that is itself a JSON request is read as one. The graph is not returned until validation passes.
 */
export async function runCreateDag(request: unknown, deps: CreateDagDeps): Promise<CreateDagResult> {
  const parsed = parseRequest(readRequest(request));
  deps.onPhase?.("judging units");
  const nodes = await observeWork(parsed.units, parsed.text, (statement) =>
    judgeAtomicity(statement, deps.step, deps.signal));
  deps.onPhase?.(`judging ${(nodes.length * (nodes.length - 1)) / 2} pairs of ${nodes.length} nodes`);
  const judged = await judgePairs(nodes, deps);
  return assembleDag(nodes, judged);
}
