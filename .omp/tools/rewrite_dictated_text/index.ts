import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { REWRITE_TIMEOUT_MS, runRewrite } from "./rewrite.js";

const DESCRIPTION = [
  "Rewrite dictated text into a structured prompt for a coding agent: remove filler, repetition and false starts; keep every requirement, constraint, identifier, example and the speaker's degree of certainty (preferences stay preferences, questions stay questions). Use it on speech-to-text input before acting on it; to clean up prose that was typed, edit it yourself.",
  "Use `describe_project` to describe a project, `identify_goals` to read goals out of words.",
  'Call `{"text":"so um I want the hook to, like, run on every prompt"}`. Blank text is refused (`the user\'s words are required`).',
  "One model run (`omp -p`, no tools, killed after 120 s) gets the instructions and the text fenced as `<dictated-text>` data, never a request to answer or carry out; a wrapping pair of those tags in the reply is removed.",
  "The rewrite is the model's: nothing checks that it kept every requirement, so compare it with the original when it matters.",
  "It NEVER returns the input on failure: a failed run, a non-zero exit or an empty reply throws, and you keep the original yourself.",
  "Costs one model run, seconds to tens of seconds; writes nothing and needs no API key beyond omp's own.",
  "Returns only the rewritten text.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "rewrite_dictated_text",
    label: "Rewrite dictated text",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The dictated prompt to rewrite for a coding agent. Blank is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const rewritten = await withHeartbeat(onUpdate, "rewrite_dictated_text is working", () =>
        runRewrite(params.text, ompModelStep(pi.exec, { timeoutMs: REWRITE_TIMEOUT_MS }), signal));
      return { content: [{ type: "text", text: rewritten }], details: { text: rewritten } };
    },
  };
};

export default factory;
