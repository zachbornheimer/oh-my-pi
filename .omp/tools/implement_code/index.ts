import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { implementCode } from "./implement.js";
import { ompModelStep, withHeartbeat } from "./omp.js";

const DESCRIPTION = [
  "Turn a design (a contract or pseudocode) into file changes placed and written like a repo's closest siblings. Use it to plan new code in a git checkout; use `edit` for known files and `write` for one-off files.",
  'Call `{"design":"a leaf trim_text that returns its input without surrounding blanks","repo":"~/work/app","hints":{"near":"src/leaf","language":"typescript"},"apply":false}`. `design` is words or `{name,purpose,input_summary,output_summary,pseudocode,replaces?}`. `repo` is `~/`, absolute or relative to the call directory; omitted means the git repo of the call directory. `hints.near` is a repo-relative path the code belongs near. `apply` is false by default.',
  "It reads the repo (git ls-files, git grep, AGENTS.md/CLAUDE.md/README conventions), then runs `omp -p` model steps (spends model quota): locate files, draft each, edit registries by insertion only, self-review, redraft files with findings of confidence 0.7 or more. Replies are validated in code and re-asked with the reason, up to 3 times.",
  "An empty design is refused; a path outside the repo, an overwrite, a registry edit that changes an existing line, or a review naming a file outside the change is rejected and retried, then fails. NEVER writes unless `apply` is true; apply refuses, writing nothing, if a file to create now exists or an edited file changed since read, then writes the files and runs the planned checks via `sh -c` in the repo. Never commits.",
  "Runs for minutes with progress updates. Returns `{repo, files[{path,action,role,reason,content,diff?,base_sha256?}], touchpoints, callers_to_update, checks, review:{findings,revised}, applied?:{written,checks[{passed,exit_code,output_tail}]}}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "implement_code",
    label: "Implement code",
    description: DESCRIPTION,
    parameters: z.object({
      design: z
        .union([
          z.string(),
          z.object({
            name: z.string().describe("The name of the leaf being designed."),
            purpose: z.string().describe("What the leaf is for."),
            input_summary: z.string().describe("A summary of the leaf's input."),
            output_summary: z.string().describe("A summary of the leaf's output."),
            pseudocode: z.string().describe("The steps of the leaf as pseudocode."),
            replaces: z.array(z.string()).nullable().optional().describe("Names the design replaces; files that still use them come back as callers_to_update."),
          }),
        ])
        .describe("What to build: design words, or an object with name, purpose, input and output summaries and pseudocode. Must not be empty."),
      repo: z
        .string()
        .nullable()
        .optional()
        .describe("The git checkout to build in: `~/path`, absolute, or relative to the call directory. Omitted means the git repo of the call directory."),
      hints: z
        .object({
          near: z.string().nullable().optional().describe("A repo-relative path or directory the new code belongs near."),
          language: z.string().nullable().optional().describe("The language of the new code, when the sibling files do not show it."),
        })
        .nullable()
        .optional()
        .describe("Where the code belongs and in what language. Omitted means inferred from the repo."),
      apply: z
        .boolean()
        .nullable()
        .optional()
        .describe("True writes the planned files and runs the planned checks after planning. Omitted or false only plans."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      let phase = "starting";
      const progress = (name: string) => {
        phase = name;
        onUpdate?.({ content: [{ type: "text", text: `implement_code: ${name}` }], details: { phase: name } });
      };
      const output = await withHeartbeat(onUpdate, () => `implement_code: ${phase}`, () =>
        implementCode(params, { exec: pi.exec, cwd: pi.cwd, model: ompModelStep(pi.exec), signal, onPhase: progress }),
      );
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
