import { checkoutNamed, projectContext, repositoryGoal } from "./checkout.js";
import type { Machine } from "./machine.js";
import { objectiveBrief } from "./objective_brief.js";
import { OBJECTIVE_EXAMPLE, OBJECTIVE_INSTRUCTIONS, OBJECTIVE_SCHEMA } from "./objective_question.js";
import { askJson, type ModelStep } from "./omp_model.js";
import { duplicateOf } from "./project_context.js";
import { checkObjective, type Scene, sizedChecks, targetingOf } from "./targeting.js";
import type { DefinedObjective, ObjectiveReply, PlannedProject, ProjectContext, ProjectRecord } from "./types.js";

export interface DefineObjectiveInput {
  text: string;
  project?: string;
  changed_files?: string[];
  /** The checkout, when the caller has already read it; skips reading `project`. */
  context?: ProjectContext;
  alongside?: string[];
}

export interface DefineObjectiveDeps {
  /** One model call; the tool's own `omp -p` step, or a fake in tests. */
  step: ModelStep;
  machine: Machine;
  signal?: AbortSignal;
}

const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";
const FIELD = "ObjectiveSpec";
const NO_PROJECT: PlannedProject = { id: "", name: "", needsNewProject: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The question's reply schema: an object whose one required key is `ObjectiveSpec`. */
const REPLY_SCHEMA = {
  type: "object",
  properties: { [FIELD]: OBJECTIVE_SCHEMA },
  required: [FIELD],
  additionalProperties: false,
};

/** What the model reads: the question, its worked example, the brief of this goal, and the reply schema last. */
export function objectivePrompt(brief: string): string {
  return `## ${FIELD}\n${OBJECTIVE_INSTRUCTIONS}\nExample:\n${OBJECTIVE_EXAMPLE}\n\nPrompt:\n${brief}\n${SCHEMA_LEAD}${
    JSON.stringify(REPLY_SCHEMA)
  }`;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

/** The objective a reply carries (`{"ObjectiveSpec": {...}}` or the bare object), checked field by field. */
export function parseObjectiveReply(value: unknown): ObjectiveReply {
  const reply = isRecord(value) && isRecord(value[FIELD]) ? value[FIELD] : value;
  if (!isRecord(reply)) throw new Error(`the reply must be a JSON object { "${FIELD}": { ... } }`);
  const acceptance = reply.acceptance;
  if (!Array.isArray(acceptance) || acceptance.some((line) => typeof line !== "string")) {
    throw new Error("acceptance must be an array of strings");
  }
  if (typeof reply.draft !== "boolean") throw new Error("draft must be true or false");
  return {
    title: text(reply.title, "title"),
    outcome: text(reply.outcome, "outcome"),
    acceptance: acceptance as string[],
    draft: reply.draft,
    draft_reason: text(reply.draft_reason, "draft_reason"),
    proof: text(reply.proof, "proof"),
    regression: text(reply.regression, "regression"),
    regression_size: text(reply.regression_size, "regression_size"),
    rationale: text(reply.rationale, "rationale"),
  };
}

function objectiveOf(reply: ObjectiveReply, scene: Scene, project: PlannedProject): DefinedObjective {
  const common = {
    title: reply.title.trim(),
    outcome: reply.outcome.trim(),
    acceptance: reply.acceptance.map((line) => line.trim()),
    requires: [],
    rationale: reply.rationale.trim(),
    targeting: targetingOf(reply, scene),
    project,
    applied: "",
  };
  const duplicate = duplicateOf(reply.outcome, scene.context?.OpenTasks ?? []);
  const filing = duplicate === undefined ? {} : { duplicate_of: duplicate };
  if (reply.draft) {
    return { ...common, proof: "", regression: "", draft: true, draft_reason: reply.draft_reason.trim(), ...filing };
  }
  return { ...common, ...sizedChecks(reply), draft: false, ...filing };
}

/** The project the objective belongs to and the checkout that grounds its checks. */
interface Grounding {
  readonly project: PlannedProject;
  readonly record: ProjectRecord | undefined;
  readonly context: ProjectContext | undefined;
}

/**
 * `project` names the checkout: an absolute directory (read as given; it has no open tasks) or a registered atask
 * project by id or name. Given `context`, the checkout is not read and `project` only names it. Naming a project that
 * is neither, with no `context`, is refused: the checks could not be grounded and the result would silently be a
 * draft of an unknown checkout.
 */
async function groundingOf(input: DefineObjectiveInput, deps: DefineObjectiveDeps, words: string): Promise<Grounding> {
  const named = input.project?.trim() ?? "";
  if (named === "") return { project: NO_PROJECT, record: undefined, context: input.context };
  if (input.context !== undefined) {
    return { project: { id: "", name: named, needsNewProject: false }, record: undefined, context: input.context };
  }
  const checkout = await checkoutNamed(named, deps.machine);
  if (checkout === undefined) {
    throw new Error(
      `project ${JSON.stringify(named)} is neither an absolute path to a directory nor an atask project with a home directory: `
        + "pass its absolute path, or `context`",
    );
  }
  const context = await projectContext(checkout.id, checkout.home, deps.machine, {
    words,
    ...(input.changed_files === undefined ? {} : { changedFiles: input.changed_files }),
  });
  const goal = await repositoryGoal(checkout.home, deps.machine);
  return {
    project: { id: checkout.id ?? "", name: checkout.name, needsNewProject: false },
    record: { Name: checkout.name, Home: checkout.home, Goal: goal },
    context,
  };
}

/** One goal in words as an atask objective: a titled outcome whose proof runs the specific work and whose regression covers only what it touches. */
export async function runDefineObjective(
  input: DefineObjectiveInput,
  deps: DefineObjectiveDeps,
): Promise<DefinedObjective> {
  if (typeof input.text !== "string" || input.text.trim() === "") throw new Error("text must not be empty");
  const goal = input.text.trim();
  const grounding = await groundingOf(input, deps, goal);
  const scene: Scene = {
    goal,
    context: grounding.context,
    changedFiles: input.changed_files ?? grounding.context?.ChangedFiles ?? [],
  };
  const brief = objectiveBrief(
    scene,
    { name: grounding.project.name, record: grounding.record },
    input.alongside ?? [],
  );
  const reply = await askJson(
    deps.step,
    objectivePrompt(brief),
    (value) => checkObjective(parseObjectiveReply(value), scene),
    { signal: deps.signal },
  );
  return objectiveOf(reply, scene, grounding.project);
}
