import { securityFinding, type Verdict } from "./check";
import { type Collected, covers, NO_CERTIFICATE_REASON } from "./tls_common";

export const CHECK = "webmaster.security.tls.hostname";

/** The edge certificate, when it does not name the host. */
export function hostnameVerdict(certificate: Collected): Verdict {
  if (certificate === undefined) return { unmeasured: NO_CERTIFICATE_REASON };
  const { edge, host } = certificate;
  if (edge.status === "unmeasured") return { unmeasured: edge.reason };
  if (edge.status === "rejected") {
    return {
      unmeasured: `the handshake refused the certificate (${edge.authorization_error}), so its names are unknown`,
    };
  }
  if (covers(edge.subject_names, host)) return [];
  const names = edge.subject_names.length > 0 ? edge.subject_names.join(", ") : "no DNS names";
  return [securityFinding(
    "security.tls.hostname",
    "high",
    `The certificate ${host} serves covers ${names}, not ${host}.`,
    "Issue a certificate that names the host, or point the name at the server that holds one.",
    "Add every served host name to the certificate.",
  )];
}
