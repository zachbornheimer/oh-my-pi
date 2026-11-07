import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { REVIEW_TIMEOUT_MS, runReview } from "./review.js";

const DESCRIPTION = [
  "Review one unified diff with a model and return its correctness and quality findings: behavior the change breaks or leaves untested, a contract it drops, names that misstate a guarantee, dead code, swallowed errors.",
  "Use it on a worktree or branch diff before landing; use `review_code_security` for the security half and `review_pr` to review a GitHub pull request and post the findings on it.",
  'Call `{"diff":"<what git diff prints>","focus":"<ticket title and acceptance lines>"}`. `diff` is required and non-blank; `focus` is optional context for what the change is for.',
  "One model run (`omp -p`, no tools, up to 450 s per try) reads the diff as data. A reply that is not the expected JSON is asked again with the reason, 3 tries, then the call fails `no valid reply after 3 attempts: <reason>`.",
  "Findings are the model's judgment of the diff text alone: it sees no repository and runs no tests, so a clean result is not proof of correctness.",
  "Costs model quota, sends the diff to the configured model provider, writes nothing.",
  'Returns `{"findings":[{"severity":"blocking|suggestion|nit","path","line"?,"description","fix"?}]}`, empty when the diff is clean; only `blocking` should stop a landing.',
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "review_code",
    label: "Review code",
    description: DESCRIPTION,
    parameters: z.object({
      diff: z.string().describe("The unified diff to review, as `git diff` prints it. Required, non-blank."),
      focus: z
        .string()
        .nullable()
        .optional()
        .describe("What this change is for: the ticket title and its acceptance lines. Omit when unknown."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const output = await withHeartbeat(onUpdate, "review_code is working", () =>
        runReview(params, { step: ompModelStep(pi.exec, { timeoutMs: REVIEW_TIMEOUT_MS }), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
