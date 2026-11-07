import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runCreateDag } from "./create_dag.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Turn work units into a validated dependency graph: an edge means \"B needs A's output\", plus pairs that must not run together (mutexes), open uncertainties, and the nodes that can start now.",
  "Use it to plan the order of independent pieces of work you already have; it does not find the goals (`identify_goals`), infer plain goal-to-goal ordering for atask items (`plan_infer_dependency`, `plan_tasks`), schedule or run anything.",
  'Call `{"units":[{"id":"a","statement":"write the schema"},{"id":"b","statement":"backfill the table","resources":["db"]}]}` or `{"text":"..."}`.',
  "A unit has `id`, `statement`, `obligations`, `constraints`, `resources`, `tools` (all optional except a statement or obligations). No `units` means `text` is one unit; text that is itself a `{\"units\":[...]}` request is read as one. A call with neither is refused (`create_dag: requires units or text`).",
  "Each unit is judged one outcome or several: examples and text shape decide first, else a model run; a compound unit splits into its bullet lines, then duplicates merge. Every pair of nodes costs one model run unless the two declare or name (`main.go`) a common resource, which is a mutex.",
  "Runs `omp -p` with no tools, up to 8 at once; a pair the model cannot answer is an open uncertainty, never an edge. A dependency cycle fails the call: `create_dag: classify task graph: validate task graph: taskgraph: dependency cycle: ...`.",
  "Model probabilities are the model's own statements, not calibrated ones. Files and edits nothing.",
  "Returns `{Graph:{Nodes:[{ID,DependsOn,Done}]}, Nodes, SemanticEdges:[{From,To,Evidence}], Mutexes, OpenUncertainty, ResourceRequirements, Ready}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const list = (what: string) => z.array(z.string()).nullable().optional().describe(what);
  return {
    name: "create_dag",
    label: "Create DAG",
    description: DESCRIPTION,
    parameters: z.object({
      units: z
        .array(
          z.object({
            id: z.string().nullable().optional().describe("The unit's id, which nodes and edges cite. Default: derived from the statement."),
            statement: z.string().nullable().optional().describe("The goal in words; needs this or obligations."),
            obligations: list("What the unit must deliver; children of a split unit inherit these."),
            constraints: list("Rules the unit must respect; children inherit these."),
            resources: list("Resources the unit uses (a file, a table); units that share one cannot run together."),
            tools: list("Tools the unit needs; children inherit these."),
          }),
        )
        .nullable()
        .optional()
        .describe("The work units to place in the graph. Default: none, then `text` is read as one unit."),
      text: z.string().nullable().optional().describe("One unit in words when `units` is empty, or a JSON `{\"units\":[...]}` request. Default: empty."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "create_dag is working", () =>
        runCreateDag(params, {
          step: ompModelStep(pi.exec),
          signal,
          onPhase: (phase) => onUpdate?.({ content: [{ type: "text", text: `create_dag: ${phase}` }], details: { status: "running" } }),
        }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
