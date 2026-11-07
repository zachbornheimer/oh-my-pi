import { applyPlan, NEW_PROJECT_MESSAGE } from "./apply.js";
import { chooseProject, type ChosenProject } from "./choose_project.js";
import { runDefineObjective } from "./define_objective/define_objective.js";
import type { Machine } from "./define_objective/machine.js";
import { runIdentifyGoals, type IdentifyGoalsResult } from "./identify_goals/identify_goals.js";
import { runInferDependency } from "./infer_dependency/plan_infer_dependency.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import { type PlanGoal, planGoals, plannedItems, type SpecifiedGoal } from "./plan.js";
import type { PlanTasksResult } from "./types.js";

/** Goals specified at once. */
export const SPEC_CONCURRENCY = 4;

export interface PlanTasksInput {
  text: string;
  /** An atask project id or name, or an absolute checkout directory. Without it one model run chooses. */
  project?: string;
  /** Files the items with `atask add` after planning. */
  apply?: boolean;
}

export interface PlanTasksDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  machine: Machine;
  /** The directory the session runs in, shown to the project chooser. */
  cwd: string;
  signal?: AbortSignal;
  /** Called with a short phrase as each phase starts, for progress. */
  onPhase?: (phase: string) => void;
}

/** The objective for one goal, grounded in the chosen project's checkout and told what the other goals are. */
async function specifyGoal(
  chosen: ChosenProject,
  planned: PlanGoal,
  all: readonly PlanGoal[],
  deps: PlanTasksDeps,
): Promise<SpecifiedGoal> {
  try {
    const objective = await runDefineObjective(
      {
        text: planned.goal.outcome,
        ...(chosen.checkout === undefined ? {} : { project: chosen.checkout }),
        alongside: all.filter((other) => other.key !== planned.key).map((other) => other.goal.outcome),
      },
      { step: deps.step, machine: deps.machine, signal: deps.signal },
    );
    return { planned, objective };
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`write the task for ${planned.key}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * The user's words as atask items for one project: the project is chosen, the goals identified, each goal written as
 * a titled item with a targeted proof and regression (or a draft), and the items ordered by pairwise dependency.
 * With `apply`, the items are then filed with `atask add`.
 */
export async function runPlanTasks(input: PlanTasksInput, deps: PlanTasksDeps): Promise<PlanTasksResult> {
  const text = input.text.trim();
  if (text === "") throw new Error("plan_tasks needs the words to plan");
  const phase = (name: string): void => deps.onPhase?.(name);

  phase("choosing the project");
  const chosen = await chooseProject(input.project, text, deps);
  // Refuse before the model runs that planning costs, not after them.
  if (input.apply === true && chosen.project.needsNewProject) throw new Error(NEW_PROJECT_MESSAGE);

  phase("identifying the goals");
  let identified: IdentifyGoalsResult;
  try {
    identified = await runIdentifyGoals(text, { step: deps.step, signal: deps.signal });
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`identify the goals to plan: ${(error as Error).message}`, { cause: error });
  }
  const goals = planGoals(identified.Goals, identified.Parts);

  phase(`writing ${goals.length} task${goals.length === 1 ? "" : "s"}`);
  const specified = await mapLimit(goals, SPEC_CONCURRENCY, (planned) => specifyGoal(chosen, planned, goals, deps));

  let edges: { from: string; to: string }[] = [];
  if (specified.length >= 2) {
    phase("ordering the tasks");
    edges = (await runInferDependency(
      specified.map(({ planned, objective }) => ({
        id: planned.key,
        statement: planned.goal.outcome,
        criteria: objective.draft ? objective.acceptance : [objective.proof],
      })),
      { step: deps.step, signal: deps.signal },
    )).edges;
  }

  const plan: PlanTasksResult = { project: chosen.project, items: plannedItems(specified, edges), applied: [] };
  if (input.apply !== true) return plan;
  phase("filing the tasks with atask");
  return applyPlan(plan, deps.machine);
}
