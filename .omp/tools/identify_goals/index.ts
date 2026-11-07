import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runIdentifyGoals } from "./identify_goals.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Read the user's words and return each part's role and the goals it states or implies, each goal cited to the segments it came from.",
  "Runs the identify_intent pass first (verbatim parts with type, intent, strength), then per part Role (request, promised_outcome, constraint, ask), Explicit, Verifiable, Urgency (now, soon, whenever), Scope (single_change, several_changes, ongoing), and one call that merges them into unique goals `{outcome, sources}` citing part ids or the whole prompt's id.",
  'Call `{"text":"The invoice PDF shows last month\'s total, and add a CSV export"}`. Blank text is refused (`the user\'s words are required`).',
  "Failures read `identify intent: <cause>`, `identify the goals: <cause>` or `item <index>: <cause>`; a goal citing an unlisted id is asked again with the reason (3 tries).",
  "It does not rewrite the words and files nothing: use `identify_intent` alone for the parts, `define_objective` to shape one goal into a task, `interview` when the goals are not yet known, `task` to delegate the work.",
  "Every answer is stated by a model (`omp -p`, no tools), not TypeSafe Jev's calibrated probabilities, and Mastra's per-call `runIds` are omitted.",
  "Costs 1 + 2N + 1 model runs for N parts, up to 4 at once, tens of seconds.",
  "Returns `{ID, Content, Parts:[{...identify_intent part, Goals:{Role:{Value}, Explicit, Verifiable, Urgency:{Value}, Scope:{Value}}}], Goals:[{outcome, sources}]}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "identify_goals",
    label: "Identify goals",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The user's words; each part is assessed for the goals it states or implies. Blank is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "identify_goals is working", () =>
        runIdentifyGoals(params.text, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
