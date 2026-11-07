import { type Answer, decisionPrompt, parseDecisions } from "./decide.js";
import { askJson, mapLimit, type ModelStep } from "./omp_model.js";
import {
  SCHEMA_LEAD,
  SPLIT_EXAMPLE,
  SPLIT_INSTRUCTIONS,
  SPLIT_REPLY_SCHEMA,
  STRENGTH_INTRO,
  STRENGTH_QUESTIONS,
  WORDS_BANNER,
  WORDS_CLOSE,
  WORDS_OPEN,
} from "./questions.js";
import { type LocatedPart, locatePieces, promptText, wholePrompt } from "./segment.js";

/** Parts scored at once; each is one `omp -p` process, so the bound is lower than the Mastra twin's 16. */
export const SCORE_CONCURRENCY = 4;

/** The strength levels, weakest first. A part's `Point` is an index into this list. */
export const STRENGTH_NAMES = ["routine", "reasoning", "deep"] as const;
export type StrengthName = (typeof STRENGTH_NAMES)[number];
const DEEPEST_POINT = STRENGTH_NAMES.length - 1;

/** The six routing signals, as the output fields (agentmux `ModelSignals`). */
export const SIGNAL_FIELDS = [
  "SoftwareImplementation",
  "SoftwareArchitecture",
  "DifficultDebugging",
  "Research",
  "Ambiguity",
  "LongHorizon",
] as const;
export type SignalField = (typeof SIGNAL_FIELDS)[number];
export type Signals = Record<SignalField, boolean>;

export interface Strength extends Signals {
  /** Point is the level index (0 routine, 1 reasoning, 2 deep); Value its name. */
  ModelStrength: { Point: number; Value: string };
}

export type ClassifiedPart = LocatedPart & Strength;

export interface Requirements {
  Strength: StrengthName;
  Signals: Signals;
}

export interface ClassifyPromptPartsResult {
  Prompt: { Content: string; Parts: ClassifiedPart[] };
  Requirements: Requirements;
  Degraded: boolean;
  Reasons: string[];
}

export interface ClassifyDeps {
  step: ModelStep;
  signal?: AbortSignal;
  concurrency?: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const noSignals = (): Signals => ({
  SoftwareImplementation: false,
  SoftwareArchitecture: false,
  DifficultDebugging: false,
  Research: false,
  Ambiguity: false,
  LongHorizon: false,
});

/** The reason a part fell back, as agentmux words it. */
export function fallbackReason(partId: string, error: unknown): string {
  return `classify_prompt_parts: part ${partId} fell back to a conservative value: ${messageOf(error)}`;
}

/**
 * The strength and signals to use when a part's own answers could not be used: the deepest level and no signals.
 * Claiming the deepest level keeps a hard part from being routed as if it were easy.
 */
export function weakestStrength(): Strength {
  return { ModelStrength: { Point: DEEPEST_POINT, Value: STRENGTH_NAMES[DEEPEST_POINT] }, ...noSignals() };
}

/** The strength and signals a model stated for one part's answers. */
export function readStrength(answers: Record<string, Answer>): Strength {
  const strength = answers.ModelStrength;
  if (typeof strength !== "object" || !("Point" in strength)) throw new Error("ModelStrength was not answered");
  const signals = noSignals();
  for (const field of SIGNAL_FIELDS) {
    const answer = answers[field];
    if (typeof answer !== "boolean") throw new Error(`${field} was not answered true or false`);
    signals[field] = answer;
  }
  return { ModelStrength: { Point: strength.Point, Value: strength.Value }, ...signals };
}

/**
 * The prompt's requirement: the deepest strength any part asks for, and each signal any part carries. One demanding
 * part decides, so a hard piece is never averaged away by easy ones.
 */
export function aggregateRequirements(parts: readonly Strength[]): Requirements {
  const signals = noSignals();
  let deepest = -1;
  for (const part of parts) {
    deepest = Math.max(deepest, part.ModelStrength.Point);
    for (const field of SIGNAL_FIELDS) signals[field] = signals[field] || part[field];
  }
  return { Strength: STRENGTH_NAMES[deepest] ?? STRENGTH_NAMES[DEEPEST_POINT], Signals: signals };
}

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

/** The model request that scores one part, with the whole prompt as context only. */
export function scorePrompt(words: string, part: LocatedPart): string {
  return decisionPrompt(STRENGTH_INTRO, STRENGTH_QUESTIONS, part.Content, words);
}

/**
 * Scores each verbatim part of a prompt (agentmux's classify_prompt_parts). A split that fails leaves the whole prompt as
 * one part, and a part that cannot be scored becomes the deepest strength with no signals; each sets `Degraded` and
 * names its cause in `Reasons`. Only a cancellation throws.
 */
export async function runClassifyPromptParts(text: unknown, deps: ClassifyDeps): Promise<ClassifyPromptPartsResult> {
  const words = promptText(text);
  const reasons: string[] = [];

  let parts: LocatedPart[];
  try {
    parts = await askJson(deps.step, splitPrompt(words), (value) => locatePieces(words, parsePieces(value)), {
      signal: deps.signal,
    });
  } catch (error) {
    deps.signal?.throwIfAborted();
    reasons.push(`classify_prompt_parts: the split fell back to the whole prompt as one part: ${messageOf(error)}`);
    parts = [wholePrompt(words)];
  }

  const outcomes = await mapLimit(parts, deps.concurrency ?? SCORE_CONCURRENCY, async (part) => {
    try {
      const answers = await askJson(
        deps.step,
        scorePrompt(words, part),
        (value) => parseDecisions(STRENGTH_QUESTIONS, value),
        { signal: deps.signal },
      );
      return { part: { ...part, ...readStrength(answers) } as ClassifiedPart };
    } catch (error) {
      deps.signal?.throwIfAborted();
      return { part: { ...part, ...weakestStrength() } as ClassifiedPart, reason: fallbackReason(part.ID, error) };
    }
  });

  const classified = outcomes.map((outcome) => outcome.part);
  for (const outcome of outcomes) {
    if (outcome.reason !== undefined) reasons.push(outcome.reason);
  }
  return {
    Prompt: { Content: words, Parts: classified },
    Requirements: aggregateRequirements(classified),
    Degraded: reasons.length > 0,
    Reasons: reasons,
  };
}
