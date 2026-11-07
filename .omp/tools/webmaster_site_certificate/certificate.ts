import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";

/**
 * What a site's TLS certificates look like to a visitor and (optionally) to its origin. Collects only: it never says
 * whether a certificate is good. Port of Mastra's `webmaster.site.certificate` reader, collector and system TLS client.
 */

export interface Certificate {
  valid_to: string;
  subject_names: string[];
  issuer: string;
  authorized: boolean;
  authorization_error?: string;
  fingerprint256: string;
}

export type CertificatePart =
  | ({ status: "measured" } & Certificate)
  | { status: "rejected"; authorization_error: string }
  | { status: "unmeasured"; reason: string };

export interface SiteCertificate {
  status: "measured";
  measured_at: string;
  host: string;
  edge: CertificatePart;
  origin?: CertificatePart;
}

export interface SiteCertificateResult {
  site: string;
  certificate: SiteCertificate;
}

/** Reads the certificate a host serves, connecting to `address` (an origin) when given. Rejects when the handshake fails. */
export interface CertificateReader {
  read(host: string, address?: string, signal?: AbortSignal): Promise<Certificate>;
}

/** The handshake refused the certificate because its chain did not verify; `code` is the verification error. */
export class CertificateRejected extends Error {
  constructor(readonly code: string) {
    super(`the certificate did not verify: ${code}`);
    this.name = "CertificateRejected";
  }
}

const TLS_PORT = 443;
const TLS_TIMEOUT_MS = 10_000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The host a site address names: no scheme, path or port. Throws on text that is not a host or address. */
export function hostOf(site: string): string {
  let url: URL;
  try {
    url = new URL(site.includes("://") ? site : `https://${site}`);
  } catch {
    throw new Error(`"${site}" is not a domain or address`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") throw new Error(`"${site}" names no host`);
  return host;
}

/** An origin given as a host name or IP; a scheme, path or port the caller typed is dropped (the port is always 443). */
export function originAddress(origin: string): string {
  const text = origin.trim();
  if (!text.includes("://") && !text.includes("/") && !/^[^:]+:\d+$/.test(text)) {
    // A bare IPv6 literal contains colons; a host name or IPv4 address does not.
    return text.replace(/^\[|\]$/g, "");
  }
  return hostOf(text);
}

async function part(
  host: string,
  address: string | undefined,
  reader: CertificateReader,
  signal: AbortSignal | undefined,
): Promise<CertificatePart> {
  try {
    return { status: "measured", ...(await reader.read(host, address, signal)) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CertificateRejected) return { status: "rejected", authorization_error: error.code };
    return { status: "unmeasured", reason: `${address ?? host}:${TLS_PORT}: ${messageOf(error)}` };
  }
}

export interface CollectOptions {
  /** The origin server's address, when an edge fronts the site. */
  readonly origin?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/**
 * The certificates a site serves: the one a visitor receives and, when an origin is named, the origin's for the same
 * name. Never throws for a failed handshake (it is kept as data); a cancelled run throws.
 */
export async function collectSiteCertificate(
  site: string,
  reader: CertificateReader,
  options: CollectOptions = {},
): Promise<SiteCertificate> {
  const host = hostOf(site);
  const [edge, origin] = await Promise.all([
    part(host, undefined, reader, options.signal),
    options.origin === undefined ? Promise.resolve(undefined) : part(host, options.origin, reader, options.signal),
  ]);
  return {
    status: "measured",
    measured_at: (options.now?.() ?? new Date()).toISOString(),
    host,
    edge,
    ...(origin === undefined ? {} : { origin }),
  };
}

/** OpenSSL verification error codes, as Node names them; a handshake refused with one is a rejected certificate. */
const VERIFY_ERROR =
  /^(CERT_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_(GET|VERIFY|DECRYPT|DECODE)|INVALID_CA|PATH_LENGTH)/;

function namesOf(certificate: PeerCertificate): string[] {
  const alternative = certificate.subjectaltname
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice("DNS:".length));
  if (alternative !== undefined && alternative.length > 0) return alternative;
  const common = certificate.subject?.CN;
  return typeof common === "string" ? [common] : [];
}

function handshake(
  host: string,
  address: string,
  port: number,
  signal: AbortSignal | undefined,
  ca?: string,
): Promise<Certificate> {
  const { promise, resolve, reject } = Promise.withResolvers<Certificate>();
  // The chain is verified as usual; a chain that fails ends the handshake, reported as CertificateRejected. Only the
  // host name check is replaced on this one socket, so a certificate for the wrong name is still read and recorded
  // (`authorization_error`) rather than refused. Nothing is sent; the socket closes after the handshake.
  let nameError: (Error & { code?: string }) | undefined;
  const socket = connect({
    host: address,
    port,
    servername: host,
    ...(ca === undefined ? {} : { ca }),
    checkServerIdentity: (name, certificate) => {
      nameError = checkServerIdentity(name, certificate);
      return undefined;
    },
  });
  const onAbort = () => socket.destroy(new Error("cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener("abort", onAbort);
  socket.setTimeout(TLS_TIMEOUT_MS, () => socket.destroy(new Error(`no TLS answer within ${TLS_TIMEOUT_MS} ms`)));
  socket.once("error", (error: Error & { code?: string }) => {
    cleanup();
    reject(error.code !== undefined && VERIFY_ERROR.test(error.code) ? new CertificateRejected(error.code) : error);
  });
  socket.once("secureConnect", () => {
    cleanup();
    const peer = socket.getPeerCertificate();
    socket.end();
    if (peer.valid_to === undefined) {
      reject(new Error("the server sent no certificate"));
      return;
    }
    const issuer = peer.issuer?.O ?? peer.issuer?.CN;
    const nameCode = nameError?.code ?? nameError?.message;
    resolve({
      valid_to: new Date(peer.valid_to).toISOString(),
      subject_names: namesOf(peer),
      issuer: typeof issuer === "string" ? issuer : "unknown",
      authorized: nameError === undefined,
      ...(nameCode === undefined ? {} : { authorization_error: nameCode }),
      fingerprint256: peer.fingerprint256,
    });
  });
  return promise;
}

/** The machine's own TLS client on port 443. */
export const systemCertificateReader: CertificateReader = {
  read: (host, address, signal) => handshake(host, address ?? host, TLS_PORT, signal),
};

/** A TLS client that always connects to 127.0.0.1 on `port`, trusting `ca` when given. The real tool never uses it; tests aim it at a local server. */
export const certificateReaderOnPort = (port: number, ca?: string): CertificateReader => ({
  read: (host, _address, signal) => handshake(host, "127.0.0.1", port, signal, ca),
});
