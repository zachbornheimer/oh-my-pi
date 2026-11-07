import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answer, RESULT_RULES, resultOf } from "./check.ts";
import { apexOf, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net.ts";
import { readPublicApi } from "./public_api.ts";
import { CHECK, xmlrpcVerdict } from "./rule.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface HttpCheckDeps {
  net?: SecurityNet;
}

export const NAME = "webmaster_security_wordpress_xmlrpc";

export const DESCRIPTION =
  "Check whether a WordPress site's XML-RPC endpoint is live to an anonymous visitor and answer pass, fail or unmeasured. Use it for the XML-RPC slice of a site security sweep; webmaster_security_wordpress_rest_batch and _user_enumeration cover the REST API, and webmaster_wordpress_public_api gives the raw answers without a verdict. "
  + "Input: `{\"site\":\"example.org\"}`; only its origin is asked. It sends one GET to `/xmlrpc.php` (15 s; public addresses only, so loopback, private and link-local targets are refused; no redirect to another host is followed; read-only) and flags a 405 saying `accepts POST requests only`, or a 2xx carrying `<methodResponse>` (`security.wordpress.xmlrpc`, medium). WordPress gives that 405 even when the `xmlrpc_enabled` filter has turned XML-RPC off, so a finding shows the file answers, not that XML-RPC methods work; it sends no XML-RPC call. No answer is `unmeasured`. "
  + RESULT_RULES;

export function makeTool(pi: Pi, deps: HttpCheckDeps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "WordPress XML-RPC check",
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
      const reading = await readPublicApi(siteUrl, ["xmlrpc"], deps.net ?? systemSecurityNet, signal);
      return resultOf(answer(site, CHECK, xmlrpcVerdict(reading.xmlrpc)));
    },
  };
}
