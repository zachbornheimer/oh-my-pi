import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, pluginIntegrityVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_plugin_integrity";

export const DESCRIPTION =
  "Check whether a WordPress site's plugin files match their wordpress.org releases and answer pass, fail or unmeasured. Use it when a plugin may have been tampered with; webmaster_security_wordpress_core_integrity covers core files, and webmaster_wordpress_inspect gives the raw reading without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`. It runs `wp plugin verify-checksums --all --format=json` (plugins and themes not loaded) and flags every file it lists as differing (`security.wordpress.plugin_integrity`, high). WP-CLI only verifies plugins wordpress.org publishes checksums for, so a pass says nothing about premium or custom plugins. A non-zero exit that lists no file (not a WordPress install, a WP-CLI error) is `unmeasured`, never a pass. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress plugin integrity check",
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
        const { inspect } = await readServer(params.site, ["plugin_checksums"], deps, run, signal);
        return resultOf(answer(site, CHECK, pluginIntegrityVerdict(inspect)));
      } finally {
        stop();
      }
    },
  };
}
