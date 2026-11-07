import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runCrystallize } from "./crystallize.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";

const DESCRIPTION = [
  "Write the spec for a finished `interview`: one model run (`omp -p`, no tools) drafts seed.json (goal, RFC 2119 constraints, non-goals, acceptance criteria AC-001… each with a one-line verify command, ontology, deferred and open questions, metadata with a sha256) and spec.md in GitHub Spec Kit's headings, into `$SPECS_DIR/<session_id>/` (default ~/.local/share/specs).",
  'Call `{"session_id":"a-cli-that-tracks-my-reading-k3x9q2"}`; add `"repo":"/abs/path/to/checkout"` (an absolute git checkout) to also write `<repo>/specs/<session_id>/`.',
  "An interview whose status is not `ready` is refused, naming its ambiguity and floor failures, unless `force: true` (then `gate_forced: true` is recorded); an unknown session id or a bad repo is refused before any model call.",
  "Written files are NEVER replaced: crystallizing again writes seed.v2.json and spec.v2.md, at the first version free in every target directory.",
  "A seed with a constraint that is not `The system MUST …` (MUST NOT, SHOULD, SHOULD NOT, MAY), a title over 80 characters, no criterion, or a multi-line verify command is asked again with the reason, up to 3 calls, then fails with nothing written.",
  "Costs one model call, tens of seconds. Returns `{session_id, spec_path, seed_path, repo_spec_path?, ambiguity, gate_forced}`.",
  "Run `interview` first to make the session; use `define_objective` to shape one goal into a task, not a whole spec.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "crystallize_spec",
    label: "Crystallize spec",
    description: DESCRIPTION,
    parameters: z.object({
      session_id: z.string().describe("The interview to crystallize: the session_id `interview` returned."),
      force: z.boolean().nullable().optional().describe("Write the spec although the interview has not passed the ambiguity gate; records gate_forced: true. Default false."),
      repo: z.string().nullable().optional().describe("Absolute path of a git checkout; the spec and seed are also written to <repo>/specs/<session_id>/."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "crystallize_spec is working", () =>
        runCrystallize(
          { session_id: params.session_id, force: params.force ?? undefined, repo: params.repo ?? undefined },
          { step: ompModelStep(pi.exec), signal },
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
