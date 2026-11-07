import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { HEARTBEAT_MS } from "./constants.js";
import { shellUpgradeBotHost } from "./host.js";
import { listOpenBotPrs } from "./list_open_bot_prs.js";
import type { TickResult } from "./schemas.js";
import { launchUpgradeDependencyPerRepo } from "./tick.js";

export const DESCRIPTION =
  "Run one upgrade-bot tick: list the open bot pull requests of the `gh` user and every org, then launch `upgrade_dependency` on them, a repository's pull requests one after another. Use on a timer (about every 4 hours) or by hand; to land one pull request call `upgrade_dependency`, `fix_red_ci` or `make_pr_mergable` directly. "
  + "Input `{\"dryRun\":true}` lists what would launch and launches, writes and locks nothing; omit `dryRun` (default false) to launch. "
  + "Bots: author type Bot, login ending `[bot]` or starting `app/`. Drafts, archived repositories and pull requests labeled `ai:dependencies-checked` are skipped; an owner whose search hits GitHub's 1000-result limit is skipped whole. "
  + "Rules: four lanes (`UPGRADE_BOT_PRS_LANES` overrides), each working one repository's pull requests one after another, so at most four runs at once; retry no sooner than 4 h after the launching tick; holds in `~/.config/webmaster/registry-upgrade_dependency.json` are honored; nothing launches 3 h after the tick started. "
  + "One tick at a time (lock file beside the registry); while a recorded run is alive the whole tick is skipped. "
  + "Each launch is a detached headless `omp -p` limited to the `upgrade_dependency` tool, which MAY push to and arm merge on the pull request and spends model quota; fails with BLOCKED when `upgrade_dependency` is not installed. Logs: `~/.config/webmaster/logs/`. "
  + "NOT ported: the remote compute arm (`vps:up`/`vps:down`) and the schedule; runs execute on this machine. "
  + "Blocks until every launched run exits plus 5 minutes (hours) and sends progress updates; cancelling stops launching and waiting while started runs keep going. "
  + "Returns `{dryRun, repos, launched:[{pr,url,pid}], wouldLaunch, skipped:[{pr,reason}]}`.";

/** Whether an omp tool of this name is installed where omp discovers tools. */
export function toolInstalled(cwd: string, name: string, home: string = homedir()): boolean {
  const roots = [join(home, ".omp", "agent", "tools"), join(cwd, ".omp", "tools")];
  return roots.some((root) => existsSync(join(root, name, "index.ts")) || existsSync(join(root, `${name}.ts`)));
}

export function summarize(result: TickResult): string {
  const lines = [
    `${result.dryRun ? "dry run" : "tick"}: ${result.repos} repositories, ${
      result.dryRun ? `${result.wouldLaunch.length} would launch` : `${result.launched.length} launched`
    }, ${result.skipped.length} skipped`,
  ];
  for (const entry of result.launched) lines.push(`launched ${entry.pr} pid ${entry.pid}`);
  for (const entry of result.wouldLaunch) lines.push(`would launch ${entry.pr}`);
  for (const entry of result.skipped) lines.push(`skipped ${entry.pr}: ${entry.reason}`);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => ({
  name: "upgrade_bot_prs",
  label: "Upgrade bot PRs",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    dryRun: pi.zod.boolean().nullable().optional().describe("List what would launch; launch nothing, write nothing, take no lock. Default false."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const began = Date.now();
    let phase = "listing bot pull requests";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `upgrade_bot_prs: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const host = shellUpgradeBotHost({
        exec: pi.exec,
        cwd: pi.cwd,
        signal,
        installed: (name) => toolInstalled(pi.cwd, name),
      });
      const listed = await listOpenBotPrs(host, { dryRun: params.dryRun ?? undefined });
      phase = `working ${listed.pulls.length} pull requests`;
      const result = await launchUpgradeDependencyPerRepo(host, listed, (message) => {
        phase = message;
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
