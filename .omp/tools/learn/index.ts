import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { learn } from "./learn.js";
import { ompSessionStep, withHeartbeat } from "./omp_session.js";

const DESCRIPTION = [
  "Apply one reviewed session: a learning-applier agent, run as a full `omp -p` session, reads the forensics review and the annotated transcript, implements the suggestions it judges worth landing, runs experiments and smoke checks, and commits. Call ONLY when the user asked to apply a review (the output of `extract_hypotheses`); to merely read a review use `read`.",
  'Input `{"conversation":"omp:<id>","annotated_path":"/…/x.annotated.json","review_path":"/…/x.review.md"}`; `report_markdown` is optional (the review is checked on disk at `review_path`, which MUST exist and be non-blank, and the applier reads that file).',
  "SIDE EFFECTS: the applier edits files anywhere on this machine and commits in the repositories that own them (config, skills, hooks, repos under ~/Developer); it can run for an hour or more and spends model quota. A router in-flight-budget refusal is retried after 60, 120 and 240 s; any other failure, a non-zero exit, a 2 h timeout or an empty answer fails the call.",
  "Every sha the answer names is checked with `git` in the repositories whose paths the answer mentions (and the chezmoi source, when installed); a sha no repository holds is reported as unverified, never as a commit.",
  "Returns `{conversation, review_path, answer_markdown, commits:[{repo,sha}], unverified_shas}`. It does NOT record the learning in session memory (that store is a Mastra Postgres facility not ported), so no `memory_ref` is returned.",
].join(" ");

/** Longest apply session before it is killed. */
const APPLY_TIMEOUT_MS = 2 * 60 * 60_000;

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "learn",
    label: "Learn",
    description: DESCRIPTION,
    parameters: z.object({
      conversation: z.string().describe("`<harness>:<id>` of the reviewed session, as `extract_hypotheses` returned it."),
      annotated_path: z.string().describe("Absolute path of the annotated export the review was written from."),
      review_path: z.string().describe("Absolute path of the review file; MUST exist and be non-blank."),
      report_markdown: z
        .string()
        .nullable()
        .optional()
        .describe("The review text, when the caller has it; omit to use the file at `review_path`."),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      for (const field of ["conversation", "annotated_path", "review_path"] as const) {
        if (params[field].trim() === "") throw new Error(`learn: \`${field}\` is blank`);
      }
      let status = "asking the applier";
      const result = await withHeartbeat(
        onUpdate,
        () => `learn: ${status}`,
        () =>
          learn(
            {
              conversation: params.conversation,
              annotated_path: params.annotated_path,
              review_path: params.review_path,
              ...(params.report_markdown == null ? {} : { report_markdown: params.report_markdown }),
            },
            {
              step: ompSessionStep(pi.exec as never, { timeoutMs: APPLY_TIMEOUT_MS, label: "applier session" }),
              exec: pi.exec as never,
              log: (line) => {
                status = line.slice(0, 160);
              },
              signal,
            },
          ),
      );
      const commits = result.commits.map((commit) => `${commit.sha} in ${commit.repo}`);
      const text = [
        `${result.conversation}: ${result.commits.length} commit(s) verified, ${result.unverified_shas.length} sha(s) unverified`,
        ...(commits.length === 0 ? [] : [`commits: ${commits.join("; ")}`]),
        ...(result.unverified_shas.length === 0 ? [] : [`unverified: ${result.unverified_shas.join(", ")}`]),
        "",
        result.answer_markdown,
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  };
};

export default factory;
