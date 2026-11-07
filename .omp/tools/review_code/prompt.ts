/**
 * The review prompt for correctness and quality findings. The text is the `Findings` question of the Mastra
 * `review_code` capability (questions/review.yaml), copied here so the tool needs nothing outside this directory.
 */

export const INSTRUCTIONS = `Review the diff under review for correctness and quality findings, in the context of the focus when one is given. Report only findings a reader can ground in the diff itself: behavior the change breaks, a case it leaves untested that it changes behavior for, a contract it silently drops, ownership or naming that misstates what a value guarantees, dead code it adds, an error it swallows. For each finding give severity, path, the line in the new file when one line is the site, what is wrong, and the change that would resolve it.

severity: blocking when the change is wrong or unsafe to land as written and a fix must come before it lands; suggestion when a better shape exists but landing is acceptable; nit when it is a minor style preference.

Do not report findings about code the diff does not touch. Do not report security exposure; another review owns that. Do not invent files, symbols or line numbers that are not in the diff. When the diff is clean, findings is an empty array, never a missing field.`;

export const EXAMPLE_INPUT = `Add a CLI flag --fresh to re-run without the cache

The diff under review:

--- a/src/runtime/cli/capability.ts
+++ b/src/runtime/cli/capability.ts
@@ -10,3 +10,4 @@
 export function run(input: Input) {
+  input.fresh = true;
   return start(input);
 }`;

export const EXAMPLE_ANSWER = {
  findings: [
    {
      severity: "blocking",
      path: "src/runtime/cli/capability.ts",
      line: 11,
      description:
        "The flag is forced on for every run, not only when the caller passes --fresh, so no run can ever use the cache.",
      fix: "Set input.fresh only when the argv asks for it, and leave it unset otherwise.",
    },
    {
      severity: "nit",
      path: "src/runtime/cli/capability.ts",
      description: "The added line has no test near it; the CLI test file covers this path.",
    },
  ],
};
