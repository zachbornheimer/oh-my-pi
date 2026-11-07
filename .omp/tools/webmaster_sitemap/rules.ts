import type { SiteContext } from "./site_context.ts";
import {
  type Finding,
  type ListedUrl,
  LISTING_REASONS,
  type ListingReason,
  type SitemapMeasurement,
  type SitemapPage,
  type StatusCounts,
} from "./types.ts";

type Measured = Extract<SitemapMeasurement, { status: "measured" }>;

/** Paths no visitor-facing sitemap should list on any WordPress site. */
export const PRIVATE_PATH_PREFIXES = ["/wp-admin", "/wp-login.php", "/wp-json", "/feed", "/xmlrpc.php"] as const;
/** Query strings that are working addresses, not pages: a raw post id or a search. */
export const PRIVATE_QUERY_PATTERN = /[?&](p|page_id|s)=/;

const HTTP_OK_FLOOR = 200;
const REDIRECT_FLOOR = 300;
const CLIENT_ERROR_FLOOR = 400;
const SERVER_ERROR_FLOOR = 500;
const SERVER_ERROR_CEILING = 600;
const EXAMPLES_SHOWN = 3;
const TRAILING_SLASHES = /\/+$/;

export const noStatusCounts = (): StatusCounts => ({ "200": 0, "3xx": 0, "4xx": 0, "5xx": 0, unreachable: 0 });

function bucketOf(status: number): keyof StatusCounts {
  if (status >= HTTP_OK_FLOOR && status < REDIRECT_FLOOR) return "200";
  if (status >= REDIRECT_FLOOR && status < CLIENT_ERROR_FLOOR) return "3xx";
  if (status >= CLIENT_ERROR_FLOOR && status < SERVER_ERROR_FLOOR) return "4xx";
  if (status >= SERVER_ERROR_FLOOR && status < SERVER_ERROR_CEILING) return "5xx";
  return "unreachable";
}

export function statusCounts(pages: readonly SitemapPage[]): StatusCounts {
  const counts = noStatusCounts();
  for (const page of pages) counts[bucketOf(page.status)] += 1;
  return counts;
}

function pathOf(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

const normalizedPath = (path: string): string => path.replace(TRAILING_SLASHES, "") || "/";

function isPrivate(address: URL, site: SiteContext | undefined): boolean {
  const prefixes = [...PRIVATE_PATH_PREFIXES, ...(site?.private_paths ?? []), ...(site?.sitemap_disallow ?? [])];
  const path = normalizedPath(address.pathname);
  const underPrefix = prefixes.some((prefix) =>
    path === normalizedPath(prefix) || path.startsWith(`${normalizedPath(prefix)}/`)
  );
  return underPrefix || PRIVATE_QUERY_PATTERN.test(address.search);
}

/** The reason a listed address should not be listed judging by the address alone, if any. */
export function reasonFromAddress(
  url: string,
  canonicalHost: string,
  site: SiteContext | undefined,
): ListingReason | undefined {
  const address = pathOf(url);
  if (address === undefined) return "private_pattern";
  if (address.host !== canonicalHost) return "staging_host";
  return isPrivate(address, site) ? "private_pattern" : undefined;
}

function sameAddress(a: URL, b: URL): boolean {
  return a.host === b.host && normalizedPath(a.pathname) === normalizedPath(b.pathname) && a.search === b.search;
}

/** The reason a fetched page should not be listed, if any: the first that applies, worst first. */
export function reasonFromPage(page: SitemapPage): ListingReason | undefined {
  if (page.status === 0 || page.status >= CLIENT_ERROR_FLOOR) return "404";
  if (page.status >= REDIRECT_FLOOR) return "redirect";
  if (page.noindex) return "noindex";
  const address = pathOf(page.url);
  const canonical = page.canonical === undefined || page.canonical === "" || address === undefined
    ? undefined
    : pathOf(new URL(page.canonical, page.url).toString());
  return canonical !== undefined && address !== undefined && !sameAddress(address, canonical)
    ? "duplicate_canonical"
    : undefined;
}

export const canonicalHostOf = (measured: Measured, site: SiteContext | undefined): string =>
  site?.host ?? pathOf(measured.sitemap_url)?.host ?? "";

/** Every listed address that should not be, with the first reason that applies (address rules before page rules). */
export function shouldNotBeListed(measured: Measured, site: SiteContext | undefined): ListedUrl[] {
  const host = canonicalHostOf(measured, site);
  const byPage = new Map(measured.pages.map((page) => [page.url, page]));
  const seen = new Set<string>();
  const listed: ListedUrl[] = [];
  for (const url of measured.urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const page = byPage.get(url);
    const reason = reasonFromAddress(url, host, site) ?? (page === undefined ? undefined : reasonFromPage(page));
    if (reason !== undefined) listed.push({ url, reason });
  }
  return listed;
}

/** How many of the site's own probe paths the sitemap does not list; undefined when the site is unknown. */
export function missingProbePaths(measured: Measured, site: SiteContext | undefined): number | undefined {
  if (site === undefined) return undefined;
  const listed = new Set(
    measured.urls.map((url) => pathOf(url)).flatMap((address) =>
      address === undefined ? [] : [normalizedPath(address.pathname)]
    ),
  );
  return site.probe_paths.filter((path) => !listed.has(normalizedPath(path))).length;
}

const FINDING_OF_REASON: Readonly<
  Record<ListingReason, { id: string; severity: Finding["severity"]; what: string; fix: string }>
> = {
  noindex: {
    id: "noindex_listed",
    severity: "medium",
    what: "tell search not to index them",
    fix: "Remove them from the sitemap, or drop the noindex if they should rank.",
  },
  "404": {
    id: "error_status_listed",
    severity: "high",
    what: "answer an error (4xx or 5xx) or did not answer",
    fix: "Remove the dead addresses from the sitemap, or restore the pages.",
  },
  redirect: {
    id: "redirect_listed",
    severity: "medium",
    what: "redirect elsewhere",
    fix: "List the final address instead of the redirecting one.",
  },
  private_pattern: {
    id: "private_listed",
    severity: "high",
    what: "are working or private addresses (admin, login, feeds, ?p=)",
    fix: "Exclude these paths from the sitemap generator.",
  },
  staging_host: {
    id: "other_host_listed",
    severity: "high",
    what: "sit on a host other than the site's own",
    fix: "Regenerate the sitemap from the live host; remove staging or alias hosts.",
  },
  duplicate_canonical: {
    id: "duplicate_canonical_listed",
    severity: "medium",
    what: "name a different page as canonical",
    fix: "List only the canonical address of each page.",
  },
};

/** One finding per reason, with the count and the first few addresses as evidence. */
export function listingFindings(listed: readonly ListedUrl[]): Finding[] {
  return LISTING_REASONS.flatMap((reason) => {
    const these = listed.filter((entry) => entry.reason === reason);
    if (these.length === 0) return [];
    const { id, severity, what, fix } = FINDING_OF_REASON[reason];
    const examples = these.slice(0, EXAMPLES_SHOWN).map((entry) => entry.url).join(", ");
    return [{
      id: `sitemap.${id}`,
      area: "sitemap" as const,
      severity,
      evidence: `${these.length} listed address(es) ${what}, such as ${examples}.`,
      fix_hint: fix,
    }];
  });
}

/** Findings that are facts about the measurement itself, not about a listed address. */
export function coverageFindings(measured: Measured, checked: number, missing: number | undefined): Finding[] {
  const found: Finding[] = [];
  if (measured.urls_total === 0) {
    found.push({
      id: "sitemap.empty",
      area: "sitemap",
      severity: "high",
      evidence: `${measured.sitemap_url} lists no addresses.`,
      fix_hint: "Check the sitemap generator: a sitemap with no URLs gives search nothing to crawl.",
    });
  }
  if (measured.urls_total > checked) {
    found.push({
      id: "sitemap.sampled",
      area: "sitemap",
      severity: "info",
      evidence: `Fetched ${checked} of ${measured.urls_total} listed addresses; the rest were judged by address alone.`,
      fix_hint: "Run again for another sample, or crawl the full list with the webmaster CLI.",
    });
  }
  if (missing !== undefined && missing > 0) {
    found.push({
      id: "sitemap.probe_paths_missing",
      area: "sitemap",
      severity: "low",
      evidence: `${missing} of the site's own key paths are not in the sitemap.`,
      fix_hint: "Add the site's key pages to the sitemap.",
    });
  }
  return found;
}
