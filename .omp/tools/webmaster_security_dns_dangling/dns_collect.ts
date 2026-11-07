import { randomUUID } from "node:crypto";
import { apexOf } from "./check";
import { type DnsResolver, type MxRecord, NameNotFound } from "./resolver";

/** Why a hostname is in the collection: the site itself, its www, a found subdomain, or a mail or name server it names. */
export type DnsNameRole = "apex" | "www" | "subdomain" | "mx" | "ns";

/** Every raw record one hostname answered with. Empty arrays mean "no record", `error` means "no answer". */
export interface DnsName {
  name: string;
  role: DnsNameRole;
  /** IPv4 addresses, after following the CNAME chain. */
  a: string[];
  /** IPv6 addresses, after following the CNAME chain. */
  aaaa: string[];
  /** The CNAME chain in order, first hop first; empty when the name has none. */
  cname: string[];
  mx: MxRecord[];
  ns: string[];
  txt: string[];
  /** The name, or the name its CNAME chain ends at, does not exist (NXDOMAIN). */
  nxdomain?: boolean;
  /** The zone's wildcard record gives this name its answer: a made-up label answers the same. */
  wildcard?: boolean;
  /** Why a lookup gave no answer (SERVFAIL, timeout, CNAME loop). */
  error?: string;
}

export interface WildcardAnswer {
  a: string[];
  aaaa: string[];
  cname: string[];
}

export interface SiteDns {
  site: string;
  wildcard?: WildcardAnswer;
  names: DnsName[];
}

/** Subdomains looked for when the caller names none: the usual places a site's other copies and services live. */
export const DEFAULT_SUBDOMAINS = [
  "shop",
  "store",
  "blog",
  "app",
  "staging",
  "dev",
  "test",
  "mail",
  "webmail",
] as const;
/** CNAME hops followed before the chain is cut off. */
export const MAX_CNAME_HOPS = 8;

const TRAILING_DOT = /\.$/;
const bare = (name: string): string => name.toLowerCase().replace(TRAILING_DOT, "");
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
    return [...await lookup];
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
  // records, so a target that is TXT alone looks absent to A and AAAA. The name does not exist only when nothing at
  // all answered for it.
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
  entry.error !== undefined
  || [entry.a, entry.aaaa, entry.cname, entry.mx, entry.ns, entry.txt].some((records) => records.length > 0);

export interface CollectOptions {
  readonly subdomains?: readonly string[];
  /** The made-up label looked up to see whether the zone has a wildcard record; random by default. */
  readonly wildcardLabel?: string;
}

const sameAddresses = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && [...one].sort().join() === [...other].sort().join();

/**
 * The raw DNS of a site: apex and www always, then each subdomain that answered with anything, then the MX and NS
 * hosts the apex names. Collects only; it never says what the records mean.
 */
export async function collectSiteDns(
  site: string,
  resolver: DnsResolver,
  options: CollectOptions = {},
): Promise<SiteDns> {
  const apex = apexOf(site);
  const labels = [...new Set(options.subdomains ?? DEFAULT_SUBDOMAINS)]
    .map((label) => bare(label))
    .filter((label) => label !== "" && label !== "www");
  const probe = options.wildcardLabel ?? `zz-nx-${randomUUID().slice(0, 8)}`;
  const [apexEntry, wwwEntry, probed, ...subdomains] = await Promise.all([
    collectName(apex, "apex", resolver),
    collectName(`www.${apex}`, "www", resolver),
    collectName(`${probe}.${apex}`, "subdomain", resolver),
    ...labels.map((label) => collectName(`${label}.${apex}`, "subdomain", resolver)),
  ]);
  const wildcard = probed!.a.length + probed!.aaaa.length + probed!.cname.length > 0
    ? { a: probed!.a, aaaa: probed!.aaaa, cname: probed!.cname }
    : undefined;
  const fromWildcard = (entry: DnsName): boolean =>
    wildcard !== undefined
    && sameAddresses(entry.a, wildcard.a)
    && sameAddresses(entry.aaaa, wildcard.aaaa)
    && entry.cname.length === wildcard.cname.length;
  const found = subdomains.filter(answered).map((entry) => (fromWildcard(entry) ? { ...entry, wildcard: true } : entry));
  const names: DnsName[] = [apexEntry!, wwwEntry!, ...found];
  const listed = new Set(names.map((entry) => entry.name));
  // A null MX (RFC 7505, `0 .`) names no host, so there is nothing to look up for it.
  const servers = (hosts: readonly string[], role: DnsNameRole): Promise<DnsName>[] =>
    [...new Set(hosts)].filter((host) => host !== "" && !listed.has(host)).map((host) => collectName(host, role, resolver));
  const mxHosts = await Promise.all(servers(apexEntry!.mx.map((record) => record.exchange), "mx"));
  for (const entry of mxHosts) listed.add(entry.name);
  const nsHosts = await Promise.all(servers(apexEntry!.ns, "ns"));
  return { site: apex, ...(wildcard === undefined ? {} : { wildcard }), names: [...names, ...mxHosts, ...nsHosts] };
}
