import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runDescribeProject } from "./describe.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Write a project description from material you supply, with a model that has no tools. Nothing is stored, no file is written or read, and the repo is not edited; the answer is the description text, not a path.",
  "Use `select_project` to decide which project a thread belongs to, `rewrite_dictated_text` to clean up a dictated prompt.",
  'Call `{"text":"A capability runtime with a CLI and an MCP surface."}` or, to describe a project you already know by id or name, `{"text":"agentmux","projects":[{"id":"p-mux","name":"AgentMux","goal":"delegate work"}]}`.',
  "Text is trimmed; blank is refused (`the user's words are required`). When text equals a live project's id, else its name (case-insensitive), the model reads `Project <name>. <goal>` instead; a project with a non-empty `merged_into` is not live.",
  "One model run (`omp -p`, no tools) replies `{\"Description\": string}`; a blank or malformed reply is asked again with the reason (3 tries), then the call fails `write the description: <cause>`.",
  "The model sees only the material, so the description is only as complete as it.",
  "Costs one model run, seconds.",
  "Returns the description string.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "describe_project",
    label: "Describe project",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The material to describe; if it is a live known project's id or name, that project's name and goal are described instead. Trimmed; blank is refused."),
      projects: z
        .array(z.object({
          id: z.string().describe("Project id; the material may name the project by id."),
          name: z.string().describe("Project name; the material may name the project by name."),
          goal: z.string().nullable().optional().describe("The project's goal, read as the description material when the project is named."),
          merged_into: z.string().nullable().optional().describe("Id of the project this one was merged into; non-empty marks it not live and ignored."),
        }))
        .nullable()
        .optional()
        .describe("Known project records used to resolve a project named by `text`. Default: none."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "describe_project is working", () =>
        runDescribeProject(params.text, params.projects, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: output }], details: { Description: output } };
    },
  };
};

export default factory;
