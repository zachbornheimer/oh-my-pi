import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { compileContext } from "./compile.js";
import { readInput } from "./schemas.js";

const DESCRIPTION = [
  "Select a bounded context bundle from durable project state and candidate evidence you already hold: required items first (project, intent, work item, live obligations the work names plus every live `constraint`), then evidence ranked by relevance while the budget allows. Use `recall` to rank past asks against a task; use this when you hold the state and the evidence and need a budgeted bundle.",
  'Input `{"state":{"project_id":"p1","name":"Proj","intent":"ship it","rev":7,"obligations":[{"id":"o1","text":"do it","kind":"request","status":"open"}]},"work":{"id":"w1","text":"build it","obligation_ids":["o1"]},"evidence":[{"source":"file","ref":"a.go","text":"...","relevance":0.9}],"budget":{"max_items":10}}`.',
  "Every field may be omitted or null (read as empty/zero), but the run refuses an empty `state.project_id` or `work.text`, a negative or all-zero budget (0 = unlimited, set at least one of max_items, max_chars, max_tokens), evidence without `source` and `ref` or with negative relevance, an unknown id in `work.obligation_ids`, and required items that alone exceed the budget.",
  "Evidence whose source starts with `transcript` or `session_history`, with blank text, or duplicating an earlier source+ref is omitted with a reason; transcripts are never a source. Sizes count runes; tokens are ceil(chars/4).",
  "Returns JSON `{project_id, rev, items[{kind,id,text,required?,relevance?,provenance{source,ref}}], omitted[{kind,id,reason,provenance}], chars, estimated_tokens, basis, budget}`; `basis` is `estimate:runes/4;deterministic;no-transcript;no-model`.",
  "Deterministic and pure: no model, no network, no filesystem, no fetching of anything it was not given; agentmux's in-process cache is not ported.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const text = (describe: string) => z.string().nullable().optional().describe(describe);
  const strings = (describe: string) => z.array(z.string()).nullable().optional().describe(describe);
  const origin = z.object({ kind: text("What kind of source produced this entry."), ref: text("Reference within that kind.") });
  return {
    name: "compile_context",
    label: "Compile context",
    description: DESCRIPTION,
    parameters: z.object({
      state: z
        .object({
          project_id: text("Project id; must be non-empty. Cited in provenance as `<project_id>@rev<rev>`."),
          name: text("Project name for the project item; the project_id is used when blank."),
          intent: text("Project intent; included as a required item when not blank."),
          obligations: z
            .array(
              z.object({
                id: text("Obligation id; work.obligation_ids refers to obligations by this id."),
                text: text("Obligation text, copied into the bundle when selected."),
                kind: text("Obligation kind; a live obligation of kind `constraint` is always included."),
                status: text("Only `open` and `blocked` obligations are live and considered."),
                origin: origin.nullable().optional().describe("Where the obligation came from."),
                evidence: text("Evidence recorded for the obligation."),
                blocked_on: text("What the obligation is blocked on."),
                supersedes: text("Id of the obligation this one supersedes."),
                superseded_by: text("Id of the obligation that supersedes this one."),
                goal_ids: strings("Ids of the goals this obligation serves."),
              }),
            )
            .nullable()
            .optional()
            .describe("Project obligations; live ones are selected by the work item."),
          decisions: z
            .array(z.object({ name: text("Decision name."), choice: text("The choice made."), origin: origin.nullable().optional() }))
            .nullable()
            .optional()
            .describe("Decisions recorded for the project (accepted, not selected into the bundle)."),
          facts: z
            .array(z.object({ name: text("Fact name."), value: text("Fact value."), origin: origin.nullable().optional() }))
            .nullable()
            .optional()
            .describe("Facts recorded for the project (accepted, not selected into the bundle)."),
          skills: strings("Names of skills recorded for the project."),
          runs: strings("Ids of runs recorded for the project."),
          rev: z.number().int().nullable().optional().describe("State revision, cited in provenance; default 0."),
        })
        .nullable()
        .optional()
        .describe("Durable project state, read by the caller from its store; project_id must be non-empty."),
      work: z
        .object({
          id: text("Work item id, used as the item id and provenance ref; `work` when empty."),
          text: text("Work item text; must be non-empty."),
          obligation_ids: strings("Ids of the obligations the work needs, each present in state.obligations; empty means every live obligation."),
        })
        .nullable()
        .optional()
        .describe("The work item the bundle is compiled for; its text must be non-empty."),
      evidence: z
        .array(
          z.object({
            id: text("Evidence id; `evidence[<index>]` when empty."),
            source: text("Where the evidence came from; required. Sources starting with `transcript` or `session_history` are excluded."),
            ref: text("Reference within the source; required. Duplicate source+ref pairs are dropped."),
            text: text("Evidence text; blank text is dropped."),
            relevance: z.number().nullable().optional().describe("Ranking score, highest first; must not be negative; default 0."),
            required: z.boolean().nullable().optional().describe("Include regardless of ranking; default false."),
          }),
        )
        .nullable()
        .optional()
        .describe("Candidate evidence to rank and add while the budget holds."),
      budget: z
        .object({
          max_items: z.number().int().nullable().optional().describe("Maximum items in the bundle; 0 or omitted means unlimited."),
          max_chars: z.number().int().nullable().optional().describe("Maximum total characters (runes) of item text; 0 or omitted means unlimited."),
          max_tokens: z.number().int().nullable().optional().describe("Maximum estimated tokens (ceil(chars/4)); 0 or omitted means unlimited."),
        })
        .nullable()
        .optional()
        .describe("Size limits; at least one dimension must be set and none may be negative."),
    }),

    async execute(_toolCallId, params) {
      const result = compileContext(readInput(params));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
};

export default factory;
