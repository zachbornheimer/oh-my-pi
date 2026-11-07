import { securityFinding, type Verdict } from "./check";
import { type Collected, EXPIRED_CODE, NO_CERTIFICATE_REASON } from "./tls_common";

export const CHECK = "webmaster.security.tls.trust";

/** The edge chain, when the handshake refused it for anything but expiry (an expired chain is the expiry check's finding). */
export function trustVerdict(certificate: Collected): Verdict {
  if (certificate === undefined) return { unmeasured: NO_CERTIFICATE_REASON };
  if (certificate.status !== "measured") return { unmeasured: certificate.reason };
  const { edge, host } = certificate;
  if (edge.status === "unmeasured") return { unmeasured: edge.reason };
  if (edge.status === "measured" || EXPIRED_CODE.test(edge.authorization_error)) return [];
  return [securityFinding(
    "security.tls.trust",
    "high",
    `The certificate for ${host} does not verify against public roots: ${edge.authorization_error}.`,
    "Serve a certificate from a public authority with its full chain.",
    "Check the chain the server sends after every renewal.",
  )];
}
