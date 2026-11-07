import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { readPublicApi } from "./public_api.ts";
import { CHECK, coreVersionVerdict } from "./rule.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface HttpCheckDeps {
  net?: SecurityNet;
}

export const NAME = "webmaster_security_wordpress_core_version";

export const DESCRIPTION =
  "Check whether a WordPress site runs a supported core release, judged from the version the site publishes, and answer pass, fail or unmeasured. Use it for the core-version slice of a site security sweep; webmaster_security_wordpress_auto_update_health reads the installed version from the server instead, and webmaster_wordpress_public_api gives the raw answers without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`; only its origin is asked. It sends GETs to `/`, `/feed/` and `/readme.html` (one redirect within the site followed for the first two; 15 s each; public addresses only, so loopback, private and link-local targets are refused) and one GET to api.wordpress.org for the current releases. The version comes from the home page's generator tag, else the feed's generator, else the readme. Behind the newest release of its own branch is `security.wordpress.core_version.behind_branch` (high); current on an older branch is `.older_branch` (medium). A site that hides its version, or an unreadable release list, is `unmeasured`. "
  + RESULT_RULES;

export function makeTool(pi: Pi, deps: HttpCheckDeps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "WordPress core version check",
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
      const reading = await readPublicApi(
        siteUrl,
        ["home", "feed", "readme", "releases"],
        deps.net ?? systemSecurityNet,
        signal,
      );
      return resultOf(answer(site, CHECK, coreVersionVerdict(reading)));
    },
  };
}
