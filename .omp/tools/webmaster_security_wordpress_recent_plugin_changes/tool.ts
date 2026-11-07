import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, recentPluginChangesVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_recent_plugin_changes";

export const DESCRIPTION =
  "Check whether a WordPress site's plugin or theme folders changed recently and answer pass, fail or unmeasured. Use it for the changed-code slice of a compromise check; webmaster_security_wordpress_plugin_integrity compares plugin files with their releases, and webmaster_wordpress_inspect gives the raw reading without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`. It asks WordPress for its plugin and theme folders (`wp eval`; never assumed to be under `wp-content`), then runs `find -H <folder> -mindepth 1 -maxdepth 1 -type d -mtime -14` on each and flags folders changed in the last 14 days (`security.wordpress.recent_plugin_changes`: high when a plugin folder matches `file-?manager`, else low). A folder that cannot be scanned is `unmeasured` unless the other one shows a change, which is then reported with the failure named. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress recent plugin changes check",
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
        const { inspect } = await readServer(
          params.site,
          ["plugin_directories", "theme_directories"],
          deps,
          run,
          signal,
        );
        return resultOf(answer(site, CHECK, recentPluginChangesVerdict(inspect)));
      } finally {
        stop();
      }
    },
  };
}
