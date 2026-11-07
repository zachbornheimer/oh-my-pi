import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { assessChangeQuality, normalizeInput } from "./assess.js";

const DESCRIPTION = [
  "Report deterministic quality signals about a change you describe: growth in lines, public names, configuration keys or import edges past a threshold; fewer assertions or added skip markers in test files; widened timeouts; old and new paths that coexist; repeated consumer motifs; facade bypasses.",
  "Use it to decide where a reviewer should look; use `verify_contract` to judge criteria against evidence and `review_code` to have a model read a diff. It measures nothing itself: you supply the before/after counts, so a finding is only as true as your numbers.",
  'Call `{"purpose":"Add retry","files":[{"path":"a_test.ts","test":true,"assertions":{"before":3,"after":1},"hunks":"@@ ..."}],"duplicate_paths":[{"old":"a.ts","new":"b.ts"}],"consumers":[{"consumer":"x","motif":"m","bypassed_facade":true}],"thresholds":{"lines":150}}`. Every field is optional; a zero or negative threshold selects its default (lines 150, public names 5, config keys 3, import edges 3, consumer motifs 3).',
  "Growth at the threshold is a `note`, at twice it a `review`; a marker rule (assertions fell, skip added, timeout widened, duplicate path, facade bypass) is always `review`.",
  "Returns `{files_examined, findings:[{kind, triage, scope, consumers?, evidence, deeper_review}], deeper_review, review?, basis}`. `review` is present only when a finding has `deeper_review`: a question for a reviewer with those findings and each file's hunk (cut at 4000 bytes), always `status: \"unresolved\"` because nothing here answers it. No score, no verdict.",
  "Runs nothing, calls no model, writes nothing.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const text = (description: string) => z.string().nullable().optional().describe(description);
  const flag = (description: string) => z.boolean().nullable().optional().describe(description);
  const whole = (description: string) => z.number().int().nullable().optional().describe(description);
  const measure = (description: string) =>
    z
      .object({
        before: whole("Count before the change; default 0."),
        after: whole("Count after the change; default 0."),
      })
      .nullable()
      .optional()
      .describe(description);
  return {
    name: "assess_change_quality",
    label: "Assess change quality",
    description: DESCRIPTION,
    parameters: z.object({
      purpose: text("The goal statement or commit message the change serves; carried into the review request."),
      files: z
        .array(
          z.object({
            path: text("Path of the changed file; scopes the findings raised for it."),
            test: flag("Whether this is a test file; assertion and skip-marker findings apply only to test files. Default false."),
            lines: measure("Line count before and after; growth at or above thresholds.lines raises file_growth."),
            public_names: measure("Public name count before and after; raises public_vocabulary_growth."),
            config_keys: measure("Configuration key count before and after; raises configuration_growth."),
            import_edges: measure("Import edge count before and after; raises import_edge_growth."),
            assertions: measure("Assertion count before and after; test files only; a fall raises assertion_reduction."),
            skip_markers: measure("Skip marker count before and after; test files only; a rise raises skipped_test_added."),
            timeout_changes: z
              .array(
                z.object({
                  name: text("Name of the timeout setting that changed."),
                  from_seconds: z.number().nullable().optional().describe("Seconds before the change; default 0."),
                  to_seconds: z
                    .number()
                    .nullable()
                    .optional()
                    .describe("Seconds after; above from_seconds raises timeout_widened. Default 0."),
                }),
              )
              .nullable()
              .optional()
              .describe("Timeouts changed in this file."),
            hunks: text("The file's diff hunk text, shown beside any flagged finding for this file; cut at 4000 bytes."),
          }),
        )
        .nullable()
        .optional()
        .describe("Changed files with before/after measures, examined in input order."),
      duplicate_paths: z
        .array(
          z.object({
            old: text("The old path that still coexists with the new one."),
            new: text("The new path; the finding's scope."),
          }),
        )
        .nullable()
        .optional()
        .describe("Old/new path pairs you marked as coexisting; each raises a duplicate_path review."),
      consumers: z
        .array(
          z.object({
            consumer: text("Name of the consumer observed."),
            motif: text("Usage pattern the consumer repeats; a non-blank motif from enough distinct consumers raises a finding."),
            intended_facade: text("The facade the consumer was meant to use; named in a facade_bypass finding."),
            bypassed_facade: flag("Whether the consumer bypassed its intended facade, which raises a facade_bypass review. Default false."),
          }),
        )
        .nullable()
        .optional()
        .describe("Observed consumers of the changed code."),
      thresholds: z
        .object({
          lines: whole("Line growth that raises file_growth; zero or less selects 150."),
          public_names: whole("Public name growth; zero or less selects 5."),
          config_keys: whole("Configuration key growth; zero or less selects 3."),
          import_edges: whole("Import edge growth; zero or less selects 3."),
          consumer_motifs: whole("Distinct consumers repeating a motif; zero or less selects 3."),
        })
        .nullable()
        .optional()
        .describe("Growth sizes at which signals are reported: a note at the size, a review at twice it."),
    }),

    async execute(_toolCallId, params) {
      const output = assessChangeQuality(normalizeInput(params));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
