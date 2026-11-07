import { askAccepted, type ModelStep, parseJsonReply } from "./omp.js";
import { type LanguageQuestion, QUESTIONS } from "./questions.js";

const SCHEMA_LEAD = "\nRespond as JSON matching this schema:\n";

/** The JSON Schema of a reply: an object whose one required key is the question's field. */
function replySchema(question: LanguageQuestion): Record<string, unknown> {
  return {
    type: "object",
    properties: { [question.field]: question.schema },
    required: [question.field],
    additionalProperties: false,
  };
}

/** What a model reads for one JSON question: instructions, examples, the input, then the reply schema. */
export function languageRequest(question: LanguageQuestion, input: string): string {
  const examples = question.examples.map((example) => `Example:\n${example}\n`).join("");
  const text = `## ${question.field}\n${question.instructions}\n${examples}\nPrompt:\n${input}\n`;
  return text + SCHEMA_LEAD + JSON.stringify(replySchema(question));
}

/** The one place a model is asked from: JSON replies parsed and checked in code, free-text replies accepted in code. */
export interface Model {
  /** Asks a JSON question; `parse` and `accept` throw a reason, and the model is asked again with it. */
  json<T, V>(
    question: keyof typeof QUESTIONS,
    field: string,
    input: string,
    parse: (value: unknown) => V,
    accept: (parsed: V) => T,
  ): Promise<T>;
  /** Asks for free text; `accept` throws a reason to ask again. */
  text<T>(prompt: string, accept: (reply: string) => T): Promise<T>;
}

export function modelOf(step: ModelStep, signal?: AbortSignal): Model {
  return {
    json(question, field, input, parse, accept) {
      const prompt = languageRequest(QUESTIONS[question][field]!, input);
      return askAccepted(step, prompt, (reply) => accept(parse(parseJsonReply(reply))), { signal });
    },
    text(prompt, accept) {
      return askAccepted(step, prompt, accept, { signal });
    },
  };
}

/** Runs `work` over `items`, at most `limit` at a time, results in order. Waits for all to settle before throwing the first failure. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]!, index);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}
