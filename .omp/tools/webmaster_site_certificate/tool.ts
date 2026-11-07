import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  type CertificateReader,
  collectSiteCertificate,
  hostOf,
  originAddress,
  type SiteCertificateResult,
  systemCertificateReader,
} from "./certificate.ts";

/** Injected ports; the factory in index.ts uses the machine's own. */
export interface CertificateToolDeps {
  reader?: CertificateReader;
  now?: () => Date;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Collect the TLS certificate a site serves to visitors, and the origin server's certificate for the same host name when an origin address is given: validity end, covered names, issuer, whether the chain and name verified, and the SHA-256 fingerprint. "
  + "Use it for raw certificate facts; it never says whether a certificate is expired, expiring, wrong-named or untrusted. "
  + "Input: `{\"site\":\"example.org\"}` or `{\"site\":\"https://www.example.org/\",\"origin\":\"203.0.113.7\"}`. `site` is a domain or address (only its host is used); `origin` is a host name or IP reached on port 443 with the site's name as SNI. "
  + "Opens one TLS connection per certificate (port 443, 10 s limit), keeps chain verification on, replaces only the host-name check so a certificate for the wrong name is still read, and sends nothing on the connection. Read-only. "
  + "Result: `{site, certificate}` where `certificate.edge` (and `origin`) is `measured` with fields, `rejected` with the verification error (such as `CERT_HAS_EXPIRED`) when the chain was refused, or `unmeasured` with why. "
  + "A failed handshake is data, never an exception; an unparsable `site` is refused.";

export function makeTool(pi: Pi, deps: CertificateToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_site_certificate",
    label: "Site TLS certificate",
    description: DESCRIPTION,
    parameters: z.object({
      site: z.string().min(1).describe("Domain or address, such as `example.org` or `https://www.example.org/`; only the host is used."),
      origin: z.string().min(1).nullable().optional().describe(
        "Origin server host name or IP when an edge fronts the site; its certificate is read for the same name. Omit to read only the edge.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { site: string; origin?: string | null },
      _onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const host = hostOf(params.site);
      const origin = params.origin == null ? undefined : originAddress(params.origin);
      const certificate = await collectSiteCertificate(params.site, deps.reader ?? systemCertificateReader, {
        ...(origin === undefined ? {} : { origin }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(signal === undefined ? {} : { signal }),
      });
      const result: SiteCertificateResult = { site: host, certificate };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
