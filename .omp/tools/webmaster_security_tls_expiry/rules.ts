import { securityFinding, type Verdict } from "./check";
import {
  agoText,
  type Collected,
  DEFAULT_TLS_WARN_DAYS,
  endState,
  EXPIRED_CODE,
  NO_CERTIFICATE_REASON,
} from "./tls_common";

export const CHECK = "webmaster.security.tls.expiry";
/** At this many days left or fewer, an expiring certificate is high. */
export const CRITICAL_EXPIRY_DAYS = 7;

const RENEW = "Renew or reissue the certificate now.";
const AUTOMATE = "Automate renewal and alert well before the end date.";

/** The edge certificate, when it ended or ends within the warning days. */
export function expiryVerdict(certificate: Collected, warnDays: number = DEFAULT_TLS_WARN_DAYS): Verdict {
  if (certificate === undefined) return { unmeasured: NO_CERTIFICATE_REASON };
  const { edge, host, measured_at: now } = certificate;
  if (edge.status === "unmeasured") return { unmeasured: edge.reason };
  if (edge.status === "rejected") {
    if (!EXPIRED_CODE.test(edge.authorization_error)) {
      return {
        unmeasured: `the handshake refused the certificate (${edge.authorization_error}), so its end date is unknown`,
      };
    }
    return [securityFinding(
      "security.tls.expiry.expired",
      "high",
      `The certificate for ${host} has expired: the handshake refused it (${edge.authorization_error}). Browsers refuse the site.`,
      RENEW,
      AUTOMATE,
    )];
  }
  const state = endState(now, edge.valid_to);
  if (state.kind === "unreadable") return { unmeasured: `the certificate's end date is unreadable (${edge.valid_to})` };
  if (state.kind === "expired") {
    return [securityFinding(
      "security.tls.expiry.expired",
      "high",
      `The certificate for ${host} expired ${agoText(state.ago)} (${edge.valid_to}); browsers refuse the site.`,
      RENEW,
      AUTOMATE,
    )];
  }
  if (state.left > warnDays) return [];
  return [securityFinding(
    "security.tls.expiry.expiring",
    state.left <= CRITICAL_EXPIRY_DAYS ? "high" : "medium",
    `The certificate for ${host} expires in ${state.left} days (${edge.valid_to}, issuer ${edge.issuer}).`,
    "Renew the certificate now and check that automatic renewal works.",
    AUTOMATE,
  )];
}
