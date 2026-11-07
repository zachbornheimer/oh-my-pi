import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, apexOf, type CheckTool, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { type DnsResolver, systemResolver } from "./resolver";
import { CHECK, DMARC_LABEL, dmarcVerdict } from "./rules";
import { collectTxt } from "./txt";

export const NAME = "webmaster_security_email_dmarc";

export const DESCRIPTION =
  "Check whether a site's domain publishes an enforcing DMARC policy: looks up the TXT records of `_dmarc.<apex domain>` (a leading `www.` is dropped) and reads the `p=` tag. "
  + "Use for email-spoofing audits; SPF is `webmaster_security_email_spf` and DKIM is `webmaster_security_email_dkim`. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://www.example.org/\"}`; scheme and path are ignored. "
  + "No DMARC record is `security.email.dmarc.missing` (medium); `p=none` is `security.email.dmarc.none` (medium, spoofed mail is reported but delivered); any other policy passes, so a record with no `p=` tag is NOT flagged. Tags are parsed, not pattern-matched. "
  + "A failed lookup of the apex or of `_dmarc` is `unmeasured` with a reason, NEVER `pass`. An invalid `site` throws. "
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
    label: "Email DMARC",
    description: DESCRIPTION,
    loadMode: "discoverable",
    approval: "read",
    parameters,
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const apex = apexOf(params.site);
      signal?.throwIfAborted();
      const resolver = deps.resolver?.(signal) ?? systemResolver({ signal });
      const entries = await withHeartbeat(onUpdate, `Reading the DMARC record for ${apex}`, () =>
        collectTxt(params.site, [DMARC_LABEL], resolver));
      signal?.throwIfAborted();
      return toolResult(answer(apex, CHECK, dmarcVerdict(params.site, entries)));
    },
  };
  return tool;
}
