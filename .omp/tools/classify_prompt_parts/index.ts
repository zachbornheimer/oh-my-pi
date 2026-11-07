import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runClassifyPromptParts } from "./classify.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Score each verbatim part of a prompt for the model strength it needs (`routine`, `reasoning`, `deep`) and six routing signals (SoftwareImplementation, SoftwareArchitecture, DifficultDebugging, Research, Ambiguity, LongHorizon), to route work to a model; it does not rewrite the words.",
  "Use `identify_intent` when you also need ticket type and intent, `task_class` for one goal's kind of work, `select_model` to rank models.",
  'Call `{"text":"Research the cache. Fix the login bug."}`. Blank text is refused (`the user\'s words are required`).',
  "One model run (`omp -p`, no tools) splits the words into verbatim pieces, asked again with the reason up to 3 tries; if that fails the whole prompt is the one part. Each part is then scored by its own model run, up to 4 at once, with the whole prompt as context only.",
  "A part that cannot be scored becomes `deep` with no signals. Either fallback sets `Degraded` and names its cause in `Reasons`; it is not thrown.",
  "Answers are stated by the model (a level and true/false signals), not TypeSafe Jev's calibrated probabilities.",
  "Costs 1 + N model runs, tens of seconds; writes nothing.",
  "Returns `{Prompt:{Content,Parts:[{ID,Content,Span:{Start,End} (UTF-8 bytes),ModelStrength:{Point,Value}, six booleans}]}, Requirements:{Strength,Signals}, Degraded, Reasons}`; Requirements is the deepest strength and any signal over the parts.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "classify_prompt_parts",
    label: "Classify prompt parts",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The prompt to split into verbatim parts and score. Trimmed; blank is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "classify_prompt_parts is working", () =>
        runClassifyPromptParts(params.text, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
