import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { runPlanPhase } from "./plan_phase.js";

const DESCRIPTION = [
  "Classify ONE planned step into its hardening phase: happy_path (the smallest slice that works), structural (reshaping a working solution), edge (unusual or adversarial input) or production (monitoring, docs, rollout, load).",
  "Use it to order the steps of a plan; it does not split a request into steps (use `plan_tasks` or `identify_goals`) and orders nothing itself.",
  'Call `{"text":"Add a table test covering the empty name case"}`; put the overall request in parentheses after the step when known, because a step that IS the requested feature is happy_path even if it sounds like validation. Blank text is refused (`the user\'s words are required`).',
  "One model run (`omp -p`, no tools, about 10 seconds) picks a phase and states its probability; a reply off the menu is asked again with the reason (3 tries), then the call fails `classify phase: <cause>` and no phase is invented.",
  "`certain` is true only when the stated probability is at least 0.6; otherwise `value` is `happy_path` (an unsure step runs first) and `certain` is false.",
  "The probability is the model's own statement, not a calibrated one.",
  "Reads and writes nothing else.",
  "Returns `{value, certain, evidence}`; `evidence` is the phase the model picked, even when it fell back.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "plan_phase",
    label: "Plan phase",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The planned step, with the overall request in parentheses when known. Blank is refused."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "plan_phase is working", () =>
        runPlanPhase(params.text, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
