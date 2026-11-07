import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { osMachine } from "./machine.js";
import { HEARTBEAT_MS, ompModelStep } from "./omp_model.js";
import { runProposeCapabilities } from "./propose.js";

const DESCRIPTION = [
  "Read conversations, files and folders and propose, per source, the distinct useful leaf capabilities it shows: each with an irreducible `name`, `purpose`, `reason`, input and output fields, `kind` (`deterministic|model|host`), cited `evidence` and, in phase 2, `pseudocode`.",
  "Use it to find what is worth making a tool; it proposes only. Take a kept leaf's name and pseudocode to author a new omp custom tool (creating-new-tools skill); use `identify_goals` for goals and `get_recent_turns` to read a conversation.",
  'Input: `{"sources":["claude:<id>","~/Developer/zq","notes.md"],"namespace":"webmaster","phase":1,"samples":3,"min_agreement":2,"registered":["webmaster.site.dns"]}`.',
  "A source is `<harness>:<id>` (omp, pi, claude, grok, codex, cursor, copilot, agentmux, hermes, opencode; full id, prefix or `latest`), a file, or a folder (`~/` or relative to omp's directory).",
  "`phase` 1 stops after the list; default 2 adds pseudocode. `samples` (1-5, default 3) proposals per source; a concept is kept when `min_agreement` (default 2) samples proposed it.",
  "With `namespace`, every name starts with it and a dot, and `registered` names are never re-proposed; omitted, the installed omp tools named `<namespace>_...` under ~/.omp/agent/tools count, spelled `namespace.…`.",
  "MUST give at least one source. A bad input, an unreadable source or a model reply still invalid after 3 asks fails the whole call; nothing partial is returned.",
  "A folder walk skips hidden entries, dependencies and build output.",
  "Returns `{runs:[{source,kind,samples,capabilities,merged,rejected,usage}],registered,totals}`; `rejected` carries each objection.",
  "Cost: about samples+2 `omp -p` model processes per source (up to 8 at once, minutes). Reads only: no writes, no network of its own. The model states its judgements, not calibrated probabilities.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "propose_capabilities",
    label: "Propose capabilities",
    description: DESCRIPTION,
    parameters: z.object({
      sources: z
        .array(z.string())
        .describe("One or more sources: `<harness>:<id|prefix|latest>`, a file path or a folder path (`~/` or relative to omp's directory). At least one."),
      namespace: z
        .string()
        .nullable()
        .optional()
        .describe('One lower-case word such as "webmaster": every proposed name starts with it and a dot. Omit for no namespace.'),
      phase: z
        .number()
        .int()
        .min(1)
        .max(2)
        .nullable()
        .optional()
        .describe("1 lists the capabilities; 2 (default) also writes pseudocode for each."),
      samples: z
        .number()
        .int()
        .min(1)
        .max(5)
        .nullable()
        .optional()
        .describe("Independent proposals per source, 1-5 (default 3)."),
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
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      let latest = "starting";
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `propose_capabilities is working (${Math.round((Date.now() - began) / 1000)} s): ${latest}` }],
          details: { status: "running" },
        });
      }, HEARTBEAT_MS);
      try {
        const output = await runProposeCapabilities(
          {
            sources: params.sources,
            namespace: params.namespace ?? undefined,
            phase: (params.phase ?? undefined) as 1 | 2 | undefined,
            samples: params.samples ?? undefined,
            min_agreement: params.min_agreement ?? undefined,
            registered: params.registered ?? undefined,
          },
          {
            step: ompModelStep(pi.exec),
            machine: osMachine(pi.cwd),
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
