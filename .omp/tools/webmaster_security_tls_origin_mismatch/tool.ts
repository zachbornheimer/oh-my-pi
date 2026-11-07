import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { type CertificateReader, collectSiteCertificate, systemCertificateReader } from "./certificate";
import { answer, apexOf, type CheckTool, hostOf, toolResult } from "./check";
import { withHeartbeat } from "./heartbeat";
import { CHECK, NO_ORIGIN_REASON, originVerdict } from "./rules";

export const NAME = "webmaster_security_tls_origin_mismatch";

export const DESCRIPTION =
  "Check whether the origin server behind a site's CDN or edge serves a valid TLS certificate for the site's name: connects to `origin` on port 443 presenting the site's host name (SNI) and reads that certificate. "
  + "Use when a CDN or proxy fronts the site and the origin's own certificate may have lapsed or be for another name; the certificate visitors receive is `webmaster_security_tls_expiry`, `webmaster_security_tls_hostname` and `webmaster_security_tls_trust`. "
  + "Input: `{\"site\":\"example.org\",\"origin\":\"203.0.113.7\"}` with optional `tls_warn_days` (default 21). `origin` is the origin's IP or host name; a URL is reduced to its host. Without `origin` nothing is read and the answer is `unmeasured`. "
  + "An origin certificate that does not cover the host, ended, ends within `tls_warn_days`, or whose chain the handshake refused is `security.tls.origin_mismatch` (medium), with every problem in the evidence. "
  + "A failed connection (10 s limit) is `unmeasured` with a reason, NEVER `pass`. An invalid `site` throws. "
  + "Returns JSON `{site,check,status,findings,reason?}`; `status` is `pass`, `fail` or `unmeasured`, and each finding has `id`, `severity`, `evidence`, `containment` and `fix_hint`. "
  + "Read-only: one TLS handshake to the address you name and none to the site itself; nothing is sent on the connection and no certificate is changed.";

export interface Params {
  site: string;
  origin?: string | null;
  tls_warn_days?: number | null;
}

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  reader?: CertificateReader;
  now?: () => Date;
}

/** The host an origin names: a bare host or IP as given, or the host of an address such as `https://203.0.113.7:8443/`. */
export function originHost(origin: string): string {
  const text = origin.trim();
  if (!text.includes("://")) return text;
  try {
    return new URL(text).hostname;
  } catch {
    throw new Error(`origin must be an IP address or host name; got ${JSON.stringify(origin)}`);
  }
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  const parameters = z.object({
    site: z.string().min(1).describe("Domain or address, such as `example.org`; its host is the name asked of the origin."),
    origin: z.string().min(1).nullable().optional().describe(
      "The origin server's IP or host name, connected to on port 443; omitted means nothing is read (`unmeasured`).",
    ),
    tls_warn_days: z.number().int().positive().nullable().optional().describe(
      "Days before the end date an origin certificate is reported; default 21.",
    ),
  });
  const tool: CheckTool<Params, typeof parameters> = {
    name: NAME,
    label: "TLS origin certificate",
    description: DESCRIPTION,
    loadMode: "discoverable",
    approval: "read",
    parameters,
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const host = hostOf(params.site);
      signal?.throwIfAborted();
      const origin = params.origin === undefined || params.origin === null ? undefined : originHost(params.origin);
      if (origin === undefined || origin === "") {
        return toolResult(answer(apexOf(params.site), CHECK, { unmeasured: NO_ORIGIN_REASON }));
      }
      const certificate = await withHeartbeat(onUpdate, `Reading the origin's TLS certificate for ${host} at ${origin}`, () =>
        collectSiteCertificate(params.site, deps.reader ?? systemCertificateReader, {
          origin,
          readEdge: false,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(signal === undefined ? {} : { signal }),
        }));
      return toolResult(answer(apexOf(params.site), CHECK, originVerdict(certificate, params.tls_warn_days ?? undefined)));
    },
  };
  return tool;
}
