import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, apexOf, type CheckTool, toolResult } from "./check";
import { collectSiteDns, DEFAULT_SUBDOMAINS } from "./dns_collect";
import { withHeartbeat } from "./heartbeat";
import { type DnsResolver, systemResolver } from "./resolver";
import { CHECK, danglingVerdict } from "./rules";

export const NAME = "webmaster_security_dns_dangling";

export const DESCRIPTION =
  "Check whether a site's DNS names still point at services that exist, to catch subdomain-takeover risk: resolves the apex, `www`, nine common subdomains (shop, store, blog, app, staging, dev, test, mail, webmail) and any you add, plus the MX and NS hosts the apex names, following each CNAME chain. "
  + "Use when decommissioning a service or auditing a domain's DNS; email records are `webmaster_security_email_spf`, `webmaster_security_email_dmarc` and `webmaster_security_email_dkim`. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"example.org\",\"subdomains\":[\"go\",\"help\"]}`. `subdomains` are extra labels (at most 50) looked up besides the defaults; other subdomains are NOT discovered. "
  + "A CNAME whose chain ends at a name that does not exist (NXDOMAIN) is `security.dns.dangling` (high), naming the service when it is Leadpages, Heroku, S3, GitHub Pages, Azure, Shopify, Netlify, Vercel, Fastly, Unbounce, Zendesk or HubSpot; a target that exists but holds no address is fine, a name whose lookup failed is not judged, and a wildcard record that dangles is reported once as `*.<domain>`. "
  + "It does NOT fetch the provider's page, so a CNAME to a provider whose name is merely unclaimed is not seen. If the apex lookup itself failed the answer is `unmeasured`, NEVER `pass`. "
  + "Returns JSON `{site,check,status,findings,reason?}`; each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: about 100 public DNS queries (4 s limit each); no record is written or deleted.";

/** The most extra labels one call may add, so one call cannot become a zone scan. */
export const MAX_EXTRA_SUBDOMAINS = 50;
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/** The caller's extra labels, trimmed and lower-cased. Throws on one that is not a DNS label, before any query is made. */
export function validLabels(labels: readonly string[] = []): string[] {
  if (labels.length > MAX_EXTRA_SUBDOMAINS) {
    throw new Error(`subdomains takes at most ${MAX_EXTRA_SUBDOMAINS} labels; got ${labels.length}`);
  }
  return labels.map((label) => {
    const name = label.trim().toLowerCase();
    if (!LABEL.test(name)) throw new Error(`subdomains must be DNS labels such as \`shop\` or \`help\`; got ${JSON.stringify(label)}`);
    return name;
  });
}

export interface Params {
  site: string;
  subdomains?: string[] | null;
}

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  resolver?: (signal?: AbortSignal) => DnsResolver;
  /** The made-up label looked up to detect a wildcard record; random by default. */
  wildcardLabel?: string;
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  const parameters = z.object({
    site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`; its apex domain is checked."),
    subdomains: z.array(z.string().min(1)).nullable().optional().describe(
      "Extra subdomain labels to look up besides `www` and the nine defaults, such as `go` or `help`; at most 50; default none.",
    ),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "DNS dangling records",
    description: DESCRIPTION,
    loadMode: "discoverable",
    approval: "read",
    parameters,
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const apex = apexOf(params.site);
      const extra = validLabels(params.subdomains ?? undefined);
      signal?.throwIfAborted();
      const resolver = deps.resolver?.(signal) ?? systemResolver({ signal });
      const collected = await withHeartbeat(onUpdate, `Reading the DNS records for ${apex}`, () =>
        collectSiteDns(params.site, resolver, {
          subdomains: [...DEFAULT_SUBDOMAINS, ...extra],
          ...(deps.wildcardLabel === undefined ? {} : { wildcardLabel: deps.wildcardLabel }),
        }));
      signal?.throwIfAborted();
      return toolResult(answer(apex, CHECK, danglingVerdict(params.site, collected.names)));
    },
  };
  return tool;
}
