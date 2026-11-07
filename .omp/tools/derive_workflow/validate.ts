import { placeholdersIn, sourcePattern } from "./parameterize.ts";
import type { Step, WorkflowInput } from "./schemas.ts";
import { checkProblem } from "./step_check.ts";

/** What the workflow was derived from, as the text its commands must appear in. */
export interface SourceText {
  readonly text: string;
}

const LINE_CONTINUATION = /\\+[ \t]*\n/g;

/** Text as a command is compared: `\` line continuations joined and every run of whitespace one space. */
export const squashed = (text: string): string => text.replace(LINE_CONTINUATION, " ").replace(/\s+/g, " ").trim();

/** Everything wrong with a workflow's steps; empty when it is sound. */
export function workflowProblems(
  steps: readonly Step[],
  inputs: readonly WorkflowInput[],
  source: SourceText,
): string[] {
  const problems: string[] = [];
  const sourceText = squashed(source.text);
  const names = new Set(inputs.map((input) => input.name));
  const before = new Set<string>();
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.key)) problems.push(`step key "${step.key}" is used twice`);
    seen.add(step.key);
    for (const required of step.requires) {
      if (!before.has(required)) {
        problems.push(`step "${step.key}" requires "${required}", which is not an earlier step`);
      }
    }
    if (step.run !== undefined && step.kind !== "command") {
      problems.push(`step "${step.key}" is a ${step.kind} step and has a run`);
    }
    if (step.kind === "command" && step.run === undefined) problems.push(`step "${step.key}" is a command with no run`);
    if (step.run !== undefined && !sourcePattern(squashed(step.run), names).test(sourceText)) {
      problems.push(`step "${step.key}" runs "${step.run}", which the source never does`);
    }
    if (step.evidence.length === 0) problems.push(`step "${step.key}" has no evidence`);
    if (step.check !== undefined) {
      const reason = checkProblem(step.check, names, step.run !== undefined);
      if (reason !== undefined) problems.push(`step "${step.key}" check: ${reason}`);
    }
    for (const used of [...(step.run === undefined ? [] : placeholdersIn(step.run, names)), ...(step.needs ?? [])]) {
      if (!names.has(used)) problems.push(`step "${step.key}" needs "${used}", which is not an input`);
    }
    before.add(step.key);
  }
  return problems;
}

/** Throws one error that names every problem of the workflow, or returns when it is sound. */
export function assertSound(steps: readonly Step[], inputs: readonly WorkflowInput[], source: SourceText): void {
  const problems = workflowProblems(steps, inputs, source);
  if (problems.length > 0) throw new Error(`the derived workflow is not sound: ${problems.join("; ")}`);
}
