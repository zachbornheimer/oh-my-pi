import { readFileSync } from "node:fs";
import { decide } from "./decide.js";
import type { ModelStep } from "./omp_model.js";
import { parseQuestionFile, type Question } from "./questions.js";

/**
 * The ask gate: judged before `pin_decision` pins a question for the human. One of four suppressors at 0.7 or more
 * means the agent decides with the boring, standard option instead of spending the user's attention.
 * `MustAskUser` is asked and reported but does not decide: "no standard approach" is true of taste questions too.
 */

export const SUPPRESSORS = ["SolvableWithoutHuman", "AutonomousApproach", "NoCorrectAnswer", "MatterOfTaste"] as const;
export type Suppressor = (typeof SUPPRESSORS)[number];

/** A suppressor at or above this fires. */
export const SUPPRESSION_THRESHOLD = 0.7;

const SUPPRESSOR_GUIDANCE: Record<Suppressor, string> = {
  SolvableWithoutHuman: "FAANG best practice already answers it",
  AutonomousApproach: "an approach can work autonomously",
  NoCorrectAnswer: "no correct answer exists",
  MatterOfTaste: "it is a matter of taste",
};

/** How the gate ended: passed, or could not run (the pin proceeds, and the answer says so). A rejection throws. */
export interface GateOutcome {
  status: "passed" | "unavailable";
  /** The five stated probabilities, when the judge ran. */
  scores?: Record<string, number>;
  /** Why the judge could not run. */
  reason?: string;
}

let gateQuestions: readonly Question[] | undefined;

/** The five gate questions from `ask_gate.yaml` beside this file. */
export function askGateQuestions(): readonly Question[] {
  if (gateQuestions === undefined) {
    const file = new URL("./ask_gate.yaml", import.meta.url);
    const loaded = parseQuestionFile(readFileSync(file, "utf8"), file.pathname);
    const fields = loaded.decisions.map((question) => question.field);
    for (const field of ["MustAskUser", ...SUPPRESSORS]) {
      if (!fields.includes(field)) throw new Error(`${file.pathname} is missing the question ${field}`);
    }
    gateQuestions = loaded.decisions;
  }
  return gateQuestions;
}

/** The strongest suppressor at or above the threshold, as a reason; undefined when none fires. */
export function suppressionReason(scores: Readonly<Record<string, number>>): string | undefined {
  const fired = SUPPRESSORS.map((field) => [field, scores[field] ?? -1] as const)
    .filter(([, value]) => value >= SUPPRESSION_THRESHOLD)
    .sort((left, right) => right[1] - left[1])[0];
  if (fired === undefined) return undefined;
  return `${fired[0]} ${fired[1].toFixed(2)}: ${SUPPRESSOR_GUIDANCE[fired[0]]}.`;
}

/** Words too common to carry meaning for the already-answered check. */
const STOPWORDS = new Set([
  "the", "this", "that", "with", "from", "should", "would", "could", "about",
  "into", "your", "you", "our", "for", "and", "not", "are", "was", "how",
]);

/** The text's significant words: lower-cased, longer than three characters, stopwords dropped. */
export function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word));
}

/**
 * Deterministic already-answered check: when one earlier user message contains every significant word of the
 * question, the user has already spoken this decision. No model call; word coverage only.
 */
export function alreadyAnsweredReason(question: string, earlierUserMessages: readonly string[]): string | undefined {
  const wanted = significantWords(question);
  if (wanted.length === 0) return undefined;
  for (const message of earlierUserMessages) {
    const present = new Set(significantWords(message));
    if (wanted.every((word) => present.has(word))) {
      return `already answered by an earlier user message containing: ${wanted.join(", ")}`;
    }
  }
  return undefined;
}

export function formatAlreadyAnsweredError(reason: string): string {
  return (
    `ask gate: a prior user message already answers this — ${reason.endsWith(".") ? reason : `${reason}.`} `
    + "Act on the user's standing answer and report the choice; do not pin or ask again."
  );
}

export function formatAskGateError(reason: string): string {
  return (
    `ask gate: this question is not worth the user's attention — ${reason} `
    + "Decide it with the boring, standard option, report the choice, and keep working; do not ask again."
  );
}

/**
 * Judges `{question, options}` with one model call. A suppressor at the threshold throws the rejection (the answer, not a
 * failure). A judge that cannot run or answers badly returns `unavailable` with the reason, so the question is pinned
 * rather than lost; the caller's own abort is rethrown.
 */
export async function enforceAskGate(
  input: { question: string; options: readonly string[] },
  step: ModelStep,
  signal?: AbortSignal,
): Promise<GateOutcome> {
  let scores: Record<string, number>;
  try {
    const answers = await decide(step, { question: input.question, options: [...input.options] }, askGateQuestions(), signal);
    scores = Object.fromEntries(Object.entries(answers).map(([field, answer]) => [field, answer as number]));
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  const reason = suppressionReason(scores);
  if (reason !== undefined) throw new Error(formatAskGateError(reason));
  return { status: "passed", scores };
}
