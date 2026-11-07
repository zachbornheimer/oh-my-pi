import type { StepContext } from "./context.js";
import { askJson } from "./omp_model.js";
import { modelPrompt, PSEUDOCODE } from "./prompts.js";
import { arrayAt, recordAt, replyField, stringAt } from "./reply.js";
import type { Leaf, Source } from "./types.js";

export const STEP_KINDS = ["det", "model", "host"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const MAX_PSEUDOCODE_STEPS = 14;
/** The input line, the steps, the output line and the apply line. */
export const MAX_PSEUDOCODE_LINES = MAX_PSEUDOCODE_STEPS + 3;

export interface Pseudocode {
  readonly input: string;
  readonly steps: readonly { readonly kind: StepKind; readonly line: string }[];
  readonly output: string;
  readonly apply: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function pseudocodeAt(value: unknown, path: string): Pseudocode {
  const code = recordAt(value, path);
  return {
    input: stringAt(code.input, `${path}.input`),
    steps: arrayAt(code.steps, `${path}.steps`).map((step, index) => {
      const entry = recordAt(step, `${path}.steps[${index}]`);
      const kind = entry.kind;
      if (typeof kind !== "string" || !(STEP_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`${path}.steps[${index}].kind must be one of ${STEP_KINDS.join(", ")}`);
      }
      return { kind: kind as StepKind, line: stringAt(entry.line, `${path}.steps[${index}].line`) };
    }),
    output: stringAt(code.output, `${path}.output`),
    apply: stringAt(code.apply, `${path}.apply`),
  };
}

/** Whether `text` names `field` as a whole identifier. */
function names(text: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i").test(text);
}

/** Why the pseudocode cannot stand for `leaf`, written for the model; undefined when it names every field and fits its kind. */
export function pseudocodeProblem(leaf: Leaf, pseudocode: Pseudocode): string | undefined {
  const { steps } = pseudocode;
  if (steps.length === 0 || steps.length > MAX_PSEUDOCODE_STEPS) {
    return `write from 1 to ${MAX_PSEUDOCODE_STEPS} steps`;
  }
  if (steps.some((step) => oneLine(step.line) === "")) return "every step needs a line saying what it does";
  const missingInput = leaf.input_fields.find((field) => !names(pseudocode.input, field));
  if (missingInput !== undefined) return `the input line must name the input field "${missingInput}"`;
  const missingOutput = leaf.output_fields.find((field) => !names(pseudocode.output, field));
  if (missingOutput !== undefined) return `the output line must name the output field "${missingOutput}"`;
  if (oneLine(pseudocode.apply) === "") return 'apply must say what running it changes outside the program, or "nothing"';
  const has = (kind: StepKind): boolean => steps.some((step) => step.kind === kind);
  if (leaf.kind === "deterministic" && has("model")) {
    return "the capability is deterministic, so no step may be a model call: make it det or host";
  }
  if (leaf.kind === "model" && !has("model")) {
    return "the capability needs a model: mark the step that calls it with kind model";
  }
  if (leaf.kind === "host" && !has("host")) return "the capability acts on the host: mark that step with kind host";
  return undefined;
}

/** The pseudocode as lines: input, numbered steps each marked det, model or host, output, apply. */
export function renderPseudocode(pseudocode: Pseudocode): string {
  return [
    `input: ${oneLine(pseudocode.input)}`,
    ...pseudocode.steps.map((step, index) => `${index + 1}. [${step.kind}] ${oneLine(step.line)}`),
    `output: ${oneLine(pseudocode.output)}`,
    `apply: ${oneLine(pseudocode.apply)}`,
  ].join("\n");
}

const listed = (fields: readonly string[]): string => fields.join(", ");

/** One model call: pseudocode for a leaf of phase 1 that names its fields and marks each step. */
export async function writePseudocode(leaf: Leaf, source: Source, ctx: StepContext): Promise<string> {
  ctx.progress(`${source.ref}: pseudocode for ${leaf.name}`);
  const prompt = modelPrompt(
    PSEUDOCODE,
    [
      `Source: ${source.ref} (${source.kind})`,
      `Capability: ${leaf.name}`,
      `Kind: ${leaf.kind}`,
      `Purpose: ${leaf.purpose}`,
      `Input: ${leaf.input_summary}`,
      `Input fields: ${listed(leaf.input_fields)}`,
      `Output: ${leaf.output_summary}`,
      `Output fields: ${listed(leaf.output_fields)}`,
      `Evidence: ${listed(leaf.evidence)}`,
    ].join("\n"),
  );
  return askJson(ctx.step, prompt, (reply) => {
    const code = pseudocodeAt(replyField(reply, PSEUDOCODE.field), PSEUDOCODE.field);
    const problem = pseudocodeProblem(leaf, code);
    if (problem !== undefined) throw new Error(problem);
    return renderPseudocode(code);
  }, { signal: ctx.signal });
}
