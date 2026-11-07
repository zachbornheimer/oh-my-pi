import { LINK_CHECK_CAP, LINKS_AT_ONCE, type LinksMeasurement, unmeasured } from "./measurement.ts";
import { describeError, getPage, type PageResponse } from "./page_fetch.ts";

const HTTP_ERROR_FLOOR = 400;
const HREF = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
const SKIPPED_SCHEME = /^(?:mailto|tel|javascript):/i;

/** The registrable domain the link classifier uses: the last two hostname labels. */
const registrableDomain = (hostname: string): string => hostname.split(".").slice(-2).join(".");

/**
 * The page's internal links, in document order, each once. Absolute links use the registrable-domain rule; a relative
 * link resolves against the page and then the same rule. Fragments, mailto, tel and javascript are not links to fetch.
 */
export function internalLinks(html: string, finalUrl: string): string[] {
  const own = registrableDomain(new URL(finalUrl).hostname);
  const seen = new Set<string>();
  const found: string[] = [];
  for (const match of html.matchAll(HREF)) {
    const raw = (match[1] ?? "").trim();
    if (raw === "" || raw.startsWith("#") || SKIPPED_SCHEME.test(raw)) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, finalUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (registrableDomain(resolved.hostname) !== own) continue;
    resolved.hash = "";
    const address = resolved.toString();
    if (seen.has(address)) continue;
    seen.add(address);
    found.push(address);
  }
  return found;
}

export type PageFetch = (url: string, signal?: AbortSignal) => Promise<PageResponse>;

const defaultFetch: PageFetch = (url, signal) => getPage(url, { signal });

async function statuses(
  urls: readonly string[],
  fetchPage: PageFetch,
  signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      signal?.throwIfAborted();
      const index = next++;
      const address = urls[index] as string;
      try {
        found.set(address, (await fetchPage(address, signal)).status);
      } catch {
        signal?.throwIfAborted();
        // A link that cannot be reached is not a 4xx or 5xx, so it is not broken.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINKS_AT_ONCE, urls.length) }, worker));
  return found;
}

/**
 * The page's internal links and which of them answer 4xx or 5xx. At most `LINK_CHECK_CAP` are fetched, `LINKS_AT_ONCE`
 * at a time. A page that itself answers 4xx or cannot be read is unmeasured.
 */
export async function measureLinks(
  url: string,
  signal?: AbortSignal,
  fetchPage: PageFetch = defaultFetch,
): Promise<LinksMeasurement> {
  try {
    const page = await fetchPage(url, signal);
    if (page.status >= HTTP_ERROR_FLOOR) return unmeasured(`HTTP ${page.status} at ${page.url}`);
    const links = internalLinks(page.body, page.url);
    const checked = links.slice(0, LINK_CHECK_CAP);
    const answered = await statuses(checked, fetchPage, signal);
    const broken = checked.flatMap((address) => {
      const status = answered.get(address);
      return status !== undefined && status >= HTTP_ERROR_FLOOR ? [{ url: address, status }] : [];
    });
    return {
      status: "measured",
      final_url: page.url,
      checked: checked.length,
      truncated: links.length > checked.length,
      broken,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return unmeasured(`could not read links of ${url}: ${describeError(error)}`);
  }
}
