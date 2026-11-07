import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { ModelStep } from "./omp_model.ts";
import { loadQuestionFile } from "./questions.ts";
import { measureSeo } from "./probe_seo.ts";
import { stageEnv, siteOf } from "./tool_model.ts";
import { seoStage } from "./stage_seo.ts";
import type { Probes } from "./stage_types.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface SeoToolDeps {
  /** The page probe; a real GET of the page when omitted. */
  probes?: Pick<Probes, "seo">;
  /** The model step; one `omp -p` child process when omitted. */
  step?: ModelStep;
  /** Where site files live; `WEBMASTER_SITES_DIR` or `~/Developer/Zysys/webmaster/sites` when omitted. */
  sitesDirectory?: string;
}

export const DESCRIPTION =
  "Read one live page's search facts and return SEO findings, each confirmed and ranked by a model against what the site is for. Use webmaster_page_performance for speed, webmaster_page_links for broken links and webmaster_page_audit for every area at once. "
  + "Input: `{\"url\":\"https://example.org/about\"}` or `{\"url\":\"https://example.org/\",\"site\":\"example\"}`. `url` MUST be an absolute http or https address. `site` names a site file (`<name>.yaml` in the webmaster sites directory) whose name, tier and platform are given to the model; omit it for an unknown site; a missing file is an error. "
  + "Sends one GET of the page (20 s, redirects followed) and one `omp -p` model call (up to 5 min, 3 attempts) when the rules raise findings; no model quota is spent on a clean page. Changes nothing on the site. "
  + "Rules find title, meta description, canonical, heading, schema, Open Graph, robots/noindex and link problems; the model sets each finding's severity (high, medium, low) and drops one it judges not real for this page to `info`, with a `confidence` from 0 to 1. At most 12 findings are judged; the rest keep their rule severity. "
  + "Result: `{url, facts:{title, meta_description, canonical, h1_count, heading_outline, schema_types, og, link_counts, robots, indexable}, findings:[{id, area, severity, evidence, fix_hint, confidence?}], unmeasured?}`. If the page answers 4xx or 5xx or cannot be read, `findings` is `[]` and `unmeasured` holds the reason: that is NOT a clean page. If the model never returns a valid answer the call fails.";

export function makeTool(pi: Pi, deps: SeoToolDeps = {}) {
  const z = pi.zod;
  const questions = loadQuestionFile(new URL("./questions/webmaster_page_seo.yaml", import.meta.url));
  return {
    name: "webmaster_page_seo",
    label: "Page SEO",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/about`."),
      site: z.string().nullable().optional().describe(
        "Name of a site file (`<name>.yaml`) in the webmaster sites directory, such as `example`. Omit for an unknown site.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string; site?: string | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const url = pageUrl(params.url);
      const site = await siteOf(params.site, deps.sitesDirectory);
      const probes = deps.probes ?? { seo: (address: string) => measureSeo(address, signal) };
      const env = stageEnv(pi, deps.step, onUpdate, signal);
      const result = await withHeartbeat(onUpdate, "Judging SEO", () =>
        seoStage(env, probes, { url, ...(site === undefined ? {} : { site }) }, questions));
      return jsonResult(result);
    },
  };
}
