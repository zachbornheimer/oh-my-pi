import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runCreateWorkflow } from "./create_workflow.js";
import { osMachine } from "./machine.js";
import { HEARTBEAT_MS, ompModelStep } from "./omp_model.js";

export const DESCRIPTION = [
  "Plan new omp tools from conversations, files and folders: it proposes the distinct leaf capabilities in the sources (the whole `propose_capabilities` pipeline) and turns each kept leaf with pseudocode into a ready `implement_code` request. Use `propose_capabilities` alone when you only want the list.",
  "It builds and writes nothing, and it cannot call another tool: for each entry of `implement_requests`, call `implement_code` with its `request` (`{design,repo,hints?}`), then author the omp custom tool per the creating-new-tools skill.",
  'Input: `{"sources":["claude:<id>","~/Developer/zq","SKILL.md"],"repo":"~/Developer/zq","namespace":"webmaster","phase":2,"samples":3,"min_agreement":2,"registered":["webmaster.site.dns"],"max_leaves":5,"hints":{"near":"src/tools","language":"typescript"}}`.',
  "`sources`, `namespace`, `phase`, `samples`, `min_agreement` and `registered` are `propose_capabilities`'. `repo` defaults to omp's directory and MUST exist. `max_leaves` plans no more than that many leaves, in run order; the rest are listed in `unplanned`. `phase` 1 makes no requests, since a request needs pseudocode.",
  "A leaf proposed again by a later source is planned once, at the first source, and listed in `duplicates`.",
  "Any bad input, unreadable source or model reply still invalid after 3 asks fails the whole call.",
  "Returns `{proposal,duplicates,implement_requests:[{source,name,request}],unplanned:[{source,name,reason}],repo,totals}`.",
  "Cost: about samples+2 `omp -p` model processes per source (up to 8 at once, minutes). Reads only: no writes, no network of its own. The model states its judgements, not calibrated probabilities.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "create_workflow",
    label: "Create workflow",
    description: DESCRIPTION,
    parameters: z.object({
      sources: z
        .array(z.string())
        .describe("One or more sources: `<harness>:<id|prefix|latest>`, a file path or a folder path (`~/` or relative to omp's directory). At least one."),
      repo: z
        .string()
        .nullable()
        .optional()
        .describe("Repo the planned code would be built in: absolute, `~/...` or relative to omp's directory; must exist. Default omp's directory."),
      namespace: z
        .string()
        .nullable()
        .optional()
        .describe('One lower-case word such as "webmaster": every proposed name starts with it and a dot. Omit for no namespace.'),
      phase: z.number().int().min(1).max(2).nullable().optional().describe("1 lists the capabilities (no requests); 2 (default) also writes pseudocode and plans requests."),
      samples: z.number().int().min(1).max(5).nullable().optional().describe("Independent proposals per source, 1-5 (default 3)."),
      min_agreement: z
        .number()
        .int()
        .min(1)
        .max(5)
        .nullable()
        .optional()
        .describe("Fewest samples that must propose a concept for it to be kept (default 2; never more than `samples`)."),
      registered: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("Registered capability names to leave out, dotted such as `webmaster.site.dns`; used as given. Omit: installed omp tools under the namespace."),
      max_leaves: z.number().int().min(1).nullable().optional().describe("Plans no more than this many leaves, in run order; the rest are proposed but unplanned. Omit for all."),
      hints: z
        .object({
          near: z.string().nullable().optional().describe("Repo-relative path or directory the new code belongs near."),
          language: z.string().nullable().optional().describe("Language of the new code, when sibling files do not show it."),
        })
        .nullable()
        .optional()
        .describe("Passed through to every `implement_code` request."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      let latest = "starting";
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `create_workflow is working (${Math.round((Date.now() - began) / 1000)} s): ${latest}` }],
          details: { status: "running" },
        });
      }, HEARTBEAT_MS);
      try {
        const output = await runCreateWorkflow(
          {
            sources: params.sources,
            repo: params.repo ?? undefined,
            namespace: params.namespace ?? undefined,
            phase: (params.phase ?? undefined) as 1 | 2 | undefined,
            samples: params.samples ?? undefined,
            min_agreement: params.min_agreement ?? undefined,
            registered: params.registered ?? undefined,
            max_leaves: params.max_leaves ?? undefined,
            hints: params.hints ?? undefined,
          },
          {
            step: ompModelStep(pi.exec),
            machine: osMachine(pi.cwd),
            workingDirectory: pi.cwd,
            signal,
            onProgress: (message) => {
              latest = message;
            },
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
      } finally {
        clearInterval(beat);
      }
    },
  };
};

export default factory;
