import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { promptAnswers } from "./prompt_answers.js";

export const DESCRIPTION = [
  "Answer every standing question about one user prompt in a single model run (`omp -p`, no tools); today that is `Frustrated`: does the message show irritation aimed at the agent or its work. Use it on the user's own words to decide a reaction, for example from a prompt-submit hook; it returns answers and acts on nothing.",
  "Use `prompt_submit_questions` to add dictation or inline questions, and `answer_questions` for question files you supply.",
  'Input: `{"text":"I already told you twice, run it through mise."}`. The text is trimmed; blank text is refused with `prompt_answers: the user\'s words are required`.',
  "Returns `{answers: {Frustrated: 0.9}}`: a yes/no field is P(yes), a number from 0 to 1, the model's stated estimate and not a calibrated probability.",
  "Any failure throws `answer prompt: <cause>`; no default answer is guessed.",
  "Cost: one model process, tens of seconds. Reads one bundled question file; writes nothing. The text is data to the model, never instructions.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "prompt_answers",
    label: "Answer prompt questions",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The user's prompt, answered whole. Trimmed; blank text is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "prompt_answers is working", () =>
        promptAnswers({ text: params.text }, ompModelStep(pi.exec), signal));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
