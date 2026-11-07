import type { Candidate } from "./candidates.ts";
import type { Decision } from "./draft_steps.ts";
import { askJson, type ModelStep } from "./omp_model.ts";
import { candidatePrompt, checkPrompt, summaryPrompt } from "./prompts.ts";
import { isWorkflowName, STEP_KINDS, type StepKind, type WorkflowInput } from "./schemas.ts";
import { checkProblem } from "./step_check.ts";

/** What a model step needs: the step itself and the run's abort signal. */
export interface ModelScope {
  readonly step: ModelStep;
  readonly signal?: AbortSignal;
}

const MAX_DESCRIPTION_CHARS = 400;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} must be a string`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  return value;
}

/** Kind, Keep and Approval of one candidate: one model call; the model states each, no probability is read. */
export async function decideCandidate(candidate: Candidate, scope: ModelScope): Promise<Decision> {
  return askJson(
    scope.step,
    candidatePrompt(candidate.context, candidate.text),
    (reply): Decision => {
      const object = record(reply, "the reply");
      const kind = object.Kind;
      if (typeof kind !== "string" || !(STEP_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`Kind must be one of ${STEP_KINDS.join(", ")}; got ${JSON.stringify(kind)}`);
      }
      if (typeof object.Keep !== "boolean") throw new Error("Keep must be the JSON boolean true or false");
      if (typeof object.Approval !== "boolean") throw new Error("Approval must be the JSON boolean true or false");
      return { kind: kind as StepKind, keep: object.Keep, approval: object.Approval };
    },
    { signal: scope.signal },
  );
}

/** A step as the check writer sees it. */
export interface StepToCheck {
  readonly title: string;
  readonly kind: string;
  readonly run?: string;
  /** What the source says about the step. */
  readonly basis: string;
}

export interface CheckResult {
  /** The check, or undefined when the model finds none. */
  readonly check?: string;
  /** Why the model could not write a valid check; the step is left without one. */
  readonly failure?: string;
}

/**
 * A check in atask grammar that shows the step worked. A model that cannot write a valid one after its retries leaves the
 * step without one (the reason is returned, not swallowed): a check helps whoever runs the workflow and is not part of the
 * process itself. A stopped run still stops.
 */
export async function writeCheck(
  step: StepToCheck,
  inputs: readonly WorkflowInput[],
  scope: ModelScope,
): Promise<CheckResult> {
  const names = new Set(inputs.map((input) => input.name));
  const listed = inputs.length === 0
    ? "none"
    : inputs.map((input) => (input.example === undefined ? input.name : `${input.name} (${input.example})`)).join(", ");
  const prompt = checkPrompt(
    [
      `Workflow inputs: ${listed}`,
      `Step: ${step.title}`,
      `Kind: ${step.kind}`,
      `Command: ${step.run ?? "none"}`,
      `From the source: ${step.basis}`,
    ].join("\n"),
  );
  try {
    const check = await askJson(
      scope.step,
      prompt,
      (reply) => {
        const value = text(record(reply, "the reply").Check, "Check");
        const problem = checkProblem(value, names, step.run !== undefined);
        if (problem !== undefined) throw new Error(problem);
        return value.trim() === "" ? undefined : value.trim();
      },
      { signal: scope.signal },
    );
    return check === undefined ? {} : { check };
  } catch (error) {
    if (scope.signal?.aborted) throw error;
    return { failure: (error as Error).message };
  }
}

export interface WorkflowSummary {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly argument_hint: string;
  readonly rules: string[];
  readonly outputs: { name: string; where: string }[];
  readonly inputs: { name: string; description: string }[];
}

/** The name, description, usage, rules, outputs and input descriptions, from the source's own words. */
export async function summarize(brief: string, nameGiven: boolean, scope: ModelScope): Promise<WorkflowSummary> {
  return askJson(
    scope.step,
    summaryPrompt(brief),
    (reply): WorkflowSummary => {
      const workflow = record(record(reply, "the reply").Workflow, "Workflow");
      const name = text(workflow.name, "name");
      const description = text(workflow.description, "description");
      const usage = text(workflow.usage, "usage");
      const argumentHint = text(workflow.argument_hint, "argument_hint");
      const rules = list(workflow.rules, "rules").map((rule) => text(rule, "each rule"));
      const outputs = list(workflow.outputs, "outputs").map((item) => {
        const output = record(item, "each output");
        const named = text(output.name, "output name");
        const where = text(output.where, "output where");
        if (named.trim() === "" || where.trim() === "") throw new Error("each output needs a name and where");
        return { name: named, where };
      });
      const inputs = list(workflow.inputs, "inputs").map((item) => {
        const input = record(item, "each input");
        return { name: text(input.name, "input name"), description: text(input.description, "input description") };
      });
      if (!nameGiven && !isWorkflowName(name)) {
        throw new Error(`name "${name}" must be lower-case words joined by hyphens, such as "new-site"`);
      }
      if (description.trim() === "" || description.length > MAX_DESCRIPTION_CHARS) {
        throw new Error(`description must be one or two sentences of at most ${MAX_DESCRIPTION_CHARS} characters`);
      }
      if (usage.trim() === "") throw new Error("usage must say how the workflow is started");
      return { name, description, usage, argument_hint: argumentHint, rules, outputs, inputs };
    },
    { signal: scope.signal },
  );
}
