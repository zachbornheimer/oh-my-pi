import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { Exec } from "./omp_delegate.js";
import { DEFAULTS, livePorts, recursiveSelfImprovement, type RsiOutput, settingsOf } from "./run.js";

const HEARTBEAT_MS = 15_000;

const description =
  "Learn from this machine's worst recent agent transcripts and file the findings: pick up to max_transcripts unlearned omp sessions by model triage (or take the given sources), run learn_from_transcript on each (5 at a time, 45 minutes each), and record each learned session so it is never reviewed twice. "
  + "Use for the nightly self-improvement pass; to learn from one transcript use learn_from_transcript, to work the filed backlog use optimize_tooling or self_improvement. "
  + `Input \`{"sources":["omp:<session-id>"],"hours":72,"max_transcripts":5,"force":false,"run_optimize_tooling":false,"apply":true,"optimize_limit":4}\`; every field is optional. `
  + "sources, when given, replaces the triage; ids already learned are dropped unless force is true. Without sources the triage reads only local ~/.omp/agent/sessions written in the last hours (default 72); the Mastra twin's Neon source is not rebuilt. "
  + "run_optimize_tooling (default false) then runs optimize_tooling with apply and optimize_limit. "
  + "A machine-wide lock keeps one run at a time; a second answers status busy and does nothing. "
  + "learn_from_transcript and optimize_tooling MUST exist as native tools: each is run through a full omp session told to call it once, and a session whose learn run fails is reported in its learning and not recorded. "
  + "Effects: spawns omp sessions and model calls (quota), files tickets through the learn tool, appends ~/.local/share/capability-replicas/learned.jsonl and nightly.log. "
  + "Result: status done or busy, learnings [{conversation, review_path, answer_markdown, commits, unverified_shas}] and the optimize summary. Not scheduled; await_result and the fleet offload are not rebuilt.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const exec = pi.exec as unknown as Exec;
  return {
    name: "recursive_self_improvement",
    label: "Recursive Self Improvement",
    description,
    parameters: z.object({
      sources: z.array(z.string()).nullable().optional().describe("Conversation ids such as omp:<id> to learn from instead of the triage. Default: triage picks"),
      hours: z.number().int().positive().nullable().optional().describe(`Triage looks back this many hours. Default ${DEFAULTS.hours}`),
      max_transcripts: z.number().int().positive().nullable().optional().describe(`Most sessions chosen by triage. Default ${DEFAULTS.max_transcripts}`),
      force: z.boolean().nullable().optional().describe("Learn from sources already in the ledger too. Default false"),
      run_optimize_tooling: z.boolean().nullable().optional().describe("Also run optimize_tooling afterwards. Default false"),
      apply: z.boolean().nullable().optional().describe("optimize_tooling apply flag (hand validated tickets to the relay). Default true"),
      optimize_limit: z.number().int().positive().nullable().optional().describe(`optimize_tooling ticket limit. Default ${DEFAULTS.optimize_limit}`),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const settings = settingsOf({
        sources: params.sources ?? undefined,
        hours: params.hours ?? undefined,
        max_transcripts: params.max_transcripts ?? undefined,
        force: params.force ?? undefined,
        run_optimize_tooling: params.run_optimize_tooling ?? undefined,
        apply: params.apply ?? undefined,
        optimize_limit: params.optimize_limit ?? undefined,
      });
      const began = Date.now();
      let phase = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `recursive_self_improvement: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase },
        });
      }, HEARTBEAT_MS);
      try {
        const out: RsiOutput = await recursiveSelfImprovement(
          settings,
          livePorts(exec, signal, (next) => {
            phase = next;
          }),
        );
        const text = out.status === "busy" ? out.optimize : out.learnings.map((l) => `${l.conversation}: ${l.answer_markdown}`).join("\n");
        return { content: [{ type: "text", text }], details: out };
      } finally {
        clearInterval(beat);
      }
    },
  };
};

export default factory;
