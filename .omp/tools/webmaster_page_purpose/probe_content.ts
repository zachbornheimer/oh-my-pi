import { detectAnalyticsTags } from "./html_facts.ts";
import { type ContentMeasurement, unmeasured, VISIBLE_TEXT_CAP } from "./measurement.ts";
import { describeError, getPage } from "./page_fetch.ts";

const HTTP_ERROR_FLOOR = 400;
const FACEBOOK_PIXEL = /fbevents\.js|fbq\s*\(/i;
const IMG_TAG = /<img\b[^>]*>/gi;
const SCRIPT_OR_IFRAME_SRC = /<(?:script|iframe)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const META_GENERATOR = /<meta\b[^>]*name\s*=\s*["']generator["'][^>]*>/i;

const attr = (tag: string, name: string): string =>
  tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";

/** The page's rendered text: head, scripts, styles, noscript, comments and tags stripped, whitespace collapsed, capped. */
export function visibleText(html: string): string {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, VISIBLE_TEXT_CAP);
}

/** Whether the page carries the Facebook pixel, by its script or its `fbq(` call. */
export function hasFacebookPixel(html: string): boolean {
  return FACEBOOK_PIXEL.test(html);
}

/** Hosts of the page's script and iframe sources that are not the page's own host (www counted as the same). */
export function thirdPartyDomains(html: string, finalUrl: string): string[] {
  const own = new URL(finalUrl).hostname.replace(/^www\./, "");
  const hosts = [...html.matchAll(SCRIPT_OR_IFRAME_SRC)].flatMap((match) => {
    try {
      return [new URL(match[1]!, finalUrl).hostname];
    } catch {
      return [];
    }
  });
  return [...new Set(hosts.filter((host) => host !== "" && host !== own && host !== `www.${own}`))].sort();
}

/** The page's <img> count and how many of those carry no alt text. */
export function imageStats(html: string): { image_count_dom: number; images_missing_alt: number } {
  const tags = [...html.matchAll(IMG_TAG)].map((match) => match[0]);
  return {
    image_count_dom: tags.length,
    images_missing_alt: tags.filter((tag) => attr(tag, "alt").trim() === "").length,
  };
}

/** The meta generator tag's content; empty string when the page has none. */
export function generatorOf(html: string): string {
  const tag = html.match(META_GENERATOR)?.[0] ?? "";
  return attr(tag, "content");
}

/** The page's own content, read from one GET: its visible text, the tracking it loads, its images and its generator. */
export async function measureContent(url: string, signal?: AbortSignal): Promise<ContentMeasurement> {
  try {
    const page = await getPage(url, { signal });
    if (page.status >= HTTP_ERROR_FLOOR) return unmeasured(`HTTP ${page.status} at ${page.url}`);
    return {
      status: "measured",
      final_url: page.url,
      http_status: page.status,
      visible_text: visibleText(page.body),
      tag_ids: detectAnalyticsTags(page.body),
      fb_pixel: hasFacebookPixel(page.body),
      third_party_domains: thirdPartyDomains(page.body, page.url),
      ...imageStats(page.body),
      generator: generatorOf(page.body),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return unmeasured(`could not read ${url}: ${describeError(error)}`);
  }
}
