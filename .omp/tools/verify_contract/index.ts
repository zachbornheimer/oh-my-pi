import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { normalizeInput, verifyContract } from "./verify.js";

const DESCRIPTION = [
  "Decide whether a declared contract is satisfied by deterministic evidence you already hold, with one verdict per criterion.",
  "Use it after running the checks yourself (tests, linters, diffs); it runs nothing and calls no model, and `execution_completed` is read and ignored because a claim that work finished is not evidence. Use `classify_failure` for the next action once a criterion is not satisfied, and `assess_change_quality` for review-triage signals about a change.",
  'Call `{"contract":"login","criteria":[{"id":"tests","min_strength":"strong"}],"evidence":[{"criterion":"tests","source":"bun test","result":"pass","strength":"strong"}]}`.',
  "`result` is `pass`, `fail` (requires `detail`) or `verifier_error` (the check itself broke; says nothing about the work). `strength` is `weak` or `strong` (empty means strong); a criterion with `min_strength` `strong` refuses weak passes. `passes_on_known_bad_basis` true marks a pass that would also pass on a known-bad basis, which cannot count.",
  "Refused with `verify_contract: ...`: no criteria, an empty or duplicate criterion id, evidence naming an undeclared criterion, an unknown strength or result, failing evidence without detail.",
  "Returns `{status, criteria:[{criterion, status, reason?, sources?, details?}]}`. Status is `satisfied`, `failed`, `verifier_failure` or `indeterminate` (reason `missing_evidence`, `contradictory_evidence`, `insufficient_strength` or `non_discriminating`); the contract status is failed, else verifier_failure, else indeterminate, else satisfied. Writes nothing.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const text = (description: string) => z.string().nullable().optional().describe(description);
  return {
    name: "verify_contract",
    label: "Verify contract",
    description: DESCRIPTION,
    parameters: z.object({
      contract: text("Name or text of the contract being verified; quoted in errors."),
      criteria: z
        .array(
          z.object({
            id: text("Criterion id: non-empty and unique; evidence refers to it."),
            description: text("What the criterion requires."),
            min_strength: text("`strong` refuses weak passes; empty or `weak` accepts any strength."),
          }),
        )
        .nullable()
        .optional()
        .describe("The contract's criteria; at least one is required."),
      evidence: z
        .array(
          z.object({
            criterion: text("Id of the declared criterion this observation is evidence for."),
            source: text("Where the observation came from, e.g. the check that ran."),
            result: text("`pass`, `fail` (needs detail) or `verifier_error`."),
            strength: text("`weak` or `strong`; empty means strong."),
            detail: text("Explanation of the result; required when result is `fail`."),
            passes_on_known_bad_basis: z
              .boolean()
              .nullable()
              .optional()
              .describe("True when the check also passed against a basis known to be wrong. Default false."),
          }),
        )
        .nullable()
        .optional()
        .describe("Deterministic observations; each must name a declared criterion. Omit for none."),
      execution_completed: z
        .boolean()
        .nullable()
        .optional()
        .describe("What the executor claimed; read and ignored, never evidence. Default false."),
    }),

    async execute(_toolCallId, params) {
      const output = verifyContract(normalizeInput(params));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
