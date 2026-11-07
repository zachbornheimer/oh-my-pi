import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { REVIEW_TIMEOUT_MS, runReview } from "./review.js";

const DESCRIPTION = [
  "Review one unified diff with a model and return its security findings only: injection into a shell, query or template, missing authorization on a new route, a secret reaching source, logs or a prompt, trusted user-controlled paths, unsafe deserialization, new network egress, riskier dependency changes, resource exhaustion.",
  "Use it on a worktree or branch diff before landing; use `review_code` for the correctness half and `review_pr` to review a GitHub pull request and post the findings on it.",
  'Call `{"diff":"<what git diff prints>","focus":"<ticket title and acceptance lines>"}`. `diff` is required and non-blank; `focus` is optional context for what the change is for.',
  "One model run (`omp -p`, no tools, up to 450 s per try) reads the diff as data. A reply that is not the expected JSON is asked again with the reason, 3 tries, then the call fails `no valid reply after 3 attempts: <reason>`.",
  "Findings are the model's judgment of the diff text alone: it sees no repository, runs no scanner, and exposure in code the diff does not touch is out of scope, so a clean result is not a security clearance.",
  "Costs model quota, sends the diff to the configured model provider, writes nothing.",
  'Returns `{"findings":[{"severity":"blocking|suggestion|nit","path","line"?,"description","fix"?}]}`, empty when the diff adds no exposure; only `blocking` should stop a landing.',
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "review_code_security",
    label: "Review code security",
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
      const output = await withHeartbeat(onUpdate, "review_code_security is working", () =>
        runReview(params, { step: ompModelStep(pi.exec, { timeoutMs: REVIEW_TIMEOUT_MS }), signal }));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
