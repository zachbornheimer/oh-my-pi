import { candidateId, type Candidates, cleanTitle } from "./candidates.ts";
import { proseOf } from "./document_candidates.ts";
import type { ModelScope } from "./models.ts";
import { askJson } from "./omp_model.ts";
import { outlinePrompt } from "./prompts.ts";

/** A document with fewer numbered lines and commands than this is outlined by the model instead. */
export const MIN_STRUCTURED_CANDIDATES = 2;
const CONTEXT_CHARS = 300;
const MAX_TITLE_CHARS = 80;
const MAX_QUOTE_CHARS = 160;

export interface OutlineStep {
  readonly title: string;
  readonly quote: string;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The 0-based line of `lines` that holds `quote`, looking from `from` on first so the steps keep the document's order. */
function lineOf(lines: readonly string[], quote: string, from: number): number {
  const wanted = squash(quote);
  const holds = (line: string): boolean => squash(line).includes(wanted);
  const after = lines.findIndex((line, index) => index >= from && holds(line));
  return after >= 0 ? after : lines.findIndex(holds);
}

/** Why the outline cannot stand, written for the model; undefined when every step's quote is in the text. */
export function outlineProblem(text: string, steps: readonly OutlineStep[]): string | undefined {
  if (steps.length === 0) return "list at least one step";
  const lines = text.split("\n");
  const missing = steps.findIndex((step) => squash(step.quote) === "" || lineOf(lines, step.quote, 0) < 0);
  return missing < 0
    ? undefined
    : `the quote of step ${missing + 1} ("${
      steps[missing]!.quote
    }") is not on any one line of the text: copy a phrase exactly`;
}

/** The outline as candidates: each step anchored to the line its quote is on, so the evidence is checkable. */
export function outlineCandidates(text: string, steps: readonly OutlineStep[]): Candidates {
  const lines = text.split("\n");
  let from = 0;
  const candidates = steps.map((step, index) => {
    const at = lineOf(lines, step.quote, from);
    from = at;
    return {
      id: candidateId(index),
      title: cleanTitle(step.title),
      commandOnly: false,
      text: `A step the document describes: ${squash(step.quote)}`,
      context: `The line: ${squash(lines[at]!).slice(0, CONTEXT_CHARS)}`,
      evidence: [{ line: at + 1 }],
      retried: false,
    };
  });
  return { candidates, seen: steps.length, dropped: { reads: 0, retries: 0, failed: 0 } };
}

function stepsOf(reply: unknown): OutlineStep[] {
  if (typeof reply !== "object" || reply === null || !Array.isArray((reply as { Steps?: unknown }).Steps)) {
    throw new Error('the reply must be {"Steps":[{"title":"...","quote":"..."}]}');
  }
  return (reply as { Steps: unknown[] }).Steps.map((item, index) => {
    const { title, quote } = (item ?? {}) as { title?: unknown; quote?: unknown };
    if (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE_CHARS) {
      throw new Error(`step ${index + 1} needs a title of 1 to ${MAX_TITLE_CHARS} characters`);
    }
    if (typeof quote !== "string" || quote.trim() === "" || quote.length > MAX_QUOTE_CHARS) {
      throw new Error(`step ${index + 1} needs a quote of 1 to ${MAX_QUOTE_CHARS} characters`);
    }
    return { title, quote };
  });
}

/** Asks the model for the document's steps, each with a quote the text must contain; a quote not on a line is asked again. */
export async function outlineDocument(text: string, path: string, scope: ModelScope): Promise<Candidates> {
  const prose = proseOf(text, path);
  const steps = await askJson(
    scope.step,
    outlinePrompt(prose),
    (reply) => {
      const outlined = stepsOf(reply);
      const problem = outlineProblem(prose, outlined);
      if (problem !== undefined) throw new Error(problem);
      return outlined;
    },
    { signal: scope.signal },
  );
  return outlineCandidates(prose, steps);
}
