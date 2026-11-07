import { languagePrompt } from "./decide.js";
import { compileSchema, violations } from "./json_schema.js";
import { askJson, type ModelStep } from "./omp_model.js";
import type { LanguageQuestion } from "./questions.js";

/** The schema of a whole reply: an object whose one required key is the question's field. */
export function replySchema(question: LanguageQuestion): Record<string, unknown> {
  return {
    type: "object",
    properties: { [question.field]: question.schema },
    required: [question.field],
    additionalProperties: false,
  };
}

/** Throws, naming the field, when the question's schema uses a keyword the checker cannot enforce. */
export function checkable(question: LanguageQuestion): void {
  try {
    compileSchema(replySchema(question), `question ${question.field} schema`);
  } catch (error) {
    throw new Error(`question ${question.field} has a schema that cannot be checked: ${(error as Error).message}`);
  }
}

/**
 * Asks one language question about `text` and returns the JSON value under its field. A reply that does not parse or
 * does not match the question's schema is asked again with the reason; the last reason is the error.
 */
export function answerLanguage(
  step: ModelStep,
  question: LanguageQuestion,
  text: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const wrapper = replySchema(question);
  return askJson(
    step,
    languagePrompt(question, text),
    (value) => {
      const problems = violations(value, wrapper);
      if (problems.length > 0) throw new Error(problems.join("; "));
      return (value as Record<string, unknown>)[question.field];
    },
    { signal },
  );
}
