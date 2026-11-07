import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { CHECK, newAdminsVerdict } from "./rule.ts";
import { heartbeat, readServer, runWithPi, SERVER_RULES, type ServerDeps } from "./server_reading.ts";
import { apexOf } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

export const NAME = "webmaster_security_wordpress_new_admins";

export const DESCRIPTION =
  "Check whether a WordPress site gained administrator accounts recently and answer pass, fail or unmeasured. Use it for the accounts slice of a compromise check; webmaster_security_wordpress_user_enumeration asks what an anonymous visitor can learn about users, and webmaster_wordpress_inspect gives the raw reading without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`. It runs `wp user list --role=administrator --fields=ID,user_login,user_registered --format=json` (plugins and themes not loaded) and flags administrators whose `user_registered` (UTC) is under 14 whole days before the reading (`security.wordpress.new_admins`, high). Other roles, and administrators who were promoted rather than registered recently, are not seen. "
  + `${SERVER_RULES} ${RESULT_RULES}`;

export function makeTool(pi: Pi, deps: ServerDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  return {
    name: NAME,
    label: "WordPress new administrators check",
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
        const { inspect } = await readServer(params.site, ["administrators"], deps, run, signal);
        return resultOf(answer(site, CHECK, newAdminsVerdict(inspect)));
      } finally {
        stop();
      }
    },
  };
}
