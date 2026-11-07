import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { defaultHost } from "./agents.js";
import { REAP_ACTIONS, REAP_SCOPES, reapText, runReap } from "./reap.js";

const DESCRIPTION =
  "Find stuck work on this Mac and kill it, and manage the three LaunchAgents that do it on a clock. "
  + "Use to clear hung git-hook checks or orphaned omp workers and browsers; it is not a general process killer (use run_command for a pid you name). "
  + "Input `{\"action\":\"report\"}`. action: `report` (default; lists candidates, kills nothing), `reap` (lists and kills now), `install` (copies the scanner to ~/.omp/agent/reap-stale-checks, writes and loads the plists in ~/Library/LaunchAgents), `install_and_reap`, `uninstall` (unloads and deletes the plists), `status` (launchd state and last logged runs). "
  + "scope: `long`, `orphans`, `omp-orphans` or `both` (default, each pass in turn). max_age_minutes 1 to 720 overrides the age limit (defaults 20, 1, 10). "
  + "Passes: `long` is a hook root (`hk run`, `lefthook`, `git push|commit`, `sah-*` scripts) or check work under one (`mise run test|ci|lint|scan`, `go test`, `vitest`, `cargo test`, `tofu`) past the limit; `orphans` is the same with ppid 1; `omp-orphans` is a `__omp_worker_*` process or Chrome-for-Testing under ~/.omp/puppeteer with ppid 1, no tty and past the limit. "
  + "Check work started by hand, `REAP_EXEMPT=1` trees, this process's ancestors and omp auth-broker/auth-gateway are never touched. "
  + "Killing takes the whole subtree: SIGTERM, 2 s grace, SIGKILL. `reap`, `install*` and `uninstall` change the machine (kill processes, write ~/Library/LaunchAgents, run launchctl) and acting passes append to ~/Library/Logs/omp/reap-stale-checks.jsonl. "
  + "Returns action, scans (candidates with pid, ppid, age_min, reason, command; killed; survivors; `skipped` when another pass held the lock), agents (loaded, plist_written, last_exit_status, last_run_at) and log_file. An unreadable process table throws. Runs no model and no network.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "reap_stale_checks",
    label: "Reap Stale Checks",
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(REAP_ACTIONS).nullable().optional().describe("report (default): list, kill nothing. reap: list and kill. install, install_and_reap, uninstall: manage the LaunchAgents. status: launchd state and last runs."),
      scope: z.enum(REAP_SCOPES).nullable().optional().describe("long, orphans, omp-orphans, or both (default): the pass or passes, and for install/uninstall the agents."),
      max_age_minutes: z.number().int().nullable().optional().describe("Age a candidate must exceed, 1 to 720. Defaults: 20 for long, 1 for orphans, 10 for omp-orphans."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      const output = await runReap(params, { host: defaultHost(), signal });
      return { content: [{ type: "text", text: reapText(output) }], details: output };
    },
  };
};

export default factory;
