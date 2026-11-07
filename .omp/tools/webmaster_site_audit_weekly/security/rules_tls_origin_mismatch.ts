import type { CertificatePart } from "./certificate";
import { securityFinding, type Verdict } from "./check";
import {
  agoText,
  type Collected,
  covers,
  DEFAULT_TLS_WARN_DAYS,
  endState,
  NO_CERTIFICATE_REASON,
} from "./tls_common";

export const CHECK = "webmaster.security.tls.origin_mismatch";
export const NO_ORIGIN_REASON = "no origin was named, so there is nothing to compare";

function problemsOf(
  origin: Exclude<CertificatePart, { status: "unmeasured" }>,
  host: string,
  now: string,
  warn: number,
): string[] {
  if (origin.status === "rejected") return [`it does not verify (${origin.authorization_error})`];
  const state = endState(now, origin.valid_to);
  return [
    ...covers(origin.subject_names, host) ? [] : [`it covers ${origin.subject_names.join(", ") || "no DNS names"}, not ${host}`],
    ...state.kind === "unreadable"
      ? [`its end date is unreadable (${origin.valid_to})`]
      : state.kind === "expired"
      ? [`it expired ${agoText(state.ago)}`]
      : state.left <= warn
      ? [`it expires in ${state.left} days`]
      : [],
  ];
}

/** The origin's certificate, when it would not serve the site's name validly. */
export function originVerdict(certificate: Collected, warnDays: number = DEFAULT_TLS_WARN_DAYS): Verdict {
  if (certificate === undefined) return { unmeasured: NO_CERTIFICATE_REASON };
  if (certificate.status !== "measured") return { unmeasured: certificate.reason };
  const { origin, host } = certificate;
  if (origin === undefined) return { unmeasured: NO_ORIGIN_REASON };
  if (origin.status === "unmeasured") return { unmeasured: origin.reason };
  const problems = problemsOf(origin, host, certificate.measured_at, warnDays);
  if (problems.length === 0) return [];
  return [securityFinding(
    "security.tls.origin_mismatch",
    "medium",
    `The origin behind the edge serves a different certificate for ${host}: ${problems.join(", ")}. `
      + "An edge that checks the origin strictly fails; one that does not hides the problem.",
    "Install a valid certificate for the site's name on the origin server.",
    "Renew the origin certificate with the edge's, and have the edge verify it strictly.",
  )];
}
