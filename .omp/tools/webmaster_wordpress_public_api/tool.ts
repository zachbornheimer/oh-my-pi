import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { measureWordpressPublicApi } from "./public_api.ts";

export interface PublicApiToolDeps {
  net?: SecurityNet;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Ask a WordPress site's public endpoints what an anonymous visitor gets, and record each answer: the home page and feed (one same-site redirect followed), `/readme.html` (where the version shows), an empty REST batch, `/xmlrpc.php`, the users routes and `/?author=1`; plus WordPress.org's current releases to compare the version against. "
  + "Use it for the raw reading; it never says whether the site is outdated or exposed (webmaster_security_wordpress_* checks do). "
  + "Input: `{\"site\":\"example.org\"}`; `site` is a domain or address (only its origin is asked). "
  + "Sends 9 requests to the site, 6 at once, 15 s each, to public addresses only (loopback, private and link-local targets are refused): GET, except one POST of the empty body `{\"requests\":[]}` to each of `/?rest_route=/batch/v1` and `/wp-json/batch/v1`, which WordPress answers without running anything. Also one GET to api.wordpress.org for the release list. No redirect to another host is followed. Read-only. "
  + "Result: `{site, public_api}`; `public_api` is `measured` with `home`, `feed`, `readme`, `rest_batch[]`, `xmlrpc`, `users[]`, `author` (each `{method, path, status, content_type, body, location?, error?}`, bodies capped at 64000 characters with secret-looking values redacted) and `releases` (`measured` with versions newest first, or `unmeasured` with why), or `unmeasured` with a reason when the home page does not answer. An unparsable `site` is refused.";

export function makeTool(pi: Pi, deps: PublicApiToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_wordpress_public_api",
    label: "WordPress public API",
    description: DESCRIPTION,
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
      const result = {
        site: apexOf(params.site),
        public_api: await measureWordpressPublicApi({ siteUrl }, deps.net ?? systemSecurityNet, signal),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
