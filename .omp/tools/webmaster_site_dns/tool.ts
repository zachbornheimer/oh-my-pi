import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { collectSiteDns, type DnsResolver, type SiteDnsResult, systemResolver } from "./dns.ts";

export interface DnsToolDeps {
  resolver?: DnsResolver;
  /** The made-up label looked up to detect a wildcard record; random when omitted. */
  wildcardLabel?: string;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Collect a site's raw DNS records: A, AAAA, the CNAME chain, MX, NS and TXT for the apex, www, each common subdomain that answers, and the MX and NS hosts the apex names. "
  + "Use it for raw records; it never says what they mean, who hosts a name, or whether a record is safe (use the webmaster_security_dns_* and email checks for findings). "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://www.example.org/\",\"subdomains\":[\"staging\",\"shop\"]}`. `site` is a domain or address; only its apex (no scheme, path or leading `www.`) is used. `subdomains` are labels such as `shop` or `s1._domainkey` (letters, digits, `-`, `_`, dot-separated; at most 50) and default to shop, store, blog, app, staging, dev, test, mail, webmail; `[]` looks up none. "
  + "Sends DNS queries only, through the machine's resolver (about 6 per name; MX and NS hosts are capped at 25 each), plus one made-up label to detect a wildcard record. Changes no DNS and sends nothing to the site. "
  + "Result: `{site, wildcard?, names}`: one entry per hostname with `role`, `a`, `aaaa`, `cname`, `mx`, `ns`, `txt`, and `nxdomain`, `wildcard` or `error` when set. A failed lookup is that entry's `error`, never an exception; a subdomain with no records is omitted, so absence from `names` means no record was found. An unparsable `site` or an invalid subdomain label is refused before any query.";

export function makeTool(pi: Pi, deps: DnsToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_site_dns",
    label: "Site DNS records",
    description: DESCRIPTION,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`; only the apex is used."),
      subdomains: z.array(z.string()).nullable().optional().describe(
        "Subdomain labels to look for besides `www`, such as `shop` or `staging`; at most 50. Omit for the default list; `[]` for none.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; subdomains?: string[] | null },
      _onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const result: SiteDnsResult = await collectSiteDns(params.site, deps.resolver ?? systemResolver, {
        ...(params.subdomains == null ? {} : { subdomains: params.subdomains }),
        ...(deps.wildcardLabel === undefined ? {} : { wildcardLabel: deps.wildcardLabel }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
