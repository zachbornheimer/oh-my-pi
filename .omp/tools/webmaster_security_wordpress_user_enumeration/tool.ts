import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { readPublicApi } from "./public_api.ts";
import { CHECK, userEnumerationVerdict } from "./rule.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface HttpCheckDeps {
  net?: SecurityNet;
}

export const NAME = "webmaster_security_wordpress_user_enumeration";

export const DESCRIPTION =
  "Check whether a WordPress site gives an anonymous visitor its user names and answer pass, fail or unmeasured. Use it for the user-enumeration slice of a site security sweep; webmaster_security_wordpress_new_admins checks accounts from the server, and webmaster_wordpress_public_api gives the raw answers without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`; only its origin is asked. It sends three GETs (`/wp-json/wp/v2/users`, `/?rest_route=/wp/v2/users` and `/?author=1`; 15 s each, public addresses only, so loopback, private and link-local targets are refused; redirects not followed) and flags a 2xx users listing that carries `slug` values, or an `?author=1` redirect (3xx) to an `/author/<name>` page (`security.wordpress.user_enumeration`, medium). The evidence lists up to 5 names. All three unanswered is `unmeasured`. "
  + RESULT_RULES;

export function makeTool(pi: Pi, deps: HttpCheckDeps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "WordPress user enumeration check",
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
      const reading = await readPublicApi(siteUrl, ["users", "author"], deps.net ?? systemSecurityNet, signal);
      return resultOf(answer(site, CHECK, userEnumerationVerdict(reading)));
    },
  };
}
