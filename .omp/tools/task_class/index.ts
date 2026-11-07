import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runTaskClass } from "./classify.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Classify the kind of work one goal is, so a delegate can take the cheapest sufficient path: `simple_edit`, `hard_code`, `structured_extraction`, `research`, `judgment`, `summarization` or `status_update`. It does not do the work.",
  "Use `classify_prompt_parts` for per-part model strength and routing signals, `identify_intent` for ticket type and intent, `select_model` for a model list.",
  'Call `{"text":"Fix the login bug."}`. Text is trimmed; blank text is refused (`the user\'s words are required`).',
  "One model run (`omp -p`, no tools) picks a category from the seven with worked examples and states its confidence, 0 to 1; a malformed reply is asked again with the reason (3 tries).",
  "`certain` is true only when the confidence is at least 0.7 and the pick is one of the seven; otherwise `value` is `hard_code` (the full pipeline) and `certain` is false.",
  "Confidence is stated by the model, not TypeSafe Jev's calibrated probability.",
  "Failure throws `classify task: <cause>`; no class is invented.",
  "Costs one model run, seconds; writes nothing.",
  "Returns `{value, certain, evidence}`; `evidence` is the category the model picked, even after a fallback.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "task_class",
    label: "Task class",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The one goal to classify, in the user's words. Trimmed; blank is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "task_class is working", () =>
        runTaskClass(params.text, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
