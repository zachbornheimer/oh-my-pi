import { type GetPage, measureSitemap, systemGetPage } from "./crawl.ts";
import { describeSite, judgeFindings } from "./judge.ts";
import type { ModelStep } from "./omp_model.ts";
import { coverageFindings, listingFindings, missingProbePaths, noStatusCounts, shouldNotBeListed, statusCounts } from "./rules.ts";
import { type SiteContext, siteContextNamed } from "./site_context.ts";
import { SITEMAP_PAGE_CAP, type SitemapResult } from "./types.ts";

export interface SitemapRequest {
  readonly site_url?: string | undefined;
  readonly sitemap_url?: string | undefined;
  readonly site?: string | undefined;
}

export interface SitemapDeps {
  readonly model: ModelStep;
  readonly getPage?: GetPage;
  readonly sitesDirectory?: string;
  readonly signal?: AbortSignal;
}

/** An address the check may fetch: http or https only, so the check never reads a local file. */
export function checkedAddress(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field}: "${value}" is not a web address`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field}: only http and https addresses can be read, not ${url.protocol}`);
  return url.toString();
}

/**
 * Reads a site's XML sitemap and finds the addresses it lists that it should not. Rules decide what should not be
 * listed; one model call confirms, ranks and words the findings. A sitemap that cannot be read is `unmeasured`.
 */
export async function runSitemap(request: SitemapRequest, deps: SitemapDeps): Promise<SitemapResult> {
  const site: SiteContext | undefined = request.site === undefined
    ? undefined
    : await siteContextNamed(request.site, ...(deps.sitesDirectory === undefined ? [] : [deps.sitesDirectory]));
  const siteUrl = request.site_url ?? (request.sitemap_url === undefined ? site?.url : undefined);
  if (siteUrl === undefined && request.sitemap_url === undefined) throw new Error("give site_url, sitemap_url or a site that has a site file");
  const target = {
    ...(siteUrl === undefined ? {} : { siteUrl: checkedAddress(siteUrl, "site_url") }),
    ...(request.sitemap_url === undefined ? {} : { sitemapUrl: checkedAddress(request.sitemap_url, "sitemap_url") }),
    maxPages: SITEMAP_PAGE_CAP,
  };
  const measured = await measureSitemap(target, deps.getPage ?? systemGetPage, deps.signal);
  if (measured.status === "unmeasured") {
    return {
      sitemap_url: target.sitemapUrl ?? target.siteUrl ?? "",
      urls_total: 0,
      urls_checked: 0,
      truncated: false,
      by_status: noStatusCounts(),
      should_not_be_listed: [],
      findings: [],
      unmeasured: measured.reason,
    };
  }
  const listed = shouldNotBeListed(measured, site);
  const missing = missingProbePaths(measured, site);
  const checked = measured.pages.length;
  const found = listingFindings(listed);
  let judged = found;
  let unavailable: string | undefined;
  try {
    judged = await judgeFindings(found, { subject: measured.sitemap_url, site: describeSite(site) }, deps.model, deps.signal);
  } catch (error) {
    deps.signal?.throwIfAborted();
    unavailable = error instanceof Error ? error.message : String(error);
  }
  return {
    sitemap_url: measured.sitemap_url,
    urls_total: measured.urls_total,
    urls_checked: checked,
    truncated: measured.urls_total > checked,
    by_status: statusCounts(measured.pages),
    should_not_be_listed: listed,
    ...(missing === undefined ? {} : { missing_from_sitemap_hint: missing }),
    findings: [...judged, ...coverageFindings(measured, checked, missing)],
    ...(unavailable === undefined ? {} : { judgment_unavailable: unavailable }),
  };
}
