import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { classificationText, classifyFailure } from "./classify.js";

const DESCRIPTION =
  "Classify one non-satisfied verification outcome and name the cheapest next action that is not a repeat of an attempt that added no information. "
  + "Use after a verification or check fails and you must choose between retrying, rerunning, repairing the environment, strengthening the check, asking for context, escalating, or a human; "
  + "it only advises: it never retries, runs, or edits anything, and it does not read logs (collect_failure_evidence gathers source evidence, fix_red_ci attempts a CI fix). "
  + "Input `{\"outcome\":{\"status\":\"failed\",\"criteria\":[{\"criterion\":\"tests\",\"status\":\"failed\",\"reason\":\"2 failing\"}]},\"history\":[{\"signature\":\"066c268f4729d56f\",\"action\":\"retry_with_failure_evidence\"}],\"environment_fixed\":false}`. "
  + "Statuses are satisfied, failed, verifier_failure, indeterminate; outcome.status `satisfied` or any unknown status is an error. "
  + "Class: failed is implementation, verifier_failure is environment, indeterminate is evidence. "
  + "Ladders, cheapest first: implementation retry_with_failure_evidence, escalate, request_human; environment rerun_verification, repair_environment, request_human (environment_fixed true drops the rerun); "
  + "evidence strengthen_verification, request_human (an indeterminate criterion with reason `missing_evidence` puts request_context first). "
  + "The action is the first ladder entry with no history entry of the same signature and action; request_human once the ladder is spent. "
  + "Returns class, next_action, signature (8 bytes of sha256 over the sorted unresolved criteria, hex) and rationale; record {signature, action: next_action} as the next history entry. Deterministic, no network, no model.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const criterion = z.object({
    criterion: z.string().optional().describe("Name of the verification criterion; omitted means empty."),
    status: z.string().optional().describe("Criterion status: satisfied, failed, verifier_failure or indeterminate. Satisfied criteria are left out of the signature."),
    reason: z.string().optional().describe("Why the criterion has this status; `missing_evidence` on an indeterminate criterion routes to request_context."),
  });
  const attempt = z.object({
    signature: z.string().optional().describe("Signature returned by an earlier classification."),
    action: z.string().optional().describe("The next_action already tried against that signature."),
  });
  return {
    name: "classify_failure",
    label: "Classify Failure",
    description: DESCRIPTION,
    parameters: z.object({
      outcome: z.object({
        status: z.string().describe("Overall status: failed, verifier_failure or indeterminate. `satisfied` and unknown values are an error."),
        criteria: z.array(criterion).nullable().optional().describe("Per-criterion verdicts; the unsatisfied ones are hashed into the signature. Default: none."),
      }).describe("The non-satisfied verification outcome to classify."),
      history: z.array(attempt).nullable().optional().describe("Earlier attempts; an action already tried against the identical signature is skipped. Default: none."),
      environment_fixed: z.boolean().nullable().optional().describe("True when an environment failure stays until repaired, so rerun_verification is never recommended. Default false."),
    }),

    async execute(_toolCallId, params) {
      const result = classifyFailure(params);
      return { content: [{ type: "text", text: classificationText(result) }], details: result };
    },
  };
};

export default factory;
