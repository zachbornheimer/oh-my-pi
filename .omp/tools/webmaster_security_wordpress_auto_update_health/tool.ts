import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { type SecurityNet, systemSecurityNet } from "./net.ts";
import { readReleases } from "./public_api.ts";
import { autoUpdateHealthVerdict, CHECK } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface AutoUpdateHealthDeps extends ServerDeps {
  net?: SecurityNet;
}

export const NAME = "webmaster_security_wordpress_auto_update_health";

export const DESCRIPTION =
  "Check whether WordPress core updates reach a site and answer pass, fail or unmeasured. Use it when a site sits on an old core or may have its update checks hidden; webmaster_security_wordpress_core_version judges the published version without server access, and webmaster_wordpress_inspect gives the raw reading. "
  + "Input: `{\"site\":\"example.org\"}`. It reads `wp core version`, the update-filter callbacks, the update constants and the `wp_version_check` cron event (NEVER `wp core check-update`, which a filter can blind) plus one GET of api.wordpress.org's release list; the site is not contacted. Ids start `security.wordpress.auto_update_health`: `.core_behind` and `.core_unsupported_branch` (high); `.update_discovery_blinded` (a callback on `pre_site_transient_update_core` or `_plugins`) and `.auto_update_blocked` (a callback on `auto_update_core` or `automatic_updater_disabled` that can stop updates) (high); `.updater_disabled` (`AUTOMATIC_UPDATER_DISABLED`, `WP_AUTO_UPDATE_CORE=false`) and `.version_check_cron` (missing or over two intervals late) (medium). "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: AutoUpdateHealthDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress auto-update health check",
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
        const { inspect } = await readServer(params.site, ["core_version", "update_discovery"], deps, run, signal);
        // The release list only matters when the server was read; without it nothing is judged.
        const releases = inspect.status === "measured"
          ? await readReleases(deps.net ?? systemSecurityNet, signal)
          : undefined;
        return resultOf(answer(site, CHECK, autoUpdateHealthVerdict(inspect, releases)));
      } finally {
        stop();
      }
    },
  };
}
