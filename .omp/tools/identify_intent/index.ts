import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runIdentifyIntent } from "./intent.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Cut the user's words into verbatim parts and assess each part: atomic or compound, ticket type (bug, feature, task), intent (implementation, debugging, research, analysis, writing, operation, decision, review), needed model strength (routine, reasoning, deep) and six routing signals (SoftwareImplementation, SoftwareArchitecture, DifficultDebugging, Research, Ambiguity, LongHorizon).",
  "Use `identify_goals` for the goals those parts state, `classify_prompt_parts` when only strength and routing are needed; it does not rewrite the words.",
  'Call `{"text":"Research the cache. Fix the login bug."}`. Blank text is refused (`the user\'s words are required`).',
  "One model run (`omp -p`, no tools) splits the words; its pieces MUST be the text verbatim, in order, covering it, or it is asked again with the reason (3 tries) and the call fails `split the words: <cause>`.",
  "Each part is then assessed by its own model run, up to 4 at once, with the whole prompt as context only; a bad part fails the call `item <position>: <cause>`.",
  "Answers are stated by the model: choices, true/false and a strength level, not TypeSafe Jev's calibrated probabilities.",
  "Costs 1 + N model runs, tens of seconds; writes nothing.",
  "Returns `{Content, Parts:[{ID, Content, Span:{Start,End} (UTF-8 bytes), Atomic:{Value}, Type:{Value}, Intent:{Value}, ModelStrength:{Point,Value}, six booleans}]}` in order.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "identify_intent",
    label: "Identify intent",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The user's words, cut into verbatim parts and assessed. Blank is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "identify_intent is working", () =>
        runIdentifyIntent(params.text, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
