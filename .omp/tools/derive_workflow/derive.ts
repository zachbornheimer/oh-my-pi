import type { Candidates } from "./candidates.ts";
import { type Decision, draftSteps, type StepDraft } from "./draft_steps.ts";
import { decideCandidate, type ModelScope, summarize, type WorkflowSummary, writeCheck } from "./models.ts";
import { mapLimit } from "./omp_model.ts";
import { MIN_STRUCTURED_CANDIDATES, outlineDocument } from "./outline.ts";
import { parameterize, placeholdersIn } from "./parameterize.ts";
import { renderSkill } from "./render_skill.ts";
import { type DeriveInput, isWorkflowName, type Step, WORKFLOW_NAME_MESSAGE, type Workflow, type WorkflowInput } from "./schemas.ts";
import { resolveSource } from "./source.ts";
import { assertSound } from "./validate.ts";

/** More candidates than this is a source too big to read at once: bound it with from_turn and to_turn. */
export const MAX_CANDIDATES = 120;
const CANDIDATE_CONCURRENCY = 8;
const CHECK_CONCURRENCY = 4;

/** The derived workflow, plus the steps whose check the model could not write (they carry none). */
export type Derived = Workflow & { readonly warnings?: string[] };

function requireCandidates(label: string, found: Candidates): void {
  if (found.candidates.length === 0) {
    throw new Error(
      `derive_workflow: ${label} has no commands, edits or numbered steps to build a workflow from (${found.seen} seen, ${found.dropped.reads} dropped as reads, ${found.dropped.failed} failed)`,
    );
  }
  if (found.candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `derive_workflow: ${label} has ${found.candidates.length} candidate steps, more than the ${MAX_CANDIDATES} it reads at once; bound it with from_turn and to_turn`,
    );
  }
}

const defaultDescription = (name: string): string => `The ${name.replaceAll("_", " ")} the workflow runs against.`;

/** The inputs with the descriptions the model gave them, else a plain one. */
function inputsOf(
  parameters: readonly { readonly name: string; readonly example?: string }[],
  summary?: WorkflowSummary,
): WorkflowInput[] {
  const described = new Map((summary?.inputs ?? []).map((input) => [input.name, input.description.trim()]));
  return parameters.map(({ name, example }) => ({
    name,
    description: described.get(name) || defaultDescription(name),
    ...(example === undefined ? {} : { example }),
  }));
}

/** The summary prompt: where the source is from, the inputs, the steps found, then the source's own words. */
function summaryBrief(label: string, brief: string, inputs: readonly WorkflowInput[], steps: readonly Step[]): string {
  const listedInputs = inputs.map((input) =>
    `- ${input.name}${input.example === undefined ? "" : ` (example: ${input.example})`}`
  );
  const listedSteps = steps.map((step, index) =>
    `${index + 1}. ${step.title} [${step.kind}]${step.run === undefined ? "" : `: ${step.run}`}`
  );
  return [
    `Source: ${label}`,
    `Inputs:${listedInputs.length === 0 ? " none" : `\n${listedInputs.join("\n")}`}`,
    `Steps:\n${listedSteps.join("\n")}`,
    `Source text:\n${brief}`,
  ].join("\n");
}

function checkInput(input: DeriveInput): void {
  if (input.name !== undefined && !isWorkflowName(input.name)) {
    throw new Error(`derive_workflow: name "${input.name}" ${WORKFLOW_NAME_MESSAGE}`);
  }
  for (const [key, value] of [["from_turn", input.from_turn], ["to_turn", input.to_turn]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`derive_workflow: ${key} must be a positive integer counting from 1; got ${value}`);
    }
  }
  if (input.from_turn !== undefined && input.to_turn !== undefined && input.from_turn > input.to_turn) {
    throw new Error(`derive_workflow: from_turn ${input.from_turn} is after to_turn ${input.to_turn}`);
  }
}

/**
 * Reads a transcript (with its tool calls) or a script, SKILL.md or runbook (already read into `input`) and returns the
 * repeatable process in it as a workflow: steps marked command, judgment, approval or edit, each with the evidence it came
 * from, and the SKILL.md that renders it. It never runs a step; the only calls it makes are `scope.step` model calls.
 */
export async function deriveWorkflow(input: DeriveInput, scope: ModelScope): Promise<Derived> {
  checkInput(input);
  const source = resolveSource(input);
  const label = source.ref ?? source.path ?? input.source;
  const outlined = source.kind === "document" && source.candidates.candidates.length < MIN_STRUCTURED_CANDIDATES;
  const found = outlined ? await outlineDocument(source.text, label, scope) : source.candidates;
  requireCandidates(label, found);

  const decisions: Decision[] = await mapLimit(found.candidates, CANDIDATE_CONCURRENCY, (candidate) =>
    decideCandidate(candidate, scope)
  );
  const drafts = draftSteps(found.candidates, decisions);
  if (drafts.steps.length === 0) {
    throw new Error(
      `derive_workflow: every one of the ${found.candidates.length} candidates in ${label} was judged incidental to that one source`,
    );
  }
  const params = parameterize(drafts.steps.map((step) => step.run), source.kind);
  const names = new Set(params.parameters.map((parameter) => parameter.name));
  const parameterized: StepDraft[] = drafts.steps.map((step, index) => ({ ...step, run: params.runs[index] }));
  const preliminary = inputsOf(params.parameters);

  const warnings: string[] = [];
  const checks = await mapLimit(parameterized, CHECK_CONCURRENCY, async (step) => {
    if (step.kind === "approval") return undefined;
    const result = await writeCheck(step, preliminary, scope);
    if (result.failure !== undefined) warnings.push(`step "${step.key}" has no check: ${result.failure}`);
    return result.check;
  });
  const steps: Step[] = parameterized.map((step, index) => ({
    key: step.key,
    title: step.title,
    kind: step.kind,
    ...(step.run === undefined ? {} : { run: step.run, needs: placeholdersIn(step.run, names) }),
    requires: step.requires,
    ...(checks[index] === undefined ? {} : { check: checks[index] }),
    on_failure: step.on_failure,
    evidence: [...step.evidence],
  }));
  const summary = await summarize(summaryBrief(label, source.brief, preliminary, steps), input.name !== undefined, scope);
  const inputs = inputsOf(params.parameters, summary);
  assertSound(steps, inputs, { text: source.text });

  const record = {
    name: input.name ?? summary.name,
    description: summary.description.trim(),
    trigger: {
      usage: summary.usage.trim(),
      ...(summary.argument_hint.trim() === "" ? {} : { argument_hint: summary.argument_hint.trim() }),
    },
    inputs,
    steps,
    rules: summary.rules.map((rule) => rule.trim()).filter((rule) => rule !== ""),
    outputs: summary.outputs,
    literals: { ...params.literals },
    source: {
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      ...(source.path === undefined ? {} : { path: source.path }),
      candidates_seen: found.seen,
      candidates_kept: found.candidates.length - drafts.incidental,
      dropped: { ...found.dropped, incidental: drafts.incidental },
    },
  };
  return { ...record, skill_markdown: renderSkill(record), ...(warnings.length === 0 ? {} : { warnings: warnings.sort() }) };
}
