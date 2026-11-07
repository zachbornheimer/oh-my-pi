import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { promptSubmitQuestions, toSources } from "./prompt_submit_questions.js";

export const DESCRIPTION = [
  "Answer a batch of prompt-submit questions about shared prompt context and return one `{answers}` map keyed by question id, using model runs (`omp -p`, no tools). Use it for the questions a prompt-submit hook asks of each user prompt; use `prompt_answers` for just the standing questions and `answer_questions` for your own question files.",
  'Input: `{"state":{"user_message":"..."},"questions":[{"file":"prompt_answers"}]}`. `state` is any JSON the questions may read. Each question is `{file}` (bundled `prompt_answers` or `dictation`), `{id, question, choices}` (a decision; choices `{true,false}` make it yes/no), or `{id, kind:"language", question, schema, examples?}` (a JSON Schema the reply must match). Fields of other forms are refused.',
  "Duplicate ids, an unknown file, an empty `choices` or a schema that cannot be checked fail before any model runs.",
  "Decision questions are split by size into batches; batches and language questions run concurrently (up to four model processes). Any failure fails the whole call and nothing is guessed.",
  "Returns `{answers}`: yes/no is P(yes) from 0 to 1, choice `{Value, Probabilities}`, score `{Point, Probabilities}`, language its JSON value. Probabilities are the model's stated estimates, not calibrated.",
  "Cost: one model process per batch and per language question. Reads two bundled files; writes nothing. State is data, never instructions.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  // omp's schema builder (pi.zod) cannot union objects and has no .nullish(): one flat object, sorted in code.
  const question = z.object({
    file: z.string().nullable().optional().describe("A bundled question file: `prompt_answers` or `dictation`. Excludes every other field."),
    id: z.string().nullable().optional().describe("Answer key for an inline question; unique within `questions`."),
    kind: z.string().nullable().optional().describe('`language` for a language-model question; omit for a decision.'),
    question: z.string().nullable().optional().describe("Inline question text the model answers."),
    choices: z.record(z.string(), z.string()).nullable().optional().describe(
      "Decision only: allowed answers, value -> meaning. Exactly `true` and `false` makes a yes/no question.",
    ),
    schema: z.record(z.string(), z.unknown()).nullable().optional().describe("Language only: JSON Schema the answer must match."),
    examples: z.array(z.string()).nullable().optional().describe("Language only: example answers that show the shape wanted. Default none."),
  });
  return {
    name: "prompt_submit_questions",
    label: "Answer prompt-submit questions",
    description: DESCRIPTION,
    parameters: z.object({
      state: z.unknown().describe("Shared prompt context every question may read: a string or any JSON."),
      questions: z.array(question).min(1).describe("Questions to answer, keyed by `id` (or by the field names inside a bundled file)."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "prompt_submit_questions is working", () =>
        promptSubmitQuestions(
          { state: params.state, questions: toSources(params.questions) },
          ompModelStep(pi.exec),
          signal,
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
