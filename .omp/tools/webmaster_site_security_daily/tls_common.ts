import type { SiteCertificate } from "./certificate";

export const NO_CERTIFICATE_REASON = "no certificate was collected for this site";
/** Days before a certificate ends that it is reported, unless the caller says otherwise. */
export const DEFAULT_TLS_WARN_DAYS = 21;
const DAY_MS = 86_400_000;
/** A chain the handshake refused as expired is expired, whatever its dates say. */
export const EXPIRED_CODE = /EXPIRED/i;

/** A collection that could not read the certificates at all (not one handshake: that is a `CertificatePart`). */
export interface UnmeasuredCertificate {
  status: "unmeasured";
  reason: string;
}

/** The certificate collected, or why there is none: the shape every TLS rule starts from. */
export type Collected = SiteCertificate | UnmeasuredCertificate | undefined;

export const dayCount = (days: number): string => (days === 1 ? "1 day" : `${days} days`);

/**
 * Where `end` stands against `now`. `left` counts days to the end, rounded up (a certificate with 18 days and an hour
 * left has 19), and is only set while the certificate is still valid. `ago` counts whole days since it ended, 0 for
 * under a day. A date that does not parse is `unreadable`: it is never treated as valid.
 */
export type EndState =
  | { kind: "valid"; left: number }
  | { kind: "expired"; ago: number }
  | { kind: "unreadable" };

export function endState(now: string, end: string): EndState {
  const ms = Date.parse(end) - Date.parse(now);
  if (Number.isNaN(ms)) return { kind: "unreadable" };
  return ms >= 0 ? { kind: "valid", left: Math.ceil(ms / DAY_MS) } : { kind: "expired", ago: Math.floor(-ms / DAY_MS) };
}

/** How long ago a certificate ended, in words. */
export const agoText = (ago: number): string => (ago === 0 ? "less than a day ago" : `${dayCount(ago)} ago`);

/** Whether a certificate's names cover `host`; a wildcard covers exactly one label. */
export function covers(names: readonly string[], host: string): boolean {
  const wanted = host.toLowerCase();
  return names.some((name) => {
    const lower = name.toLowerCase();
    if (lower === wanted) return true;
    if (!lower.startsWith("*.")) return false;
    const suffix = lower.slice(1);
    return wanted.endsWith(suffix) && wanted.length > suffix.length && !wanted.slice(0, -suffix.length).includes(".");
  });
}
