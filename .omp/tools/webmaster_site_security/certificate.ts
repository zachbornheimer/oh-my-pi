import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";
import { hostOf } from "./check";

/** One certificate a server presented. */
export interface Certificate {
  /** ISO time the certificate stops being valid. */
  valid_to: string;
  /** DNS names the certificate covers (subject alternative names, else the common name). */
  subject_names: string[];
  issuer: string;
  /** Whether the certificate covers the host name it was asked for. */
  authorized: boolean;
  /** Why it does not cover the host name, such as `ERR_TLS_CERT_ALTNAME_INVALID`. */
  authorization_error?: string;
  fingerprint256: string;
}

/**
 * One handshake's outcome: `measured` (a certificate was read), `rejected` (the handshake refused the chain, so its
 * fields could not be read) or `unmeasured` (the connection failed).
 */
export type CertificatePart =
  | ({ status: "measured" } & Certificate)
  | { status: "rejected"; authorization_error: string }
  | { status: "unmeasured"; reason: string };

/** What the certificate collector found: the part a visitor receives and, when an origin was named, the origin's. */
export interface SiteCertificate {
  status: "measured";
  /** When the handshake ran, ISO; days left are counted from here. */
  measured_at: string;
  /** The host name asked for. */
  host: string;
  edge: CertificatePart;
  origin?: CertificatePart;
}

/** Reads the certificate a host serves, connecting to `address` (an origin) when given. Rejects when the handshake fails. */
export interface CertificateReader {
  /** The port connected to; 443 when absent. */
  readonly port?: number;
  read(host: string, address?: string, signal?: AbortSignal): Promise<Certificate>;
}

/** The handshake refused the certificate because its chain did not verify; `code` is the verification error. */
export class CertificateRejected extends Error {
  constructor(readonly code: string) {
    super(`the certificate did not verify: ${code}`);
    this.name = "CertificateRejected";
  }
}

export const TLS_PORT = 443;
export const TLS_TIMEOUT_MS = 10_000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function part(
  host: string,
  address: string | undefined,
  reader: CertificateReader,
  signal: AbortSignal | undefined,
): Promise<CertificatePart> {
  try {
    return { status: "measured", ...await reader.read(host, address, signal) };
  } catch (error) {
    if (error instanceof CertificateRejected) return { status: "rejected", authorization_error: error.code };
    if (signal?.aborted) throw error;
    return { status: "unmeasured", reason: `${address ?? host}:${reader.port ?? TLS_PORT}: ${messageOf(error)}` };
  }
}

export const EDGE_NOT_READ = "the edge certificate was not read: only the origin was asked for";

export interface CollectOptions {
  /** The origin server's address, when an edge fronts the site. */
  readonly origin?: string;
  /** False reads only the origin: no connection is made to the site itself. */
  readonly readEdge?: boolean;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/**
 * The certificates a site serves: the one a visitor receives and, when an origin is named, the origin's for the same
 * name. Collects only; it never says whether a certificate is good. A failed handshake is kept as data; only an abort
 * throws.
 */
export async function collectSiteCertificate(
  site: string,
  reader: CertificateReader,
  options: CollectOptions = {},
): Promise<SiteCertificate> {
  const host = hostOf(site);
  const [edge, origin] = await Promise.all([
    options.readEdge === false
      ? Promise.resolve<CertificatePart>({ status: "unmeasured", reason: EDGE_NOT_READ })
      : part(host, undefined, reader, options.signal),
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
  const alternative = certificate.subjectaltname?.split(",").map((entry) => entry.trim()).filter((entry) =>
    entry.startsWith("DNS:")
  ).map((entry) => entry.slice("DNS:".length));
  if (alternative !== undefined && alternative.length > 0) return alternative;
  const common = certificate.subject?.CN;
  return typeof common === "string" ? [common] : [];
}

export interface ReaderOptions {
  /** The port to connect to; 443 by default. */
  readonly port?: number;
  /** Milliseconds the server may stay silent before the handshake is abandoned; 10 000 by default. */
  readonly timeoutMs?: number;
  /** Trusted roots instead of the system's (tests trust a local server's own certificate). */
  readonly ca?: string | Buffer;
}

function handshake(host: string, address: string, options: ReaderOptions, signal?: AbortSignal): Promise<Certificate> {
  const port = options.port ?? TLS_PORT;
  const timeoutMs = options.timeoutMs ?? TLS_TIMEOUT_MS;
  const { promise, resolve, reject } = Promise.withResolvers<Certificate>();
  // The chain is verified as usual; a chain that fails ends the handshake, reported as CertificateRejected. The host
  // name check alone is replaced on this one socket, so a certificate for the wrong name is still read and recorded
  // (`authorization_error`) rather than refused. Nothing is sent on this socket; it closes after the handshake.
  let nameError: (Error & { code?: string }) | undefined;
  const socket = connect({
    host: address,
    port,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    servername: host,
    checkServerIdentity: (name, certificate) => {
      nameError = checkServerIdentity(name, certificate);
      return undefined;
    },
  });
  const onAbort = () => socket.destroy(new Error("cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.once("close", () => signal?.removeEventListener("abort", onAbort));
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no TLS answer within ${timeoutMs} ms`)));
  socket.once("error", (error: Error & { code?: string }) => {
    reject(error.code !== undefined && VERIFY_ERROR.test(error.code) ? new CertificateRejected(error.code) : error);
  });
  socket.once("secureConnect", () => {
    const peer = socket.getPeerCertificate();
    socket.end();
    if (peer.valid_to === undefined) {
      reject(new Error("the server sent no certificate"));
      return;
    }
    const validTo = new Date(peer.valid_to);
    if (Number.isNaN(validTo.getTime())) {
      reject(new Error(`the certificate's end date is unreadable: ${peer.valid_to}`));
      return;
    }
    const issuer = peer.issuer?.O ?? peer.issuer?.CN;
    const nameCode = nameError?.code ?? nameError?.message;
    resolve({
      valid_to: validTo.toISOString(),
      subject_names: namesOf(peer),
      issuer: typeof issuer === "string" ? issuer : "unknown",
      authorized: nameError === undefined,
      ...(nameCode === undefined ? {} : { authorization_error: nameCode }),
      fingerprint256: peer.fingerprint256,
    });
  });
  return promise;
}

/** A TLS client over `node:tls`. It sends nothing on the connection and closes it after the handshake. */
export const createCertificateReader = (options: ReaderOptions = {}): CertificateReader => ({
  ...(options.port === undefined ? {} : { port: options.port }),
  read: (host, address, signal) => handshake(host, address ?? host, options, signal),
});

/** The machine's own TLS client: port 443, the system's trusted roots. */
export const systemCertificateReader: CertificateReader = createCertificateReader();
