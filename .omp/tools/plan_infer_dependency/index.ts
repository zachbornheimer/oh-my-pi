import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { runInferDependency } from "./plan_infer_dependency.js";

const DESCRIPTION = [
  "Infer which planned goals must wait for which others: every unordered pair of goals is judged once, so two goals never depend on each other.",
  "Use it on goals you already have; it does not find the goals (`identify_goals`), build a graph of work units (`create_dag`), reorder the plan or run anything.",
  'Call `{"goals":[{"id":"w","statement":"write the migration"},{"id":"r","statement":"run the migration against staging","criteria":["staging has the new column"]}]}`.',
  "Every goal needs a unique non-blank `id` (`infer dependency: goal <index> (<statement>) has no id`, `infer dependency: duplicate goal id <id>`); an empty or omitted `goals` returns no edges.",
  "N goals cost N(N-1)/2 model runs (`omp -p`, no tools), up to 8 at once, about 10 seconds each round.",
  "A pair whose reply stays invalid after 3 tries, or whose stated probability is under 0.6, is a guess: the later goal depends on the earlier one, and that edge is listed in `guessed`.",
  "Only a cancelled run fails the call (`infer dependency: run cancelled`).",
  "Probabilities are the model's own statements, not calibrated ones.",
  "Files and edits nothing.",
  "Returns `{edges:[{from,to}], guessed, certainty}`: goal `from` waits for goal `to`; `certainty` is 1 when no edge is guessed, else 0.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "plan_infer_dependency",
    label: "Infer plan dependencies",
    description: DESCRIPTION,
    parameters: z.object({
      goals: z
        .array(
          z.object({
            id: z.string().nullable().optional().describe("Unique goal id; required and non-blank. Edges cite goals by it."),
            statement: z.string().nullable().optional().describe("What the goal is; shown to the judge for each pair."),
            criteria: z.array(z.string()).nullable().optional().describe("Acceptance criteria, shown with the statement. Default none."),
          }),
        )
        .nullable()
        .optional()
        .describe("The planned goals to order. Default: none (no edges)."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const goals = (params.goals ?? []).map((goal) => ({
        id: goal.id ?? "",
        statement: goal.statement ?? "",
        ...(goal.criteria == null ? {} : { criteria: goal.criteria }),
      }));
      const output = await withHeartbeat(onUpdate, "plan_infer_dependency is working", () =>
        runInferDependency(goals, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
