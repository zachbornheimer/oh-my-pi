import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runDefineObjective } from "./define_objective.js";
import { nodeMachine } from "./machine.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { RUNNER_KINDS } from "./types.js";

const DESCRIPTION = [
  "Shape ONE goal into an atask-ready objective: title, outcome, acceptance lines, a proof that runs the specific work (one test file, package or named test, 30 seconds) and the smallest regression covering what it touches, each check as \`PRESET: SUBJECT size=small|medium|large\`.",
  "When no targeted proof can be grounded the result is a draft with no checks and a \`draft_reason\`; it never invents a command.",
  "It FILES NOTHING: hand the result to \`atask add\` or \`task\`. Use \`identify_goals\` to find the goals first, \`interview\` or \`crystallize_spec\` for a whole feature.",
  'Call \`{"text":"select_model ranks ollama/nimble last when TypeSafe answers","project":"agentmux"}\`.',
  "\`project\` is an atask project id or name (\`atask projects\`) or an absolute checkout path (no open tasks are read for a path); its files, mise tasks, test runners, test files near the goal and open tasks ground the checks. An unknown project is refused. Without \`project\` or \`context\` the result is almost always a draft.",
  "\`changed_files\` override the checkout's; \`alongside\` lists sibling goals this one must not absorb.",
  "One model run (\`omp -p\`, no tools) writes it; a reply that breaks atask's grammar, names a path, task or test the checkout lacks, or proves with a whole suite is asked again with the reasons (3 tries), then fails \`no valid reply after 3 attempts: fix the answer: <problems>\`.",
  "Omitted: select_project (choosing a project from a conversation). Costs one model run plus \`git\`/\`atask\` reads.",
  "Returns \`{title, outcome, acceptance, proof, regression, requires, rationale, targeting, draft, draft_reason?, duplicate_of?, project, applied}\`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const runner = z.object({
    Kind: z.enum(RUNNER_KINDS),
    Dir: z.string(),
    Command: z.string(),
    Detail: z.string(),
  });
  const context = z.object({
    Home: z.string().describe("The checkout's directory."),
    Layout: z.array(z.string()).describe("Paths relative to Home; a directory has a trailing /."),
    Unlisted: z.array(z.string()).describe('Directories ("" is Home) whose children are not all in Layout.'),
    MiseTasks: z.array(z.string()),
    OpenTasks: z.array(z.object({ id: z.string(), title: z.string() })),
    Runners: z.array(runner).nullable().optional(),
    TestFiles: z.array(z.string()).nullable().optional(),
    TestFilesTruncated: z.boolean().nullable().optional(),
    TestNames: z.record(z.string(), z.array(z.string())).nullable().optional(),
    ChangedFiles: z.array(z.string()).nullable().optional(),
  });
  return {
    name: "define_objective",
    label: "Define objective",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The one goal, in words. Blank is refused."),
      project: z.string().nullable().optional().describe("atask project id or name, or an absolute checkout path. Without it the checkout is unknown."),
      changed_files: z.array(z.string()).nullable().optional().describe("Files the work changes, relative to the checkout; override the checkout's own."),
      context: context.nullable().optional().describe("An already-read checkout; skips reading project. Rarely needed."),
      alongside: z.array(z.string()).nullable().optional().describe("The plan's other goals, which this objective must not absorb."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "define_objective is working", () => {
        const given = params.context;
        return runDefineObjective(
          {
            text: params.text,
            project: params.project ?? undefined,
            changed_files: params.changed_files ?? undefined,
            context: given == null ? undefined : {
              ...given,
              Runners: given.Runners ?? undefined,
              TestFiles: given.TestFiles ?? undefined,
              TestFilesTruncated: given.TestFilesTruncated ?? undefined,
              TestNames: given.TestNames ?? undefined,
              ChangedFiles: given.ChangedFiles ?? undefined,
            },
            alongside: params.alongside ?? undefined,
          },
          { step: ompModelStep(pi.exec), machine: nodeMachine(pi.exec, signal), signal },
        );
      });
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
