import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runInterview } from "./interview.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Run one turn of a Socratic spec interview: it asks one question at a time until an idea is specific enough to build; then call `crystallize_spec` with the `session_id` to write the spec.",
  'Start with `{"idea":"a CLI that tracks my reading list"}`; answer with `{"session_id":"a-cli-that-tracks-my-reading-k3x9q2","answer":"Only me, on macOS."}`.',
  "Starting refuses an `answer`; continuing refuses an `idea`; a blank idea or answer is refused, as is a ready session or one with no pending question.",
  "`project` (an atask project name or id, read with `atask projects`) or `cwd` (default: omp's directory) inside a git repository other than $HOME makes the work brownfield, with the repository's name, top-level entries and README opening as context; `~` is greenfield. `context` `{root,name,entries,readme}` replaces the lookup.",
  "From the 3rd answered round on, a model run (`omp -p`, no tools) grades goal, constraint, success-criteria (brownfield: and context) clarity from 0 to 4; status becomes `ready` once ambiguity <= 0.2 and every floor holds (goal .75, constraint .65, success .70, context .60).",
  "Otherwise three persona prompts propose questions and the one aimed at the least clear dimension is asked.",
  "Levels are stated by the model, not TypeSafe Jev's calibrated probabilities.",
  "Each turn spawns up to four model processes (cost, tens of seconds) and writes `$SPECS_DIR` (default ~/.local/share/specs)`/<session_id>/session.json`.",
  "Returns `{session_id, status: asking|ready, question?, target_dimension?, round, ambiguity?, breakdown?, milestone?, floor_failures, brownfield, store_dir}`.",
  "Use `identify_goals` to read goals out of words already written; `define_objective` to shape one known goal.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "interview",
    label: "Spec interview",
    description: DESCRIPTION,
    parameters: z.object({
      session_id: z.string().nullable().optional().describe("The interview to continue. Omit to start one from `idea`."),
      idea: z.string().nullable().optional().describe("What the user wants built, in their words. Required to start; omit to continue."),
      answer: z.string().nullable().optional().describe("The user's answer to the pending question. Required to continue."),
      cwd: z.string().nullable().optional().describe("Start only. Directory the user is in; default omp's directory. Inside a git repo other than $HOME: brownfield."),
      project: z.string().nullable().optional().describe("Start only. Name or id of an atask project; its home is the brownfield context and wins over cwd."),
      context: z
        .object({
          root: z.string(),
          name: z.string(),
          entries: z.array(z.string()),
          readme: z.string(),
        })
        .nullable()
        .optional()
        .describe("Start only. Codebase the idea is about; skips the cwd/project lookup and makes the work brownfield."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "interview is working", () =>
        runInterview(
          {
            session_id: params.session_id ?? undefined,
            idea: params.idea ?? undefined,
            answer: params.answer ?? undefined,
            cwd: params.cwd ?? undefined,
            project: params.project ?? undefined,
            context: params.context ?? undefined,
          },
          { step: ompModelStep(pi.exec), exec: pi.exec, cwd: pi.cwd, signal },
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
