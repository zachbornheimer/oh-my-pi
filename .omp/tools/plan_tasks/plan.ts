import type { DefinedObjective } from "./define_objective/types.js";
import type { PartWithGoals } from "./identify_goals/identify_goals.js";
import type { StatedGoal } from "./identify_goals/goals.js";
import type { GoalDependency } from "./infer_dependency/pairs.js";
import type { PlannedItem } from "./types.js";

const KEY_PREFIX = "t";

/** A goal with the key it keeps in the plan and the part of the words that states it. */
export interface PlanGoal {
  readonly key: string;
  readonly goal: StatedGoal;
  readonly part: PartWithGoals | undefined;
}

/** Goals in the order the words state them (a goal of the whole input alone goes last), keyed `t1`, `t2`, ... */
export function planGoals(goals: readonly StatedGoal[], parts: readonly PartWithGoals[]): PlanGoal[] {
  const position = (goal: StatedGoal): number => {
    const at = goal.sources.map((source) => parts.findIndex((part) => part.ID === source)).filter((index) => index >= 0);
    return at.length === 0 ? parts.length : Math.min(...at);
  };
  return goals
    .map((goal, index) => ({ goal, index, position: position(goal) }))
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ goal }, index) => ({
      key: `${KEY_PREFIX}${index + 1}`,
      goal,
      part: parts.find((part) => goal.sources.includes(part.ID)),
    }));
}

/** Whether `from` can already reach `to` by following `requires`. */
function reaches(requires: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (key === to) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push(...(requires.get(key) ?? []));
  }
  return false;
}

/**
 * The prerequisite sets the judged edges describe. An edge `{from, to}` makes `from` require `to`. Edges between
 * unknown keys are ignored, and an edge that would close a cycle is dropped (the first judged edge wins).
 */
export function prerequisites(keys: readonly string[], edges: readonly GoalDependency[]): Map<string, Set<string>> {
  const requires = new Map(keys.map((key) => [key, new Set<string>()]));
  for (const { from, to } of edges) {
    if (from === to || !requires.has(from) || !requires.has(to)) continue;
    if (reaches(requires, to, from)) continue;
    requires.get(from)!.add(to);
  }
  return requires;
}

/** A goal with the objective define_objective shaped for it. */
export interface SpecifiedGoal {
  readonly planned: PlanGoal;
  readonly objective: DefinedObjective;
}

/**
 * The items in an order where every item comes after what it requires, and otherwise in the order the words state
 * them. `requires` lists keys in that same order.
 */
export function plannedItems(specified: readonly SpecifiedGoal[], edges: readonly GoalDependency[]): PlannedItem[] {
  const requires = prerequisites(specified.map(({ planned }) => planned.key), edges);
  const placed: SpecifiedGoal[] = [];
  const remaining = [...specified];
  while (remaining.length > 0) {
    const ready = remaining.findIndex(({ planned }) =>
      [...requires.get(planned.key)!].every((key) => placed.some((done) => done.planned.key === key))
    );
    if (ready < 0) throw new Error("plan_tasks: the prerequisites contain a cycle");
    placed.push(...remaining.splice(ready, 1));
  }
  const order = placed.map(({ planned }) => planned.key);
  return placed.map(({ planned, objective }) => ({
    key: planned.key,
    title: objective.title,
    outcome: objective.outcome,
    acceptance: objective.acceptance,
    proof: objective.proof,
    regression: objective.regression,
    draft: objective.draft,
    ...(objective.draft_reason === undefined ? {} : { draft_reason: objective.draft_reason }),
    requires: [...requires.get(planned.key)!].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    rationale: objective.rationale,
    goal: planned.goal.outcome,
    sources: [...planned.goal.sources],
    ...(objective.duplicate_of === undefined ? {} : { duplicate_of: objective.duplicate_of }),
  }));
}
