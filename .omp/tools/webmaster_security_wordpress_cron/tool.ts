import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, cronVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_cron";

export const DESCRIPTION =
  "Check whether a WordPress site schedules suspicious cron events and answer pass, fail or unmeasured. Use it for the cron slice of a compromise check; sibling checks cover other signals (webmaster_security_wordpress_new_admins, _plugin_integrity, _core_integrity), and webmaster_wordpress_inspect gives the raw server reading without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`. It runs `wp cron event list --format=json` (plugins and themes not loaded) and flags hooks that are 12+ hex digits, 24+ plain letters and digits, or contain `eval`, `base64`, `shell`, `exec`, `cmd` or `backdoor` (`security.wordpress.cron`, medium); a legitimate hook containing one of those words is flagged too. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress cron check",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    approval: "exec" as const,
    parameters: z.object({
      site: z.string().min(1).describe(
        "Domain or address, such as `example.org` or `https://www.example.org/`; matched to a site file by host.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string },
      onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const site = apexOf(params.site);
      const stop = heartbeat(onUpdate, "reading the server over SSH");
      try {
        const { inspect } = await readServer(params.site, ["cron_events"], deps, run, signal);
        return resultOf(answer(site, CHECK, cronVerdict(inspect)));
      } finally {
        stop();
      }
    },
  };
}
