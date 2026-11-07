import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { HEARTBEAT_MS, SEVERITIES, type Severity } from "./constants.js";
import { ghRunner, ghSecurityPort } from "./github_port.js";
import { securityLinearPort } from "./linear_port.js";
import { sleepFor } from "./sleep.js";
import { fileGhSecurityTickets } from "./run.js";
import type { Result } from "./schemas.js";

export const DESCRIPTION =
  "Reconcile open GitHub code-scanning and secret-scanning alerts into Linear tickets, tag-linked both ways. Use to file or refresh security tickets for an owner or one repository; Dependabot alerts are `upgrade_bot_prs` work and are never filed. "
  + "Input `{\"target\":\"zachbornheimer\",\"dryRun\":true,\"minSeverity\":\"high\"}`: `target` is `owner` (every non-archived repository, up to 1000) or `owner/repo`; `dryRun` (default false) reads GitHub and Linear and writes nothing; `minSeverity` is critical, high, medium or low (default low). "
  + "Each alert is tagged `ghsec:<owner>/<repo>#<source>-<number>` and filed, critical first, as one Linear ticket only when no ticket carries that tag; priority follows severity; the workspace is SAH for Software-Automation-Holdings-LLC and ZYS for every other owner. "
  + "A ticket whose alert GitHub no longer shows open (re-read first) moves to Done with a comment. A source GitHub will not list for a repository (403/404) is skipped with its message and that source's tickets are never settled. "
  + "Every write is read back; tickets that fail land in `failed` and the run continues. "
  + "Needs `gh` authenticated and a Linear API key in the omp environment: `LINEAR_API_KEY_SAH`, `LINEAR_API_KEY_ZYS` or `LINEAR_API_KEY`. "
  + "MUTATES Linear tickets (never GitHub); reruns create nothing. Sends progress updates. "
  + "Returns `{target,dryRun,workspace,repos,items,tickets:{created,existing,settled,failed,wouldCreate,wouldSettle},minSeverity}`; `would*` list the dry-run diff.";

export function summarize(result: Result): string {
  const { tickets } = result;
  const lines = [
    `${result.dryRun ? "dry run" : "run"} on ${result.target} (${result.workspace.team}): ${result.repos.visited.length} repositories, ${result.items.total} alerts at or above ${result.minSeverity}`,
    result.dryRun
      ? `would create ${tickets.wouldCreate.length}, would settle ${tickets.wouldSettle.length}, ${tickets.existing} already ticketed`
      : `created ${tickets.created.length}, settled ${tickets.settled.length}, ${tickets.existing} already ticketed, ${tickets.failed.length} failed`,
  ];
  for (const tag of tickets.wouldCreate) lines.push(`would create ${tag}`);
  for (const tag of tickets.wouldSettle) lines.push(`would settle ${tag}`);
  for (const entry of tickets.created) lines.push(`created ${entry.identifier} ${entry.tag}`);
  for (const entry of tickets.settled) lines.push(`settled ${entry.identifier} ${entry.tag} (${entry.githubState})`);
  for (const entry of tickets.failed) lines.push(`failed ${entry.tag}: ${entry.reason}`);
  for (const entry of result.repos.skipped) lines.push(`skipped ${entry.repo}: ${entry.reason}`);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => ({
  name: "file_gh_security_tickets",
  label: "File GH security tickets",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    target: pi.zod.string().min(1).describe("GitHub owner (`zachbornheimer`) or `owner/repo` (`Software-Automation-Holdings-LLC/auth`) whose alerts are filed."),
    dryRun: pi.zod.boolean().nullable().optional().describe("Read and reconcile, write nothing. Default false."),
    minSeverity: pi.zod.enum(SEVERITIES).nullable().optional().describe("Lowest severity filed: critical, high, medium or low. Default low."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `file_gh_security_tickets: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const ports = {
        gh: ghSecurityPort(ghRunner(pi.exec, { cwd: pi.cwd, signal })),
        linear: securityLinearPort({ signal }),
        sleep: (ms: number) => sleepFor(ms, signal),
        today: () => new Date().toISOString().slice(0, 10),
        throwIfCancelled: () => signal?.throwIfAborted(),
        progress: (message: string) => {
          phase = message;
        },
      };
      const result = await fileGhSecurityTickets(ports, {
        target: params.target,
        dryRun: params.dryRun ?? undefined,
        minSeverity: (params.minSeverity ?? undefined) as Severity | undefined,
      });
      return {
        content: [{ type: "text", text: summarize(result) }],
        details: { ...result, seconds: Math.round((Date.now() - began) / 1000) },
      };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
