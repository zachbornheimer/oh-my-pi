import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { runSelectProject } from "./select.js";

const DESCRIPTION = [
  "Say which project a conversation thread belongs to: one of the live projects you list, or that it needs a new one. It reads no disk and does not create or file anything; you gather the thread and the projects. Use `describe_project` to write a project's description.",
  'Call `{"Turns":[{"Role":"user","Text":"fix the NAS backup"}],"Projects":[{"ID":"p1","Name":"Homelab","Goal":"NAS and home automation","Home":"/code/lab"},{"Name":"AgentMux"}]}`. Field names are Go-style PascalCase.',
  "`Turns` (at least one, oldest first) is required. Optional: `WorkDir`, `Repo`, `Worktree`, `Branch`, `Title`, `FirstRequest`, `Current` (a project record), `Projects` (default `[]`), `ProjectBudget` (bytes of project list shown, default 16384; README, then entries are dropped to fit).",
  "A project record is `{ID?, Name, Goal?, Summary?, Home?, Contents?:{Entries?, Readme?}}`. A project named `new` is refused.",
  "With no projects the answer is `new` and no model runs. Otherwise one model run (`omp -p`, no tools) picks a project name or `new`; a pick off the menu is asked again with the reason (3 tries), then the call fails `ask which project: <cause>`.",
  "Confidence is stated by the model, not TypeSafe Jev's calibrated probabilities.",
  "Costs one model run, seconds; writes nothing.",
  "Returns `{ProjectName, ProjectID, NeedsNewProject, Confidence}`; `ProjectID` is the chosen record's `ID` (empty if none) and `Confidence` is null when no model ran.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const contents = z.object({
    Entries: z.array(z.string()).nullable().optional().describe("Top-level names at the project's home; directories end in \"/\". Default: empty."),
    Readme: z.string().nullable().optional().describe("The opening of the project's README. Default: empty."),
  });
  const project = z.object({
    ID: z.string().nullable().optional().describe("Your id for the project; echoed as `ProjectID` when it is chosen. Default: empty."),
    Name: z.string().describe("The project's name; the answer names a project by this."),
    Goal: z.string().nullable().optional().describe("What the project is for, in its own words. Default: empty."),
    Summary: z.string().nullable().optional().describe("A stored summary; preferred over `Goal`. Default: empty."),
    Home: z.string().nullable().optional().describe("The directory the project's sessions ran in. Default: empty (no home known)."),
    Contents: contents.nullable().optional().describe("What is on disk at the project's home."),
  });
  return {
    name: "select_project",
    label: "Select project",
    description: DESCRIPTION,
    parameters: z.object({
      Turns: z.array(z.object({
        Role: z.string().describe("Who spoke: `user` or `agent`."),
        Text: z.string().describe("What was said."),
      })).describe("The latest meaningful turns of the thread, oldest first. At least one."),
      Projects: z.array(project).nullable().optional().describe("The live projects worth choosing from, and the current one. Default: none."),
      Current: project.nullable().optional().describe("The project the thread is filed under; omit when none."),
      WorkDir: z.string().nullable().optional().describe("The directory the session ran in; it may not match the work. Default: unknown."),
      Repo: z.string().nullable().optional().describe("The main repository WorkDir is in. Default: none."),
      Worktree: z.string().nullable().optional().describe("The git worktree WorkDir is in. Default: none."),
      Branch: z.string().nullable().optional().describe("The git branch of the session. Default: unknown."),
      Title: z.string().nullable().optional().describe("The thread's title. Default: none."),
      FirstRequest: z.string().nullable().optional().describe("The first request of the thread. Default: none."),
      ProjectBudget: z.number().int().positive().nullable().optional().describe("Most bytes of the project list shown to the model. Default: 16384."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "select_project is working", () =>
        runSelectProject(params, { step: ompModelStep(pi.exec), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
