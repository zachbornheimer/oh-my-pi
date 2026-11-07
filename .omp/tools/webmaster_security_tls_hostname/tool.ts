import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { type CertificateReader, collectSiteCertificate, systemCertificateReader } from "./certificate";
import { answer, apexOf, type CheckTool, hostOf, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { CHECK, hostnameVerdict } from "./rules";

export const NAME = "webmaster_security_tls_hostname";

export const DESCRIPTION =
  "Check whether the TLS certificate a site serves names the site's own host: connects to the site on port 443 and compares the certificate's DNS names with the host. "
  + "Use when a browser shows a name-mismatch warning or after moving a site to a new server or CDN; expiry is `webmaster_security_tls_expiry`, an untrusted chain is `webmaster_security_tls_trust`, and the origin behind a CDN is `webmaster_security_tls_origin_mismatch`. "
  + "Input: `{\"site\":\"www.example.org\"}` or `{\"site\":\"https://example.org/\"}`. `site` is a domain or address; scheme, path and port are ignored, port 443 is always used, and the host asked for keeps a leading `www.`. "
  + "A certificate whose names do not include the host is `security.tls.hostname` (high); a wildcard `*.example.org` covers exactly one label, so it covers `www.example.org` but neither `example.org` nor `a.b.example.org`. "
  + "A chain the handshake refused (names unreadable), a failed connection (10 s limit) or no certificate is `unmeasured` with a reason, NEVER `pass`. An invalid `site` throws. "
  + "Returns JSON `{site,check,status,findings,reason?}`; `status` is `pass`, `fail` or `unmeasured`, and each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: one TLS handshake, nothing is sent on the connection, no certificate is changed.";

export interface Params {
  site: string;
}

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  reader?: CertificateReader;
  now?: () => Date;
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  const parameters = z.object({
    site: z.string().min(1).describe("Domain or address, such as `www.example.org` or `https://example.org/`; only the host is used."),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "TLS certificate hostname",
    description: DESCRIPTION,
    loadMode: "discoverable",
    approval: "read",
    parameters,
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const host = hostOf(params.site);
      signal?.throwIfAborted();
      const certificate = await withHeartbeat(onUpdate, `Reading the TLS certificate for ${host}`, () =>
        collectSiteCertificate(params.site, deps.reader ?? systemCertificateReader, {
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(signal === undefined ? {} : { signal }),
        }));
      return toolResult(answer(apexOf(params.site), CHECK, hostnameVerdict(certificate)));
    },
  };
  return tool;
}
