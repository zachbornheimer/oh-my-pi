import { lookup as resolveName } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * The network the read-only HTTP webmaster tools read through: plain requests to public addresses, no redirect followed
 * unless asked. A name that resolves to loopback, a private range, link-local (cloud metadata) or similar is refused in
 * the connection's own name lookup, so the check covers the address the socket actually dials. Nothing here judges what
 * it reads. Port of Mastra's `security/public_fetch.ts`, `security/net.ts` and `security/http.ts`.
 */

const MAX_REDIRECTS = 5;

function ipv4Public(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The IPv4 address an IPv4-embedding IPv6 literal carries (`::ffff:a.b.c.d`, `::ffff:7f00:1`, `64:ff9b::a.b.c.d`), if any. */
function embeddedIpv4(lower: string): string | undefined {
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] === undefined || hex[2] === undefined) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** True when the literal address is routable on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Public(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  const embedded = embeddedIpv4(lower);
  if (embedded !== undefined) return ipv4Public(embedded);
  if (lower === "::" || lower === "::1") return false;
  return !/^(fc|fd|fe[89ab]|ff)/.test(lower);
}

const refusal = (host: string, address: string): Error => new Error(`${host} resolves to a non-public address (${address})`);

/** Decides which resolved addresses may be dialled; tests pass one that allows a local server. */
export type AddressPolicy = (address: string) => boolean;

function lookupWith(allowed: AddressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    resolveName(hostname, { ...options, all: true }, (error, found) => {
      if (error !== null) return callback(error, "", 0);
      const refused = found.find((entry) => !allowed(entry.address));
      if (refused !== undefined) {
        return callback(Object.assign(refusal(hostname, refused.address), { code: "EACCES" }), "", 0);
      }
      const first = found[0];
      if (first === undefined) {
        return callback(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" }), "", 0);
      }
      // Node asks for every address (`all`) when it races address families, and for one otherwise.
      if (options.all === true) return callback(null, found);
      return callback(null, first.address, first.family);
    });
  };
}

/**
 * The parsed address when it is an http(s) address without credentials; throws otherwise. A literal IP host is checked
 * here too, because a socket never looks a literal up.
 */
export function assertReadableUrl(raw: string, allowed: AddressPolicy = isPublicAddress): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${url.protocol} addresses are not read`);
  if (url.username !== "" || url.password !== "") throw new Error("addresses with credentials are not read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !allowed(host)) throw refusal(host, host);
  return url;
}

export interface PublicGetOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** The body is read up to this many characters; the rest is never downloaded. */
  readonly bodyCap: number;
  readonly signal?: AbortSignal;
  /** Which addresses may be dialled; public ones only by default. */
  readonly allowed?: AddressPolicy;
}

export interface PublicAnswer {
  readonly status: number;
  /** Lower-case names; repeated headers joined with a comma. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** One public request with no redirect followed: the answer carries the `location` it was redirected to, if any. */
export interface PublicHop extends PublicAnswer {
  readonly location?: string;
}

export interface PublicRequestOptions extends PublicGetOptions {
  readonly method: "GET" | "HEAD" | "POST";
  readonly requestBody?: string;
}

function exchange(url: URL, options: PublicRequestOptions, signal: AbortSignal): Promise<PublicHop> {
  const { promise, resolve, reject } = Promise.withResolvers<PublicHop>();
  const open = url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup = lookupWith(options.allowed ?? isPublicAddress);
  const req = open(url, { method: options.method, headers: { ...options.headers }, lookup, signal }, (res) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const status = res.statusCode ?? 0;
    const location = headers["location"];
    const answer = (body: string): PublicHop => ({
      status,
      headers,
      body: body.slice(0, options.bodyCap),
      ...(location === undefined ? {} : { location: new URL(location, url).toString() }),
    });
    if (options.method === "HEAD") {
      res.destroy();
      resolve(answer(""));
      return;
    }
    const decoder = new TextDecoder();
    let body = "";
    res.on("data", (chunk: Buffer) => {
      body += decoder.decode(chunk, { stream: true });
      if (body.length >= options.bodyCap) res.destroy();
    });
    res.on("close", () => resolve(answer(body)));
    res.on("error", () => resolve(answer(body)));
  });
  req.on("error", reject);
  req.end(options.requestBody);
  return promise;
}

const withTimeout = (options: PublicGetOptions): AbortSignal =>
  options.signal === undefined
    ? AbortSignal.timeout(options.timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal]);

/** One request to a public address; a redirect is reported, never followed. */
export async function publicRequest(raw: string, options: PublicRequestOptions): Promise<PublicHop> {
  return await exchange(assertReadableUrl(raw, options.allowed), options, withTimeout(options));
}

/** Reads one public address with a GET, following redirects itself so every hop is dialled through the address policy. */
export async function publicGet(raw: string, options: PublicGetOptions): Promise<PublicAnswer> {
  const signal = withTimeout(options);
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const answer = await exchange(assertReadableUrl(target, options.allowed), { ...options, method: "GET" }, signal);
    if (answer.location === undefined || answer.status < 300 || answer.status >= 400) {
      return { status: answer.status, headers: answer.headers, body: answer.body };
    }
    target = answer.location;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects from ${raw}`);
}

/** One answer, as the network gives it. */
export interface NetAnswer {
  readonly status: number;
  readonly location?: string;
  readonly contentType: string;
  readonly body: string;
}

export interface SecurityNet {
  request(method: "GET" | "HEAD" | "POST", url: string, body?: string, signal?: AbortSignal): Promise<NetAnswer>;
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs `work` over `items`, `limit` at a time, keeping their order. */
export async function inBatches<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return results;
}

/** The most characters of one response body an answer keeps; the probe stops reading there. */
export const ANSWER_BODY_CAP = 64_000;
const USER_AGENT = "capability-replicas-webmaster-security/1.0 (+read-only check)";
const REQUEST_TIMEOUT_MS = 15_000;

/** A network over the address policy: plain requests, no redirect followed. */
export function makeSecurityNet(allowed: AddressPolicy = isPublicAddress): SecurityNet {
  return {
    async request(method, url, body, signal) {
      const answer = await publicRequest(url, {
        method,
        headers: { "user-agent": USER_AGENT, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { requestBody: body }),
        timeoutMs: REQUEST_TIMEOUT_MS,
        bodyCap: ANSWER_BODY_CAP,
        allowed,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        status: answer.status,
        ...(answer.location === undefined ? {} : { location: answer.location }),
        contentType: answer.headers["content-type"] ?? "",
        body: answer.body,
      };
    },
  };
}

/** The real network: public addresses only, no redirect followed. */
export const systemSecurityNet: SecurityNet = makeSecurityNet();

/** One request a data tool sent and what came back. `status` 0 means no answer arrived; `error` says why. */
export interface HttpAnswer {
  method: "GET" | "HEAD" | "POST";
  /** The address asked: a path of the site (`/.env`), or an absolute address for another host. */
  path: string;
  status: number;
  location?: string;
  content_type: string;
  /** The start of the body, at most ANSWER_BODY_CAP characters, with secret-looking values redacted. */
  body: string;
  error?: string;
}

/** True for a 2xx answer. */
export const succeeded = (answer: Pick<HttpAnswer, "status">): boolean => answer.status >= 200 && answer.status < 300;

/** Secret-looking assignments (`DB_PASSWORD=...`, `define('AUTH_KEY', '...')`, `"api_token": "..."`), bounded so a long body scans in linear time. */
const SECRET_VALUE =
  /(?<![A-Za-z0-9_-])((?:[A-Za-z0-9_-]{0,40}(?:password|passwd|secret|token|api_?key|auth_?key|salt|private_?key))(?:['"]\s*,|['"]?\s*(?:=>|=|:))\s*['"]?)[^'"\s,;)<]+/gi;

/** The text with every secret-looking value replaced, so a kept body never carries a live credential. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE, "$1REDACTED");
}

/** The address a data tool asks: `https://` and the host as given, from a domain or an address. Throws on text that names no host. */
export function siteUrlOf(site: string): string {
  try {
    return new URL(site.includes("://") ? site : `https://${site}`).origin;
  } catch {
    throw new Error(`"${site}" is not a domain or address`);
  }
}

/** The apex domain a site's domain or address names: no scheme, path or leading `www.`. */
export function apexOf(site: string): string {
  const host = new URL(siteUrlOf(site)).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (host === "") throw new Error(`"${site}" names no host`);
  return host;
}

/** One request a data tool plans to send. */
export interface PlannedRequest {
  readonly method: "GET" | "HEAD" | "POST";
  /** A path of the site, or an absolute address. */
  readonly path: string;
  readonly body?: string;
  /** Follow one redirect within the site (`/feed/` -> `/feed`), so the page's own content is read. */
  readonly follow?: boolean;
}

function followed(planned: PlannedRequest, siteUrl: string, answer: NetAnswer): string | undefined {
  if (planned.follow !== true || answer.location === undefined) return undefined;
  if (answer.status < 300 || answer.status >= 400) return undefined;
  const target = new URL(answer.location, siteUrl);
  return target.origin === new URL(siteUrl).origin ? `${target.pathname}${target.search}` : undefined;
}

/**
 * Sends one planned request and records the answer, its body redacted and capped; `keep` decides whether the body is
 * kept at all. A request that got no answer is status 0 with the error; a cancelled run throws.
 */
export async function ask(
  net: SecurityNet,
  siteUrl: string,
  planned: PlannedRequest,
  keep: (answer: NetAnswer) => boolean = () => true,
  signal?: AbortSignal,
): Promise<HttpAnswer & { readonly raw?: NetAnswer }> {
  const recorded = { method: planned.method, path: planned.path };
  try {
    signal?.throwIfAborted();
    const first = await net.request(planned.method, new URL(planned.path, siteUrl).toString(), planned.body, signal);
    const next = followed(planned, siteUrl, first);
    const answer = next === undefined ? first : await net.request("GET", new URL(next, siteUrl).toString(), undefined, signal);
    return {
      ...recorded,
      ...(next === undefined ? {} : { path: next }),
      status: answer.status,
      ...(answer.location === undefined ? {} : { location: answer.location }),
      content_type: answer.contentType,
      body: keep(answer) ? redactSecrets(answer.body) : "",
      raw: answer,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...recorded, status: 0, content_type: "", body: "", error: describeError(error) };
  }
}

/** The answer without the raw network answer kept for classification. */
export const recorded = ({ raw: _raw, ...answer }: HttpAnswer & { readonly raw?: NetAnswer }): HttpAnswer => answer;
