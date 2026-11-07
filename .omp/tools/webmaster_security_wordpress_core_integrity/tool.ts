import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, coreIntegrityVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_core_integrity";

export const DESCRIPTION =
  "Check whether a WordPress site's core files match the official release and answer pass, fail or unmeasured. Use it when a site may have been tampered with; webmaster_security_wordpress_plugin_integrity covers plugin files, and webmaster_wordpress_inspect gives the raw reading without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`. It runs `wp core verify-checksums` (plugins and themes not loaded; it fetches the checksums from WordPress.org from the server) and flags files reported as modified or as files that should not exist (`security.wordpress.core_integrity`, high). `wp-content` is not part of core and is not checked here. A non-zero exit that names no file is `unmeasured`, never a pass. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress core integrity check",
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
        const { inspect } = await readServer(params.site, ["core_checksums"], deps, run, signal);
        return resultOf(answer(site, CHECK, coreIntegrityVerdict(inspect)));
      } finally {
        stop();
      }
    },
  };
}
