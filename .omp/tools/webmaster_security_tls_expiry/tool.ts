import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { type CertificateReader, collectSiteCertificate, systemCertificateReader } from "./certificate";
import { answer, apexOf, type CheckTool, hostOf, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { CHECK, expiryVerdict } from "./rules";

export const NAME = "webmaster_security_tls_expiry";

export const DESCRIPTION =
  "Check whether a site's TLS certificate has expired or ends soon: connects to the site on port 443 and reads the certificate a visitor receives. "
  + "Use for certificate-renewal questions; a name mismatch is `webmaster_security_tls_hostname`, an untrusted chain is `webmaster_security_tls_trust`, and the server behind a CDN is `webmaster_security_tls_origin_mismatch`. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://www.example.org/\",\"tls_warn_days\":30}`. `site` is a domain or address (scheme, path and port are ignored; port 443 is always used). `tls_warn_days` defaults to 21. "
  + "A certificate that ended is `security.tls.expiry.expired` (high); one ending within `tls_warn_days` is `security.tls.expiry.expiring` (medium, high at 7 days or fewer); a chain the handshake refused as expired counts as expired. "
  + "Any other refusal, a failed connection (10 s limit) or an unreadable date is `unmeasured` with a reason, NEVER `pass`. An invalid `site` throws. "
  + "Returns JSON `{site,check,status,findings,reason?}`; `status` is `pass`, `fail` or `unmeasured`, and each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: one TLS handshake, nothing is sent on the connection, no certificate is renewed or changed.";

export interface Params {
  site: string;
  tls_warn_days?: number | null;
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
    tls_warn_days: z.number().int().positive().nullable().optional().describe(
      "Days before the end date a certificate is reported; default 21.",
    ),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "TLS certificate expiry",
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
      return toolResult(answer(apexOf(params.site), CHECK, expiryVerdict(certificate, params.tls_warn_days ?? undefined)));
    },
  };
  return tool;
}
