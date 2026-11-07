import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { nodeMachine } from "./define_objective/machine.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { runPlanTasks } from "./plan_tasks.js";

const DESCRIPTION = [
  "Turn the user's words into a plan of atask items for ONE project: per goal a title, outcome, acceptance lines, a proof that runs the specific work and a regression (each `PRESET: SUBJECT size=...`; a draft with no checks when none can be grounded), and which items must finish first.",
  "Use it when the user states work to track; it does not do the work (`task`), shape one goal (`define_objective`) or find goals alone (`identify_goals`).",
  'Call `{"text":"tv.lan resolves to jellyfin instead of sonarr. also jellyfin is hitting oom","project":"homelab"}`.',
  "`project` is an atask project id or name (`atask projects`) or an absolute checkout path; without it one model run chooses among the registered projects or `new`. A project with a home is read for files, mise tasks, test runners and open tasks; a goal that restates an open task gets `duplicate_of`.",
  "Runs `omp -p` (no tools) to split the goals, write each item (up to 4 at once, 3 tries against atask's grammar and the checkout) and judge every pair of goals for order: minutes for several goals.",
  "Default is a DRY RUN: nothing is filed. `apply:true` runs `atask add` per item in dependency order, ONLY when the user asked to file the tasks; it refuses when no project fits (`atask init` first), skips duplicates, and a failing `atask add` stops and names the ids already filed. Applying twice files twice.",
  "Failures read `identify the goals to plan: <cause>` or `write the task for <key>: <cause>`.",
  "Returns `{project:{id,name,needsNewProject}, items:[{key,title,outcome,acceptance,proof,regression,draft,draft_reason?,requires,rationale,goal,sources,duplicate_of?}], applied:[{key,id}]}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "plan_tasks",
    label: "Plan tasks",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The user's words to plan. Blank is refused."),
      project: z
        .string()
        .nullable()
        .optional()
        .describe("atask project id or name, or an absolute checkout directory. Default: a model run chooses from `atask projects`."),
      apply: z
        .boolean()
        .nullable()
        .optional()
        .describe("true files the items with `atask add` after planning; ONLY when the user asked to file them. Default false (dry run)."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "plan_tasks is working", () =>
        runPlanTasks(
          { text: params.text, project: params.project ?? undefined, apply: params.apply ?? false },
          {
            step: ompModelStep(pi.exec),
            machine: nodeMachine(pi.exec, signal),
            cwd: pi.cwd,
            signal,
            onPhase: (phase) => onUpdate?.({ content: [{ type: "text", text: `plan_tasks: ${phase}` }], details: { status: "running" } }),
          },
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
