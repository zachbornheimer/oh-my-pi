import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { appendToFile, DEFAULTS, liveDrainPort, nightlyLog, selfImprovementTick, settingsOf, type TickOutput } from "./loop.js";
import type { Exec } from "./omp_delegate.js";

const HEARTBEAT_MS = 15_000;

const description =
  "Work the atask objectives the learning loops filed: claim the oldest ready objective on each board, run one worker per claim in that objective's own worktree, and land only what `atask verify complete` accepts. "
  + "Use to drain the objective backlog; to start one known objective use start_atask_task, and to file new objectives use optimize_tooling or recursive_self_improvement. "
  + `Input \`{"projects":["AI Tooling"],"per_project":1,"concurrency":2,"on_complete":"merge","timeout_s":3600,"dry_run":false}\`; every field is optional. `
  + `projects defaults to ${JSON.stringify(DEFAULTS.projects)}; per_project and concurrency are integers 1-8 (defaults 1 and 2); on_complete is merge, pr-auto, pr or nil (default merge: lands verified work with wt merge); `
  + "timeout_s (default 3600) MUST outlive the worker because that wait renews the claim lease and lands the work. "
  + "dry_run returns the planned claims and starts nothing. "
  + "Each claim runs the native start_atask_task tool through one full omp session that is told to call it once and print its JSON answer; that tool MUST exist, otherwise the claim is answered `refused` with the reason. "
  + "A claim that throws never ends the tick. Side effects: spawns omp sessions that edit repositories and merge or open pull requests, and appends one tick line plus one line per claim to ~/.local/share/capability-replicas/nightly.log (not on dry_run). "
  + "Result: status drained, planned or idle, claims [{project, answer}] and the heartbeat text. Not resumable and not scheduled: the 04:00 cron of the Mastra twin is not rebuilt.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const exec = pi.exec as unknown as Exec;
  return {
    name: "self_improvement",
    label: "Self Improvement",
    description,
    parameters: z.object({
      projects: z.array(z.string()).nullable().optional().describe(`atask projects to claim from, one claim each per round. Default ${JSON.stringify(DEFAULTS.projects)}`),
      per_project: z.number().int().min(1).max(8).nullable().optional().describe("Claims per project in one tick, 1-8. Default 1"),
      concurrency: z.number().int().min(1).max(8).nullable().optional().describe("Claims running at once, 1-8. Default 2"),
      on_complete: z.enum(["merge", "pr-auto", "pr", "nil"]).nullable().optional().describe("Landing once atask verifies complete: merge, pr-auto (auto-merge armed), pr, or nil (leave the branch). Default merge"),
      timeout_s: z.number().int().positive().nullable().optional().describe("Seconds one claim is waited on; must outlive the worker. Default 3600"),
      dry_run: z.boolean().nullable().optional().describe("List the planned claims and start nothing. Default false"),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const settings = settingsOf({
        projects: params.projects ?? undefined,
        per_project: params.per_project ?? undefined,
        concurrency: params.concurrency ?? undefined,
        on_complete: params.on_complete ?? undefined,
        timeout_s: params.timeout_s ?? undefined,
        dry_run: params.dry_run ?? undefined,
      });
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `self_improvement: working claims (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase: "claims" },
        });
      }, HEARTBEAT_MS);
      try {
        const out: TickOutput = await selfImprovementTick(settings, {
          port: liveDrainPort(exec),
          append: appendToFile,
          now: () => new Date(),
          logPath: nightlyLog(),
          signal,
        });
        return { content: [{ type: "text", text: out.heartbeat }], details: out };
      } finally {
        clearInterval(beat);
      }
    },
  };
};

export default factory;
