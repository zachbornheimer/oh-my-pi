import { type Answer, decisionPrompt, parseDecisions } from "./decide.js";
import { askJson, mapLimit, type ModelStep } from "../omp_model.js";
import {
  ASSESS_INTRO,
  ASSESS_QUESTIONS,
  SCHEMA_LEAD,
  SPLIT_EXAMPLE,
  SPLIT_INSTRUCTIONS,
  SPLIT_REPLY_SCHEMA,
  WORDS_BANNER,
  WORDS_CLOSE,
  WORDS_OPEN,
} from "./questions.js";
import { type LocatedPart, locatePieces, promptText } from "./segment.js";

/** Parts assessed at once; each is one `omp -p` process, so the bound is lower than the Mastra twin's 16. */
export const ASSESS_CONCURRENCY = 4;

/** What the model stated for one part, beside where the part sits in the words. */
export interface AssessedPart extends LocatedPart {
  Atomic: { Value: string };
  Type: { Value: string };
  Intent: { Value: string };
  /** Point is the level index (0 routine, 1 reasoning, 2 deep); Value its name. */
  ModelStrength: { Point: number; Value: string };
  SoftwareImplementation: boolean;
  SoftwareArchitecture: boolean;
  DifficultDebugging: boolean;
  Research: boolean;
  Ambiguity: boolean;
  LongHorizon: boolean;
}

export interface IdentifyIntentResult {
  Content: string;
  Parts: AssessedPart[];
}

export interface IntentDeps {
  step: ModelStep;
  signal?: AbortSignal;
  concurrency?: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One model request asking for the words' pieces, with the words fenced as data and the reply schema last. */
export function splitPrompt(words: string): string {
  return [
    "## Pieces",
    SPLIT_INSTRUCTIONS,
    `Example:\n${SPLIT_EXAMPLE}`,
    "",
    "Prompt:",
    `${WORDS_BANNER}\n${WORDS_OPEN}\n${words}\n${WORDS_CLOSE}`,
    "",
    `${SCHEMA_LEAD}${JSON.stringify(SPLIT_REPLY_SCHEMA)}`,
  ].join("\n");
}

/** The pieces a split reply carries: `{"Pieces": [...]}` or the bare array. */
export function parsePieces(value: unknown): string[] {
  const pieces = Array.isArray(value) ? value : (value as { Pieces?: unknown } | null)?.Pieces;
  if (!Array.isArray(pieces) || pieces.some((piece) => typeof piece !== "string")) {
    throw new Error('the reply must be {"Pieces": [string, ...]}');
  }
  return pieces as string[];
}

/**
 * The words, cut into verbatim pieces in order. A reply whose pieces do not locate in the words is refused with the
 * reason, so the model is told what to correct before it answers again.
 */
export async function splitWords(deps: IntentDeps, words: string): Promise<LocatedPart[]> {
  try {
    return await askJson(deps.step, splitPrompt(words), (value) => locatePieces(words, parsePieces(value)), {
      signal: deps.signal,
    });
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`split the words: ${messageOf(error)}`);
  }
}

/** One part, asked every assessment question with the whole prompt as context only. */
export async function assessPart(deps: IntentDeps, words: string, part: LocatedPart, position: number): Promise<AssessedPart> {
  try {
    const answers = await askJson(
      deps.step,
      decisionPrompt(ASSESS_INTRO, ASSESS_QUESTIONS, part.Content, words),
      (value) => parseDecisions(ASSESS_QUESTIONS, value),
      { signal: deps.signal },
    );
    return { ...part, ...assessed(answers) };
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`item ${position}: ${messageOf(error)}`);
  }
}

function assessed(answers: Record<string, Answer>): Omit<AssessedPart, keyof LocatedPart> {
  return {
    Atomic: answers.Atomic as { Value: string },
    Type: answers.Type as { Value: string },
    Intent: answers.Intent as { Value: string },
    ModelStrength: answers.ModelStrength as { Point: number; Value: string },
    SoftwareImplementation: answers.SoftwareImplementation as boolean,
    SoftwareArchitecture: answers.SoftwareArchitecture as boolean,
    DifficultDebugging: answers.DifficultDebugging as boolean,
    Research: answers.Research as boolean,
    Ambiguity: answers.Ambiguity as boolean,
    LongHorizon: answers.LongHorizon as boolean,
  };
}

/** Cut a prompt into verbatim parts, then assess each part. */
export async function runIdentifyIntent(text: unknown, deps: IntentDeps): Promise<IdentifyIntentResult> {
  const words = promptText(text);
  const parts = await splitWords(deps, words);
  const assessedParts = await mapLimit(parts, deps.concurrency ?? ASSESS_CONCURRENCY, (part, position) =>
    assessPart(deps, words, part, position));
  return { Content: words, Parts: assessedParts };
}
