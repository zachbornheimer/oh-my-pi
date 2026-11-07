import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, uploadsPhpVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_uploads_php";

export const DESCRIPTION =
  "Check whether a WordPress site keeps PHP files in its uploads folder and answer pass, fail or unmeasured. Use it for the uploads slice of a compromise check; webmaster_security_wordpress_core_integrity and _plugin_integrity cover changed code elsewhere, and webmaster_wordpress_inspect gives the raw reading without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`. It asks WordPress for its uploads folder (`wp eval`; never assumed to be `wp-content/uploads`), then runs `find -H <uploads> -type f -iname '*.ph*'` and flags every file found (`security.wordpress.uploads_php`, high); the pattern also matches names such as `a.photo.jpg`. If the folder cannot be named or scanned the result is `unmeasured`; a subfolder `find` could not read does not hide the rest. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress uploads PHP check",
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
        const { inspect } = await readServer(params.site, ["uploads_php"], deps, run, signal);
        return resultOf(answer(site, CHECK, uploadsPhpVerdict(inspect)));
      } finally {
        stop();
      }
    },
  };
}
