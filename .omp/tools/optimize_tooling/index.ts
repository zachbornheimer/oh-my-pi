import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { appendToFile, DEFAULTS, liveLedger, liveLock, liveTicketPorts, nightlyLog, optimizeTooling, type OptimizeOutput, settingsOf } from "./run.js";
import type { Exec } from "./omp_delegate.js";

const HEARTBEAT_MS = 15_000;

const description =
  "Take the next Linear ticket(s) from a team's workable statuses through to done: prepare_ticket, find_superseding_tickets, validate_ticket, then the relay workflow. "
  + "Use to work the AI-tooling backlog unattended; to work one named ticket use relay or execute_ticket, to review a ticket without working it use apply:false. "
  + `Input \`{"linear_teams":["ZYS"],"linear_project":"AI Tooling","limit":1,"retry_after_hours":24,"apply":true}\`; every field is optional. `
  + "Tickets are ordered priority first then oldest; one a run took inside retry_after_hours is skipped; at most limit are worked, one at a time. "
  + "apply:false stops each ticket after validation. A ticket superseded by a later one is closed with its open pull requests. The chain stops at the first stage that says no and the answer names it; a step that throws fails only that ticket. "
  + "Holds a machine-wide lock (waits up to 10 minutes, else answers busy and logs the skip to ~/.local/share/capability-replicas/nightly.log); records each taken ticket in ~/Library/Caches/optimize-tooling/attempts.json before working it. "
  + "Every stage is a native omp tool run through a full omp session told to call it once: list_eligible_tickets, prepare_ticket, find_superseding_tickets, validate_ticket, settle_ticket_outcome, relay MUST exist: a missing list_eligible_tickets throws before any ticket is touched, any other missing stage answers that ticket `failed` naming it. "
  + "Effects: edits and closes Linear tickets, opens or closes pull requests, spends model quota. Result: status worked, empty or busy, eligible count, recently_taken and per-ticket runs. "
  + "Not rebuilt from the Mastra twin: the 03:00 and 15:00 schedule, fleet offload and await_result:false background dispatch.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const exec = pi.exec as unknown as Exec;
  return {
    name: "optimize_tooling",
    label: "Optimize Tooling",
    description,
    parameters: z.object({
      linear_teams: z.array(z.string()).nullable().optional().describe(`Linear team keys such as ZYS or SAH. Default ${JSON.stringify(DEFAULTS.linear_teams)}`),
      linear_project: z.string().nullable().optional().describe(`Linear project to read within each team; empty string reads the whole team. Default "${DEFAULTS.linear_project}"`),
      limit: z.number().int().positive().nullable().optional().describe("Tickets to take through the chain, one at a time. Default 1"),
      retry_after_hours: z.number().positive().nullable().optional().describe("Hours before a ticket this tool already took is taken again. Default 24"),
      apply: z.boolean().nullable().optional().describe("Hand each ticket that validates as current to the relay. false stops after validation. Default true"),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const settings = settingsOf({
        linear_teams: params.linear_teams ?? undefined,
        linear_project: params.linear_project ?? undefined,
        limit: params.limit ?? undefined,
        retry_after_hours: params.retry_after_hours ?? undefined,
        apply: params.apply ?? undefined,
      });
      const began = Date.now();
      let phase = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `optimize_tooling: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase },
        });
      }, HEARTBEAT_MS);
      try {
        const { ports, eligible } = liveTicketPorts(exec, signal);
        const out: OptimizeOutput = await optimizeTooling(settings, {
          eligible,
          ports,
          attempts: liveLedger(),
          lock: liveLock(),
          appendLine: appendToFile,
          logPath: nightlyLog(),
          now: Date.now,
          sleep: (ms) => {
            const { promise, resolve } = Promise.withResolvers<void>();
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
            return promise;
          },
          signal,
          onPhase: (next) => {
            phase = next;
          },
        });
        return { content: [{ type: "text", text: `${out.status}: ${out.next}` }], details: out };
      } finally {
        clearInterval(beat);
      }
    },
  };
};

export default factory;
