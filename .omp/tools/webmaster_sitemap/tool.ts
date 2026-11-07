import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type Exec, type ModelStep, ompModelStep, withHeartbeat } from "./omp_model.ts";
import type { GetPage } from "./crawl.ts";
import { runSitemap } from "./sitemap.ts";

export interface SitemapToolDeps {
  /** The model step; the factory spawns `omp -p` through `pi.exec`. */
  model?: ModelStep;
  getPage?: GetPage;
  sitesDirectory?: string;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Read a site's XML sitemap and list the addresses it lists that it should not: noindex pages, 404/5xx or unreachable pages, redirects, private paths (`/wp-admin`, `/wp-login.php`, `/wp-json`, `/feed`, `/xmlrpc.php`, `?p=`, `?page_id=`, `?s=` plus the site's own private paths), another host than the site's, and pages whose canonical is a different page. "
  + "Use it for sitemap hygiene on one site; for a page's own SEO use a page audit, and it never edits the sitemap. "
  + "Input: `{\"site_url\":\"https://isjac.org\"}` (finds the sitemap from `robots.txt`, else `/wp-sitemap.xml`, `/sitemap_index.xml`, `/sitemap.xml`), or `{\"sitemap_url\":\"https://isjac.org/sitemap.xml\"}`, optionally with `site` (a site-file name under `WEBMASTER_SITES_DIR`, default `~/Developer/Zysys/webmaster/sites`, which adds the site's own paths and key pages and stands in for a missing address). Only http and https addresses are read. "
  + "It GETs up to 50 sitemap files, then a spread sample of 60 listed pages (6 at once, redirects not followed), then makes one billed `omp -p` call (up to 3 attempts) that confirms and ranks the rule findings; an unconfirmed finding drops to `info`. A failed model call keeps the rule severities and sets `judgment_unavailable`. "
  + "Result: `{sitemap_url, urls_total, urls_checked, truncated, by_status, should_not_be_listed[{url,reason}], missing_from_sitemap_hint?, findings[], unmeasured?}`; the status counts cover the sample only, the other addresses are judged by address alone, and an unreadable sitemap is `unmeasured`, never clean.";

export function makeTool(pi: Pi, deps: SitemapToolDeps = {}) {
  const z = pi.zod;
  const model: ModelStep = deps.model ?? ompModelStep(pi.exec as unknown as Exec);
  return {
    name: "webmaster_sitemap",
    label: "Sitemap check",
    description: DESCRIPTION,
    parameters: z.object({
      site_url: z.string().nullable().optional().describe("The site's address, such as `https://isjac.org`; its sitemap is found from robots.txt or the usual WordPress paths."),
      sitemap_url: z.string().nullable().optional().describe("Address of the sitemap file itself. Give this, `site_url` or a `site` that has a site file."),
      site: z.string().nullable().optional().describe("A site-file name under the webmaster sites directory, such as `isjac`; adds the site's own private paths and key pages."),
    }),
    async execute(
      _toolCallId: string,
      params: { site_url?: string | null; sitemap_url?: string | null; site?: string | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const result = await withHeartbeat(onUpdate, "reading the sitemap and its pages", () =>
        runSitemap(
          { site_url: params.site_url ?? undefined, sitemap_url: params.sitemap_url ?? undefined, site: params.site ?? undefined },
          {
            model,
            ...(deps.getPage === undefined ? {} : { getPage: deps.getPage }),
            ...(deps.sitesDirectory === undefined ? {} : { sitesDirectory: deps.sitesDirectory }),
            ...(signal === undefined ? {} : { signal }),
          },
        ));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
