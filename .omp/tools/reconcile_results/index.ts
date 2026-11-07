import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { reconcileResults } from "./reconcile.js";

const DESCRIPTION = [
  "Fold verified result decisions into proposed changes to a project's obligations. Only verified evidence satisfies an obligation; an executor's own completion claim (`execution_completed`) is accepted and ignored. It proposes and never persists: the caller's `state` is read from the call, nothing is written to disk or Linear. Pure; no model is called.",
  'Call `{"state":{"project_id":"p1","obligations":[{"id":"a","text":"a","kind":"request","status":"open"}]},"results":[{"obligation_id":"a","status":"satisfied","evidence":"go test ok"}]}`.',
  "`status` is satisfied, failed, verifier_failure or indeterminate. `satisfied` closes an open or blocked obligation (`satisfy` change). `verifier_failure` blocks it on `verifier_failure: <evidence>`. `failed` and `indeterminate` leave it unresolved. `failure.class` (from classify_failure) MUST be implementation, environment or evidence respectively and MUST be absent for satisfied.",
  "Refused, nothing returned: empty `project_id`; empty `results`; a decision with no `obligation_id` or no evidence; an unknown status; contradictory repeats for one obligation (identical repeats collapse); an unknown obligation id; reopening a satisfied obligation, or satisfying it again with different evidence. Every bad decision is listed, joined by newlines. A satisfied obligation replayed with the same evidence is `unchanged`.",
  "Returns `{project_id, results:[{obligation_id, verification, disposition: satisfied|blocked|unresolved|unchanged, change?, next_action?, reason}], changes?, unaffected? (live obligations with no result), projected (the state with the changes applied)}`; empty fields are omitted and results are ordered by obligation id.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const text = (description: string) => z.string().nullable().optional().describe(description);
  const strings = (description: string) => z.array(z.string()).nullable().optional().describe(description);
  const origin = z
    .object({ kind: text("What kind of source produced this entry."), ref: text("Reference within that kind.") })
    .nullable()
    .optional();
  const obligation = z.object({
    id: text("Obligation id; a result's obligation_id must match one of these."),
    text: text("Obligation text."),
    kind: text("Obligation kind, an open string."),
    status: text("Obligation status; only `open` and `blocked` are live and can take a result."),
    origin: origin.describe("Where the obligation came from."),
    evidence: text("Evidence recorded when the obligation was satisfied."),
    blocked_on: text("What the obligation is blocked on."),
    supersedes: text("Id of the obligation this one supersedes."),
    superseded_by: text("Id of the obligation that supersedes this one."),
    goal_ids: strings("Ids of the goals this obligation serves."),
  });
  const decision = z.object({
    name: text("Name of the decision."),
    choice: text("The choice made."),
    origin: origin.describe("Where the decision came from."),
  });
  const fact = z.object({
    name: text("Name of the fact."),
    value: text("Value of the fact."),
    origin: origin.describe("Where the fact came from."),
  });
  const result = z.object({
    obligation_id: text("Id of the obligation this verified result is about; must exist in state."),
    status: text("Verification status: satisfied, failed, verifier_failure or indeterminate. Only satisfied closes the obligation."),
    evidence: text("Verified evidence for the status. Required; an executor claim is not evidence."),
    execution_completed: z.boolean().nullable().optional().describe("The executor's completion claim; accepted and ignored. Omitted means false."),
    failure: z
      .object({
        class: text("implementation for failed, environment for verifier_failure, evidence for indeterminate."),
        next_action: text("Recommended next action; carried into the result's next_action."),
        signature: text("Failure signature from classify_failure."),
        rationale: strings("Reasons classify_failure gave for the class."),
      })
      .nullable()
      .optional()
      .describe("Optional classify_failure output; MUST be absent when status is satisfied."),
  });
  return {
    name: "reconcile_results",
    label: "Reconcile results",
    description: DESCRIPTION,
    parameters: z.object({
      state: z
        .object({
          project_id: text("Project id; MUST be non-empty."),
          name: text("Project name."),
          intent: text("Project intent."),
          obligations: z.array(obligation).nullable().optional().describe("Obligations the results are folded into."),
          decisions: z.array(decision).nullable().optional().describe("Decisions recorded for the project."),
          facts: z.array(fact).nullable().optional().describe("Facts recorded for the project."),
          skills: strings("Names of skills recorded for the project."),
          runs: strings("Ids of runs recorded for the project."),
          rev: z.number().int().nullable().optional().describe("State revision. Omitted means 0."),
        })
        .describe("Current project state, supplied by the caller; never read from disk."),
      results: z.array(result).describe("Verified result decisions, at least one."),
    }),

    async execute(_toolCallId, params) {
      const output = reconcileResults(params);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
