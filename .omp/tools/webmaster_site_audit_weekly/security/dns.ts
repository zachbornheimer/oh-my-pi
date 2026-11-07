import { randomUUID } from "node:crypto";
import { promises as nodeDns } from "node:dns";

/**
 * A site's raw DNS: A, AAAA, the CNAME chain, MX, NS and TXT for the apex, www, each common subdomain that answers,
 * and the MX and NS hosts the apex names. Collects only; it never says what the records mean. Port of Mastra's
 * `webmaster.site.dns` resolver, collector and system resolver.
 */

/** Why a hostname is in the collection. */
export const DNS_NAME_ROLES = ["apex", "www", "subdomain", "mx", "ns"] as const;
export type DnsNameRole = (typeof DNS_NAME_ROLES)[number];

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** Every raw record one hostname answered with. Empty arrays mean "no record", `error` means "no answer". */
export interface DnsName {
  name: string;
  role: DnsNameRole;
  a: string[];
  aaaa: string[];
  cname: string[];
  mx: MxRecord[];
  ns: string[];
  txt: string[];
  nxdomain?: boolean;
  wildcard?: boolean;
  error?: string;
}

export interface WildcardAnswer {
  a: string[];
  aaaa: string[];
  cname: string[];
}

export interface SiteDnsResult {
  site: string;
  wildcard?: WildcardAnswer;
  names: DnsName[];
}

/** The name does not exist at all (NXDOMAIN), as opposed to existing with no record of the kind asked. */
export class NameNotFound extends Error {
  constructor(readonly name: string) {
    super(`${name} does not exist`);
    this.name = "NameNotFound";
  }
}

/**
 * The lookups the collector needs. Each resolves to [] when the name has no such record and rejects on a failed lookup;
 * `a` and `aaaa` reject with `NameNotFound` when the name does not exist.
 */
export interface DnsResolver {
  a(name: string): Promise<readonly string[]>;
  aaaa(name: string): Promise<readonly string[]>;
  /** The name's own CNAME target(s), one hop. */
  cname(name: string): Promise<readonly string[]>;
  mx(name: string): Promise<readonly MxRecord[]>;
  ns(name: string): Promise<readonly string[]>;
  txt(name: string): Promise<readonly string[]>;
}

/** Subdomains looked for when the caller names none: the usual places a site's other copies and services live. */
export const DEFAULT_SUBDOMAINS = ["shop", "store", "blog", "app", "staging", "dev", "test", "mail", "webmail"] as const;
/** CNAME hops followed before the chain is cut off. */
export const MAX_CNAME_HOPS = 8;
/** The most subdomain labels one call looks up. */
export const MAX_SUBDOMAINS = 50;
/** The most MX hosts and the most NS hosts the apex names that are looked up. */
export const MAX_SERVER_HOSTS = 25;

const TRAILING_DOT = /\.$/;
const LEADING_WWW = /^www\./;
/** One or more DNS labels (letters, digits, `_`, `-`), so a label such as `s1._domainkey` is allowed and a path or host is not. */
const SUBDOMAIN_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

const bare = (name: string): string => name.toLowerCase().replace(TRAILING_DOT, "");

/** The apex domain a site's domain or address names: no scheme, path or leading `www.`. Throws on text that names no host. */
export function apexOf(site: string): string {
  let host: string;
  try {
    host = new URL(site.includes("://") ? site : `https://${site}`).hostname;
  } catch {
    throw new Error(`"${site}" is not a domain or address`);
  }
  const apex = bare(host).replace(LEADING_WWW, "");
  if (apex === "") throw new Error(`"${site}" names no host`);
  return apex;
}

/** The labels as DNS names: lower-cased, trailing dots dropped; anything that is not one or more DNS labels is refused. */
export function validatedSubdomains(labels: readonly string[], max: number = MAX_SUBDOMAINS): string[] {
  const clean = [...new Set(labels.map(bare))];
  const bad = clean.find((label) => !SUBDOMAIN_LABEL.test(label));
  if (bad !== undefined) throw new Error(`"${bad}" is not a subdomain label (letters, digits, "-" and "_", dot-separated)`);
  if (clean.length > max) throw new Error(`at most ${max} subdomains per call, got ${clean.length}`);
  return clean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function chainOf(name: string, resolver: DnsResolver): Promise<{ chain: string[]; end: string; error?: string }> {
  const chain: string[] = [];
  const seen = new Set([name]);
  let current = name;
  for (let hop = 0; hop < MAX_CNAME_HOPS; hop++) {
    const [next] = await resolver.cname(current);
    if (next === undefined) return { chain, end: current };
    const target = bare(next);
    chain.push(target);
    if (seen.has(target)) return { chain, end: current, error: `CNAME loop at ${target}` };
    seen.add(target);
    current = target;
  }
  return { chain, end: current, error: `CNAME chain longer than ${MAX_CNAME_HOPS} hops` };
}

const settled = async <T>(
  lookup: Promise<readonly T[]>,
  errors: string[],
  kind: string,
  onMissing: () => void = () => undefined,
): Promise<T[]> => {
  try {
    return [...(await lookup)];
  } catch (error) {
    if (error instanceof NameNotFound) onMissing();
    else errors.push(`${kind}: ${messageOf(error)}`);
    return [];
  }
};

/** Every record one hostname answers with. Never throws: a failed lookup is kept as `error`. */
export async function collectName(name: string, role: DnsNameRole, resolver: DnsResolver): Promise<DnsName> {
  const errors: string[] = [];
  let chain: { chain: string[]; end: string; error?: string } = { chain: [], end: name };
  try {
    chain = await chainOf(name, resolver);
  } catch (error) {
    errors.push(`CNAME: ${messageOf(error)}`);
  }
  if (chain.error !== undefined) errors.push(chain.error);
  let missing = false;
  const markMissing = () => {
    missing = true;
  };
  const [a, aaaa, mx, ns, txt] = await Promise.all([
    settled(resolver.a(chain.end), errors, "A", markMissing),
    settled(resolver.aaaa(chain.end), errors, "AAAA", markMissing),
    settled(resolver.mx(name), errors, "MX"),
    settled(resolver.ns(name), errors, "NS"),
    settled(resolver.txt(name), errors, "TXT"),
  ]);
  // An address query answers ENOTFOUND both for a name that does not exist and for one that holds only other
  // records, so a target that is TXT alone (every DKIM selector is) looks absent to A and AAAA. The name does not
  // exist only when nothing at all answered for it.
  const absent = missing && [a, aaaa, mx, ns, txt].every((records) => records.length === 0);
  return {
    name,
    role,
    a,
    aaaa,
    cname: chain.chain,
    mx: mx.map((record) => ({ exchange: bare(record.exchange), priority: record.priority })),
    ns: ns.map(bare),
    txt,
    ...(absent ? { nxdomain: true } : {}),
    ...(errors.length === 0 ? {} : { error: errors.join("; ") }),
  };
}

const answered = (entry: DnsName): boolean =>
  entry.error !== undefined || [entry.a, entry.aaaa, entry.cname, entry.mx, entry.ns, entry.txt].some((records) => records.length > 0);

export interface CollectOptions {
  readonly subdomains?: readonly string[];
  /** The most subdomain labels one call may look up; `MAX_SUBDOMAINS` by default. The security run asks for more (DKIM selectors). */
  readonly maxSubdomains?: number;
  /** The made-up label looked up to see whether the zone has a wildcard record; random by default. */
  readonly wildcardLabel?: string;
  readonly signal?: AbortSignal;
}

const sameAddresses = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && [...one].sort().join() === [...other].sort().join();

/**
 * The raw DNS of a site: apex and www always, then each subdomain that answered with anything, then the MX and NS
 * hosts the apex names. Collects only; it never says what the records mean. A cancelled run throws.
 */
export async function collectSiteDns(
  site: string,
  resolver: DnsResolver,
  options: CollectOptions = {},
): Promise<SiteDnsResult> {
  const apex = apexOf(site);
  const labels = validatedSubdomains(options.subdomains ?? DEFAULT_SUBDOMAINS, options.maxSubdomains).filter((label) => label !== "www");
  const probe = options.wildcardLabel ?? `zz-nx-${randomUUID().slice(0, 8)}`;
  options.signal?.throwIfAborted();
  const [apexEntry, wwwEntry, probed, ...subdomains] = await Promise.all([
    collectName(apex, "apex", resolver),
    collectName(`www.${apex}`, "www", resolver),
    collectName(`${probe}.${apex}`, "subdomain", resolver),
    ...labels.map((label) => collectName(`${label}.${apex}`, "subdomain", resolver)),
  ]);
  options.signal?.throwIfAborted();
  const wildcard =
    probed!.a.length + probed!.aaaa.length + probed!.cname.length > 0
      ? { a: probed!.a, aaaa: probed!.aaaa, cname: probed!.cname }
      : undefined;
  const fromWildcard = (entry: DnsName): boolean =>
    wildcard !== undefined &&
    sameAddresses(entry.a, wildcard.a) &&
    sameAddresses(entry.aaaa, wildcard.aaaa) &&
    entry.cname.length === wildcard.cname.length;
  const found = subdomains.filter(answered).map((entry) => (fromWildcard(entry) ? { ...entry, wildcard: true } : entry));
  const names: DnsName[] = [apexEntry!, wwwEntry!, ...found];
  const listed = new Set(names.map((entry) => entry.name));
  const servers = (hosts: readonly string[], role: DnsNameRole): Promise<DnsName>[] =>
    [...new Set(hosts)]
      // A null MX (RFC 7505, `0 .`) names no host: its exchange is empty and there is nothing to look up.
      .filter((host) => host !== "" && !listed.has(host))
      .slice(0, MAX_SERVER_HOSTS)
      .map((host) => collectName(host, role, resolver));
  const mxHosts = await Promise.all(servers(apexEntry!.mx.map((record) => record.exchange), "mx"));
  for (const entry of mxHosts) listed.add(entry.name);
  const nsHosts = await Promise.all(servers(apexEntry!.ns, "ns"));
  options.signal?.throwIfAborted();
  return { site: apex, ...(wildcard === undefined ? {} : { wildcard }), names: [...names, ...mxHosts, ...nsHosts] };
}

/** Answers that mean "this name has no such record", not "the lookup failed". */
const NO_RECORD_CODES = new Set(["ENODATA", "ENOTFOUND"]);

async function orNone<T>(lookup: Promise<T[]>): Promise<T[]> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof Error && "code" in error && NO_RECORD_CODES.has(String(error.code))) return [];
    throw error;
  }
}

/** An address lookup: a name that does not exist is `NameNotFound`, one that exists with no address is empty. */
async function addressesOf(name: string, lookup: Promise<string[]>): Promise<string[]> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTFOUND") throw new NameNotFound(name);
    return orNone(Promise.reject(error));
  }
}

/** The machine's own resolver (`node:dns` resolve*, which queries the configured nameservers and sends no other traffic). */
// Each member is async so a synchronous throw of `node:dns` (it rejects an empty name by throwing) is a rejected lookup.
export const systemResolver: DnsResolver = {
  a: async (name) => addressesOf(name, nodeDns.resolve4(name)),
  aaaa: async (name) => addressesOf(name, nodeDns.resolve6(name)),
  cname: async (name) => orNone(nodeDns.resolveCname(name)),
  mx: async (name) => orNone(nodeDns.resolveMx(name)),
  ns: async (name) => orNone(nodeDns.resolveNs(name)),
  txt: async (name) => (await orNone(nodeDns.resolveTxt(name))).map((parts) => parts.join("")),
};
