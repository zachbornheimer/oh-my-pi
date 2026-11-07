import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { type CertificateReader, collectSiteCertificate, systemCertificateReader } from "./certificate";
import { answer, apexOf, type CheckTool, hostOf, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { CHECK, trustVerdict } from "./rules";

export const NAME = "webmaster_security_tls_trust";

export const DESCRIPTION =
  "Check whether a site's TLS certificate chain verifies against this machine's public trust roots: connects to the site on port 443 and reports whether the handshake accepted the chain. "
  + "Use when a browser warns that a certificate is untrusted, self-signed or from an unknown issuer, or when the server may be missing an intermediate certificate; expiry is `webmaster_security_tls_expiry`, a name mismatch is `webmaster_security_tls_hostname`, and the origin behind a CDN is `webmaster_security_tls_origin_mismatch`. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://www.example.org/\"}`. `site` is a domain or address; scheme, path and port are ignored and port 443 is always used. "
  + "A chain refused for any reason except expiry (self-signed, unable to get local issuer, unknown CA) is `security.tls.trust` (high) with the verification code in the evidence. An expired chain passes here: it is the expiry tool's finding. "
  + "A failed connection (10 s limit) is `unmeasured` with a reason, NEVER `pass`. An invalid `site` throws. "
  + "Returns JSON `{site,check,status,findings,reason?}`; `status` is `pass`, `fail` or `unmeasured`, and each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: one TLS handshake with chain verification on, nothing is sent on the connection, no certificate is changed.";

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
    site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`; only the host is used."),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "TLS certificate trust",
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
      return toolResult(answer(apexOf(params.site), CHECK, trustVerdict(certificate)));
    },
  };
  return tool;
}
