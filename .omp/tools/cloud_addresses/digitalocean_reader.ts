import type { AddressObservation, CloudFetch } from "./types.ts";

/**
 * What the owner's DigitalOcean account holds, read from the API with `DIGITALOCEAN_TOKEN`. Every call is a read: the
 * reserved IPs, the droplets, and, when the token may read it, the account's own name. Without the token nothing is
 * read and the source says so, because an unread account cannot support a claim that no address of ours sits there.
 */

export const DIGITALOCEAN_API_VARIABLE = "DIGITALOCEAN_TOKEN";
export const DIGITALOCEAN_API = "https://api.digitalocean.com/v2";
/** One page of a list endpoint; the API caps it at 200. */
const PER_PAGE = 200;
const TIMEOUT_MS = 30_000;
/** The most characters of one page that is accepted; a page of 200 records is far smaller. */
const BODY_CAP = 5_000_000;
const MAX_PAGES = 100;

/** The real network. Redirects are never followed: the bearer token goes to api.digitalocean.com and nowhere else. */
export const networkFetch: CloudFetch = (url, init) => {
  if (!url.startsWith(`${DIGITALOCEAN_API}/`)) throw new Error(`refusing to send the DigitalOcean token outside ${DIGITALOCEAN_API}`);
  return fetch(`https://api.digitalocean.com/v2/${url.slice(DIGITALOCEAN_API.length + 1)}`, {
    headers: init.headers,
    signal: init.signal,
    redirect: "manual",
  });
};

export interface DigitalOceanRead {
  readonly name: string;
  readonly account?: string;
  readonly observations: readonly AddressObservation[];
  readonly unread?: string;
}

type Fetched = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly reason: string };

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** One list page, or why the API refused it. An abort of the whole call is rethrown, not recorded as coverage. */
async function getJson(fetchImpl: CloudFetch, url: string, token: string, signal?: AbortSignal): Promise<Fetched> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `${response.status}: ${firstLine(text)}` };
    if (text.length > BODY_CAP) return { ok: false, reason: `answer larger than ${BODY_CAP} characters` };
    const body = JSON.parse(text) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, reason: "DigitalOcean did not answer with a JSON object" };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch (error) {
    signal?.throwIfAborted();
    return { ok: false, reason: firstLine(error instanceof Error ? error.message : String(error)) };
  }
}

/** A next-page link is followed only when it stays on the API: the request carries the token. */
const onApi = (url: string): boolean => url.startsWith(`${DIGITALOCEAN_API}/`);

/** Every record of one list endpoint, following `links.pages.next` to the last page. */
async function listAll(
  fetchImpl: CloudFetch,
  path: string,
  key: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ readonly records?: readonly Record<string, unknown>[]; readonly reason?: string }> {
  const records: Record<string, unknown>[] = [];
  let url: string | undefined = `${DIGITALOCEAN_API}/${path}?per_page=${PER_PAGE}`;
  for (let page = 0; url !== undefined; page += 1) {
    if (page >= MAX_PAGES) return { records, reason: `${path}: more than ${MAX_PAGES} pages` };
    const fetched = await getJson(fetchImpl, url, token, signal);
    if (!fetched.ok) return { records, reason: `${path}: ${fetched.reason}` };
    const found = fetched.body[key];
    if (Array.isArray(found)) {
      records.push(...found.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null));
    }
    const next = (fetched.body.links as { pages?: { next?: unknown } } | undefined)?.pages?.next;
    if (typeof next !== "string" || next === "") break;
    if (!onApi(next)) return { records, reason: `${path}: next page link leaves the API: ${next}` };
    url = next;
  }
  return { records };
}

const regionOf = (record: Record<string, unknown>): string | undefined =>
  textOf((record.region as Record<string, unknown> | undefined)?.slug);

/** A reserved IP is held whether or not a droplet is using it. */
function reservedIps(records: readonly Record<string, unknown>[], account: string | undefined): AddressObservation[] {
  return records.flatMap((record) => {
    const address = textOf(record.ip);
    if (address === undefined) return [];
    const droplet = record.droplet as Record<string, unknown> | null | undefined;
    const attached = textOf(droplet?.name);
    const region = regionOf(record);
    return [{
      address,
      cloud: "digitalocean" as const,
      kind: "reserved_ip" as const,
      ...(account === undefined ? {} : { account }),
      ...(region === undefined ? {} : { region }),
      ...(attached === undefined ? {} : { resource_name: attached }),
      state: attached === undefined ? "unassigned" : "assigned",
    }];
  });
}

/** One row per public IPv4 address of a droplet; a private address is not a DNS target. */
function droplets(records: readonly Record<string, unknown>[], account: string | undefined): AddressObservation[] {
  return records.flatMap((record) => {
    const networks = record.networks as { v4?: unknown } | undefined;
    const v4 = Array.isArray(networks?.v4) ? networks.v4 : [];
    const publicAddresses = v4.flatMap((entry) => {
      const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const address = textOf(row.ip_address);
      return address === undefined || row.type !== "public" ? [] : [address];
    });
    const name = textOf(record.name);
    const region = regionOf(record);
    return publicAddresses.map((address) => ({
      address,
      cloud: "digitalocean" as const,
      kind: "droplet" as const,
      ...(account === undefined ? {} : { account }),
      ...(region === undefined ? {} : { region }),
      ...(name === undefined ? {} : { resource_name: name }),
      state: textOf(record.status) ?? "unknown",
    }));
  });
}

/**
 * The account's reserved IPs, droplets and name. `unread` is set when the token is missing or a list call failed; the
 * observations found before a failure are still returned, because they are true whether or not the rest was readable.
 */
export async function readDigitalOceanAddresses(
  fetchImpl: CloudFetch,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<DigitalOceanRead> {
  if (token === undefined || token.trim() === "") {
    return {
      name: "digitalocean",
      observations: [],
      unread: `no DigitalOcean API token: set ${DIGITALOCEAN_API_VARIABLE}`,
    };
  }
  const bearer = token.trim();
  const named = await getJson(fetchImpl, `${DIGITALOCEAN_API}/account`, bearer, signal);
  const team = named.ok ? (named.body.account as Record<string, unknown> | undefined)?.team : undefined;
  const account =
    (typeof team === "object" && team !== null ? textOf((team as Record<string, unknown>).name) : undefined)
    ?? (named.ok ? textOf((named.body.account as Record<string, unknown> | undefined)?.email) : undefined);
  const [reserved, dropletList] = await Promise.all([
    listAll(fetchImpl, "reserved_ips", "reserved_ips", bearer, signal),
    listAll(fetchImpl, "droplets", "droplets", bearer, signal),
  ]);
  const failure = reserved.reason ?? dropletList.reason;
  return {
    name: account ?? "digitalocean",
    ...(account === undefined ? {} : { account }),
    observations: [
      ...reservedIps(reserved.records ?? [], account),
      ...droplets(dropletList.records ?? [], account),
    ],
    ...(failure === undefined ? {} : { unread: failure }),
  };
}
