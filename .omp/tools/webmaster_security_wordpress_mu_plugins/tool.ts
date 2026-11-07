import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, muPluginsVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_mu_plugins";

export const DESCRIPTION =
  "Check whether a WordPress site loads must-use plugins or drop-ins nobody vouched for and answer pass, fail or unmeasured. Use it for the must-use slice of a compromise check; webmaster_wordpress_inspect gives the raw reading without a verdict. "
  + "Input: `{\"site\":\"example.org\",\"known_mu_plugins\":[\"my-loader\"],\"debug_file_patterns\":[\"debug-*\"]}`; the two lists are optional. It runs `wp plugin list --fields=name,status --format=json` and flags must-use plugins and drop-ins that are neither on the built-in list of well-known hosting and cache ones nor in `known_mu_plugins` (`security.wordpress.mu_plugins.unknown`, high), and any whose name matches a `debug_file_patterns` glob (`*`, `?`, case-insensitive; `.debug_file`, high). Omitted, each list comes from the site file's `security.known_mu_plugins` and `security.debug_file_patterns`; a list you pass replaces the site file's, not adds to it. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress must-use plugins check",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    approval: "exec" as const,
    parameters: z.object({
      site: z.string().min(1).describe(
        "Domain or address, such as `example.org` or `https://www.example.org/`; matched to a site file by host.",
      ),
      known_mu_plugins: z.array(z.string()).nullable().optional().describe(
        "Must-use plugins and drop-ins the owner vouches for, besides the well-known ones, such as `my-loader`. Omit to use the site file's list.",
      ),
      debug_file_patterns: z.array(z.string()).nullable().optional().describe(
        "Globs (`*`, `?`) naming debug files that must never load as must-use plugins. Omit to use the site file's list.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; known_mu_plugins?: string[] | null; debug_file_patterns?: string[] | null },
      onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const site = apexOf(params.site);
      const stop = heartbeat(onUpdate, "reading the server over SSH");
      try {
        const { inspect, security } = await readServer(params.site, ["must_use_plugins"], deps, run, signal);
        const verdict = muPluginsVerdict(inspect, {
          known_mu_plugins: params.known_mu_plugins ?? security?.known_mu_plugins ?? [],
          debug_file_patterns: params.debug_file_patterns ?? security?.debug_file_patterns ?? [],
        });
        return resultOf(answer(site, CHECK, verdict));
      } finally {
        stop();
      }
    },
  };
}
