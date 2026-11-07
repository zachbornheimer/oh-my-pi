import { type SitemapMeasurement, type SitemapPage, SITEMAP_URL_CAP } from "./types.ts";

/** What one GET answered. `body` is text; `location` is an absolute address. */
export interface PageResponse {
  readonly status: number;
  readonly location?: string;
  readonly xRobotsTag: string;
  readonly contentType: string;
  readonly body: string;
}

export interface GetPageOptions {
  /** Follow redirects (default) or stop at the first response so the 3xx can be read. */
  readonly follow?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** The one place the check reads the web. Rejects when the page cannot be reached. */
export type GetPage = (url: string, options?: GetPageOptions) => Promise<PageResponse>;

const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "omp-webmaster-sitemap/1.0";

/** The only addresses the crawl reads: absolute http or https, with a host and no embedded credentials. */
function webUrl(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error(`"${address}" is not an address; give an absolute http or https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`"${address}" is not an http or https address`);
  }
  if (parsed.hostname === "") {
    throw new Error(`"${address}" has no host`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`"${address}" carries credentials; give a plain http or https URL`);
  }
  return parsed.toString();
}

export const systemGetPage: GetPage = async (url, options = {}) => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const response = await fetch(new URL(webUrl(url)), {
    redirect: options.follow === false ? "manual" : "follow",
    headers: { "user-agent": USER_AGENT },
    signal: options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]),
  });
  const location = response.headers.get("location");
  return {
    status: response.status,
    ...(location === null ? {} : { location: new URL(location, url).toString() }),
    xRobotsTag: response.headers.get("x-robots-tag") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
};

const USUAL_SITEMAP_PATHS = ["/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap.xml"] as const;
/** Sitemap files read for one site, indexes included. */
export const MAX_SITEMAP_FILES = 50;
const PAGES_AT_ONCE = 6;
const PAGE_TIMEOUT_MS = 15_000;
const HTTP_OK = 200;
const NOINDEX = /noindex/i;
const LOC = /<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
const ROBOTS_SITEMAP = /^\s*sitemap\s*:\s*(\S+)/gim;
const UNREACHABLE = 0;

export function parseSitemap(xml: string): { readonly kind: "index" | "urlset" | "unknown"; readonly locs: string[] } {
  const locs = [...xml.matchAll(LOC)].map((match) => (match[1] ?? "").replaceAll("&amp;", "&"));
  if (/<sitemapindex\b/i.test(xml)) return { kind: "index", locs };
  if (/<urlset\b/i.test(xml)) return { kind: "urlset", locs };
  return { kind: "unknown", locs: [] };
}

function attr(tag: string, name: string): string {
  return new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "";
}

/** The robots meta content and the rel=canonical address of an HTML page. */
export function extractMeta(html: string): { robots: string; canonical: string } {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const robots = metas.find((tag) => [attr(tag, "name"), attr(tag, "property")].map((label) => label.toLowerCase()).includes("robots")) ?? "";
  const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((tag) => attr(tag, "rel") === "canonical") ?? "";
  return { robots: attr(robots, "content"), canonical: attr(canonical, "href") };
}

/** Where a site's sitemap may be: every one robots.txt declares, else the usual WordPress locations, of which only the first that answers is the sitemap. */
interface Candidates {
  readonly urls: string[];
  readonly alternatives: boolean;
}

async function sitemapCandidates(siteUrl: string, getPage: GetPage, signal: AbortSignal | undefined): Promise<Candidates> {
  try {
    const robots = await getPage(new URL("/robots.txt", siteUrl).toString(), {
      timeoutMs: PAGE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    const declared = robots.status === HTTP_OK ? [...robots.body.matchAll(ROBOTS_SITEMAP)].map((match) => match[1] ?? "") : [];
    if (declared.length > 0) return { urls: declared, alternatives: false };
  } catch {
    signal?.throwIfAborted();
    // robots.txt unreachable: the usual locations are tried next.
  }
  return { urls: USUAL_SITEMAP_PATHS.map((path) => new URL(path, siteUrl).toString()), alternatives: true };
}

interface Listing {
  readonly sitemapUrl: string;
  readonly filesRead: number;
  readonly urls: string[];
}

/**
 * Reads sitemap files breadth first; an index adds its children. When `alternatives` is set, `start` are places the one
 * sitemap may be, so the first that answers is read (with its children) and the rest are not tried.
 */
async function readListing(
  start: readonly string[],
  alternatives: boolean,
  getPage: GetPage,
  signal: AbortSignal | undefined,
): Promise<Listing | undefined> {
  const queue = [...start];
  const starts = new Set(start);
  const seen = new Set<string>();
  const urls: string[] = [];
  let sitemapUrl = "";
  let filesRead = 0;
  while (queue.length > 0 && seen.size < MAX_SITEMAP_FILES) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const page = await getPage(next, { timeoutMs: PAGE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }).catch(() => {
      signal?.throwIfAborted();
      return undefined;
    });
    if (page === undefined || page.status !== HTTP_OK) continue;
    const parsed = parseSitemap(page.body);
    if (parsed.kind === "unknown") continue;
    if (sitemapUrl === "") sitemapUrl = next;
    filesRead += 1;
    if (parsed.kind === "index") queue.push(...parsed.locs);
    else urls.push(...parsed.locs);
    if (alternatives && starts.has(next)) {
      for (const other of starts) {
        const at = queue.indexOf(other);
        if (at >= 0) queue.splice(at, 1);
      }
    }
  }
  return filesRead === 0 ? undefined : { sitemapUrl, filesRead, urls };
}

/** An even spread of `count` items, so a sample of a long sitemap is not all one section. */
export function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, index) => items[Math.floor((index * items.length) / count)] as T);
}

async function probePage(url: string, getPage: GetPage, signal: AbortSignal | undefined): Promise<SitemapPage> {
  try {
    const page = await getPage(url, { follow: false, timeoutMs: PAGE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    const html = page.status === HTTP_OK && /html/i.test(page.contentType) ? extractMeta(page.body) : undefined;
    return {
      url,
      status: page.status,
      ...(page.location === undefined ? {} : { location: page.location }),
      noindex: NOINDEX.test(page.xRobotsTag) || (html !== undefined && NOINDEX.test(html.robots)),
      ...(html === undefined || html.canonical === "" ? {} : { canonical: html.canonical }),
    };
  } catch {
    signal?.throwIfAborted();
    return { url, status: UNREACHABLE, noindex: false };
  }
}

async function probeAll(urls: readonly string[], getPage: GetPage, signal: AbortSignal | undefined): Promise<SitemapPage[]> {
  const pages: (SitemapPage | undefined)[] = urls.map(() => undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const index = next++;
      pages[index] = await probePage(urls[index] as string, getPage, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, urls.length) }, worker));
  return pages.flatMap((page) => page ?? []);
}

/** Which sitemap to read: the one at an address, or the one a site publishes. */
export interface SitemapTarget {
  readonly sitemapUrl?: string;
  readonly siteUrl?: string;
  /** The most listed pages whose status is fetched. */
  readonly maxPages: number;
}

/**
 * The sitemap at an address or a site's own, with a spread sample of its pages fetched. Reports an unreachable site as
 * `unmeasured`, never as an empty sitemap; a cancelled run throws.
 */
export async function measureSitemap(target: SitemapTarget, getPage: GetPage = systemGetPage, signal?: AbortSignal): Promise<SitemapMeasurement> {
  try {
    const explicit = target.sitemapUrl !== undefined;
    const candidates: Candidates = explicit
      ? { urls: [target.sitemapUrl as string], alternatives: false }
      : await sitemapCandidates(target.siteUrl as string, getPage, signal);
    const listing = await readListing(candidates.urls, candidates.alternatives, getPage, signal);
    if (listing === undefined) return { status: "unmeasured", reason: `no sitemap answered at ${candidates.urls.join(", ")}` };
    const unique = [...new Set(listing.urls)];
    return {
      status: "measured",
      sitemap_url: listing.sitemapUrl,
      files_read: listing.filesRead,
      urls_total: unique.length,
      urls: unique.slice(0, SITEMAP_URL_CAP),
      pages: await probeAll(spread(unique, target.maxPages), getPage, signal),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unmeasured", reason: `could not read the sitemap: ${error instanceof Error ? error.message : String(error)}` };
  }
}
