import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { LINK_CHECK_CAP, LINKS_AT_ONCE } from "./measurement.ts";
import { measureLinks, type PageFetch } from "./probe_links.ts";
import { linksStage } from "./stage_links.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface LinksToolDeps {
  /** Reads one address; a real GET when omitted. */
  fetchPage?: PageFetch;
}

export const DESCRIPTION =
  "Fetch one live page, find its internal links and report the ones that answer 4xx or 5xx as broken. Use webmaster_page_seo for search facts and webmaster_page_audit for every area at once. "
  + "Input: `{\"url\":\"https://example.org/about\"}`. `url` MUST be an absolute http or https address; anything else is refused before any request. "
  + `Sends one GET for the page, then one GET for each distinct internal link in document order (same registrable domain, relative links resolved, fragments and mailto/tel/javascript skipped), at most ${LINK_CHECK_CAP} links, ${LINKS_AT_ONCE} at a time, 20 s each, following redirects. External links are never fetched. Read-only: no request changes the site. `
  + "A rule, no model: one high finding `links.broken_internal` naming every broken URL. A link that cannot be reached at all (timeout, DNS failure) is not counted as broken. "
  + "Result: `{url, checked, truncated, findings:[{id, area, severity, evidence, fix_hint}], unmeasured?}`. `checked` is how many links were fetched; `truncated: true` means more existed, so empty `findings` covers only those. If the page itself answers 4xx or 5xx or cannot be read, `findings` is `[]`, `checked` and `truncated` are absent and `unmeasured` holds the reason: that is NOT a clean page.";

export function makeTool(pi: Pi, deps: LinksToolDeps = {}) {
  const z = pi.zod;
  return {
    name: "webmaster_page_links",
    label: "Page broken links",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/about`."),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const url = pageUrl(params.url);
      const result = await withHeartbeat(onUpdate, "Checking links", () =>
        linksStage({ links: (address) => measureLinks(address, signal, deps.fetchPage) }, url));
      return jsonResult(result);
    },
  };
}
