import { readFileSync } from "node:fs";
import { type DecisionAnswer, decide } from "./decide.js";
import type { ModelStep } from "./omp_model.js";
import { parseQuestionFile, type Question } from "./questions.js";

/** How the decision step is shown the message. Every question in the file shares this state. */
export const MESSAGE_LEAD = "The user's message to their coding agent:";

export const NO_WORDS_MESSAGE = "prompt_answers: the user's words are required";

/** The standing questions, read once from `prompt_answers.yaml` beside this file. */
let questions: readonly Question[] | undefined;

export function standingQuestions(): readonly Question[] {
  if (questions === undefined) {
    const file = new URL("./prompt_answers.yaml", import.meta.url);
    const loaded = parseQuestionFile(readFileSync(file, "utf8"), file.pathname);
    if (loaded.decisions.length === 0 || Object.keys(loaded.language).length > 0) {
      throw new Error(`${file.pathname} must hold decision questions only`);
    }
    questions = loaded.decisions;
  }
  return questions;
}

export interface PromptAnswersOutput {
  answers: Record<string, DecisionAnswer>;
}

/** Asks every standing question about the whole prompt in one model call. Blank text is refused; nothing is guessed. */
export async function promptAnswers(
  input: { text: string },
  step: ModelStep,
  signal?: AbortSignal,
): Promise<PromptAnswersOutput> {
  const words = input.text.trim();
  if (words === "") throw new Error(NO_WORDS_MESSAGE);
  const asked = standingQuestions();
  try {
    return { answers: await decide(step, { [MESSAGE_LEAD]: words }, asked, signal) };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`answer prompt: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
