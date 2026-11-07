/**
 * The review prompt for security findings. The text is the `Findings` question of the Mastra `review_code_security`
 * capability (questions/review.yaml), copied here so the tool needs nothing outside this directory.
 */

export const INSTRUCTIONS = `Review the diff under review for security findings only, in the context of the focus when one is given. Report only exposure the diff introduces or widens: injection into a shell, query or template, missing authorization on a new route or operation, a secret reaching source, logs, arguments or a prompt, trusting user-controlled paths or names past a boundary, unsafe deserialization, new network egress, a dependency change that widens install-time exposure, resource exhaustion open to an external caller. For each finding give severity, path, the line in the new file when one line is the site, what the exposure is and who can reach it, and the change that would close it.

severity: blocking when the exposure is real and reachable and must be closed before landing; suggestion when hardening is warranted but landing is acceptable; nit when it is a minor defense-in-depth preference.

Do not report theoretical exposure in code the diff does not touch. Do not report correctness or quality findings; another review owns those. Do not invent files, symbols, routes or line numbers that are not in the diff. When the diff has no exposure, findings is an empty array, never a missing field.`;

export const EXAMPLE_INPUT = `Read a user-provided report path and print it

The diff under review:

--- a/src/report/print.ts
+++ b/src/report/print.ts
@@ -5,2 +5,5 @@
+export function printReport(path: string) {
+  console.log(readFileSync(path, "utf8"));
+}`;

export const EXAMPLE_ANSWER = {
  findings: [
    {
      severity: "blocking",
      path: "src/report/print.ts",
      line: 7,
      description:
        "The path is user-controlled and read with no containment, so a caller can read any file the process can.",
      fix: "Resolve the path under the reports root and refuse anything that escapes it before reading.",
    },
  ],
};
