import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, apexOf, type CheckTool, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { type DnsResolver, systemResolver } from "./resolver";
import { CHECK, spfVerdict } from "./rules";
import { collectTxt } from "./txt";

export const NAME = "webmaster_security_email_spf";

export const DESCRIPTION =
  "Check whether a site's domain publishes exactly one usable SPF record: looks up the TXT records of the site's apex domain (a leading `www.` is dropped). "
  + "Use for email-spoofing or deliverability audits; DMARC is `webmaster_security_email_dmarc` and DKIM is `webmaster_security_email_dkim`. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://www.example.org/\"}`; scheme and path are ignored. "
  + "No SPF record is `security.email.spf.missing` (medium); two or more is `security.email.spf.duplicate` (high, a permanent error at receivers); more than 10 DNS-querying terms (`include:`, `a`, `mx`, `ptr`, `exists:`, `redirect=`) in the apex record itself is `security.email.spf.lookups` (high). The records its `include:` terms name are NOT read, so lookups inside them are not counted. "
  + "A failed apex lookup is `unmeasured` with a reason, NEVER `pass`. An invalid `site` throws. "
  + "Returns JSON `{site,check,status,findings,reason?}`; `status` is `pass`, `fail` or `unmeasured`, and each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: public DNS TXT queries (4 s limit each); no DNS record is written and no mail is sent.";

export interface Params {
  site: string;
}

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  resolver?: (signal?: AbortSignal) => DnsResolver;
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  const parameters = z.object({
    site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`; its apex domain is checked."),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "Email SPF",
    description: DESCRIPTION,
    loadMode: "discoverable",
    approval: "read",
    parameters,
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const apex = apexOf(params.site);
      signal?.throwIfAborted();
      const resolver = deps.resolver?.(signal) ?? systemResolver({ signal });
      const entries = await withHeartbeat(onUpdate, `Reading the SPF records for ${apex}`, () => collectTxt(params.site, [], resolver));
      signal?.throwIfAborted();
      return toolResult(answer(apex, CHECK, spfVerdict(params.site, entries)));
    },
  };
  return tool;
}
