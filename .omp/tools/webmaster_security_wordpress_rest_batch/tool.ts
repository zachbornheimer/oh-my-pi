import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { readPublicApi } from "./public_api.ts";
import { CHECK, restBatchVerdict } from "./rule.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface HttpCheckDeps {
  net?: SecurityNet;
}

export const NAME = "webmaster_security_wordpress_rest_batch";

export const DESCRIPTION =
  "Check whether a WordPress site's REST batch endpoint answers an anonymous empty batch and report pass, fail or unmeasured. Use it for the REST batch slice of a site security sweep; webmaster_security_wordpress_user_enumeration and _xmlrpc cover other anonymous endpoints, and webmaster_wordpress_public_api gives the raw answers without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`; only its origin is asked. It sends two POSTs of the empty body `{\"requests\":[]}` (to `/?rest_route=/batch/v1` and `/wp-json/batch/v1`), which WordPress answers without running any sub-request; 15 s each, public addresses only (loopback, private and link-local targets are refused), no redirect to another host followed. It flags a 200 or 207 from either route (`security.wordpress.rest_batch`, high). That shows the route takes an anonymous batch, not that any plugin route is reachable through it. No route answering is `unmeasured`. "
  + RESULT_RULES;

export function makeTool(pi: Pi, deps: HttpCheckDeps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "WordPress REST batch check",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    approval: "read" as const,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`."),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string },
      _onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const siteUrl = siteUrlOf(params.site);
      const site = apexOf(params.site);
      const reading = await readPublicApi(siteUrl, ["rest_batch"], deps.net ?? systemSecurityNet, signal);
      return resultOf(answer(site, CHECK, restBatchVerdict(reading.rest_batch)));
    },
  };
}
