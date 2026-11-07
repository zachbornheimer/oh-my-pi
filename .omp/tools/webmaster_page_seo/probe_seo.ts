import { countHeadingLevelSkips, classifyLinks, extractHeadingOutline, extractMeta, extractSchema } from "./html_facts.ts";
import { type SeoMeasurement, unmeasured } from "./measurement.ts";
import { describeError, getPage } from "./page_fetch.ts";

const HTTP_ERROR_FLOOR = 400;

/** The page's search facts, read from one GET of its HTML. A page that answers 4xx or 5xx, or cannot be read, is unmeasured. */
export async function measureSeo(url: string, signal?: AbortSignal): Promise<SeoMeasurement> {
  try {
    const page = await getPage(url, { signal });
    if (page.status >= HTTP_ERROR_FLOOR) return unmeasured(`HTTP ${page.status} at ${page.url}`);
    const meta = extractMeta(page.body);
    const headings = extractHeadingOutline(page.body);
    const links = classifyLinks(page.body, page.url);
    const schema = extractSchema(page.body);
    return {
      status: "measured",
      final_url: page.url,
      http_status: page.status,
      title: meta.title,
      meta_description: meta.metaDescription,
      canonical: meta.canonical,
      robots_meta: meta.robots,
      x_robots_tag: page.xRobotsTag,
      headings,
      heading_level_skips: countHeadingLevelSkips(headings),
      schema_types: schema.present,
      schema_errors: schema.errors,
      open_graph: meta.openGraph,
      internal_links: links.internalLinks,
      external_links: links.externalLinks,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return unmeasured(`could not read ${url}: ${describeError(error)}`);
  }
}
