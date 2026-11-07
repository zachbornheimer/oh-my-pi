import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, apexOf, type CheckTool, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { type DnsResolver, systemResolver } from "./resolver";
import { CHECK, dkimLabel, dkimVerdict, selectorsToAsk, validSelectors } from "./rules";
import { collectTxt } from "./txt";

export const NAME = "webmaster_security_email_dkim";

export const DESCRIPTION =
  "Check whether a site's domain publishes a DKIM signing key: looks up the TXT record at `<selector>._domainkey.<apex domain>` (a leading `www.` is dropped) for 21 selectors common mail providers use (google, selector1, selector2, k1, s1, mandrill, protonmail, zoho, fm1 and others) plus your own. "
  + "Use for email-spoofing or deliverability audits; SPF is `webmaster_security_email_spf` and DMARC is `webmaster_security_email_dmarc`. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"example.org\",\"dkim_selectors\":[\"brand2024\"]}`. `dkim_selectors` are the domain's own selectors, asked besides the common ones; each MUST be dot-separated DNS labels (letters, digits, hyphens) or the call throws before any query. DKIM selectors cannot be listed in DNS, so a key under an unlisted selector is NOT seen. "
  + "A key counts per RFC 6376: `v=`, when present, is `DKIM1`, and `p=` is non-empty (an empty `p=` is a revoked key). No key at any selector is `security.email.dkim.missing` (medium). "
  + "If no key is found and any selector lookup failed, the answer is `unmeasured` with a reason, NEVER `pass`. "
  + "Returns JSON `{site,check,status,findings,reason?}`; `status` is `pass`, `fail` or `unmeasured`, and each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: about 22 public DNS TXT queries (4 s limit each); no DNS record is written and no mail is sent.";

export interface Params {
  site: string;
  dkim_selectors?: string[] | null;
}

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  resolver?: (signal?: AbortSignal) => DnsResolver;
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  const parameters = z.object({
    site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`; its apex domain is checked."),
    dkim_selectors: z.array(z.string().min(1)).nullable().optional().describe(
      "The domain's own DKIM selectors, such as `brand2024`, asked besides the common ones; default none.",
    ),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "Email DKIM",
    description: DESCRIPTION,
    loadMode: "discoverable",
    approval: "read",
    parameters,
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const apex = apexOf(params.site);
      const extra = validSelectors(params.dkim_selectors ?? undefined);
      signal?.throwIfAborted();
      const resolver = deps.resolver?.(signal) ?? systemResolver({ signal });
      const labels = selectorsToAsk(extra).map(dkimLabel);
      const entries = await withHeartbeat(onUpdate, `Reading the DKIM keys for ${apex}`, () =>
        collectTxt(params.site, labels, resolver));
      signal?.throwIfAborted();
      return toolResult(answer(apex, CHECK, dkimVerdict(params.site, entries, extra)));
    },
  };
  return tool;
}
