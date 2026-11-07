import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { ModelStep } from "./omp_model.ts";
import { measureContent } from "./probe_content.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./probe_performance.ts";
import { measureSeo } from "./probe_seo.ts";
import { loadQuestionFile } from "./questions.ts";
import { FOLLOW_UP_ROUNDS } from "./rounds.ts";
import { analogsStage } from "./stage_analogs.ts";
import { contentAndSeo, purposeOf, purposeStage } from "./stage_purpose.ts";
import type { Probes } from "./stage_types.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";
import { siteOf, stageEnv } from "./tool_model.ts";
import { systemWebSearch, type WebSearch } from "./web_search.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface AnalogsToolDeps {
  /** The page probes (the target, the candidates and the kept analogs); real ones when omitted. */
  probes?: Pick<Probes, "content" | "seo" | "performance">;
  host?: PerformanceHost;
  /** The web search; OpenRouter's web plugin with `OPENROUTER_API_KEY`, else DuckDuckGo's lite page, when omitted. */
  search?: WebSearch;
  /** The model step; one `omp -p` child process when omitted. */
  step?: ModelStep;
  sitesDirectory?: string;
}

export const DESCRIPTION =
  "Find real, live pages analogous to one target page so each can be compared with it: 3 to 5 best-in-class pages in the same industry serving the same intent, and 3 to 5 pages in other industries solving the same intent. It does not audit or critique the target. Use webmaster_page_synthesis to turn analogs into recommendations. "
  + "Input: `{\"url\":\"https://example.org/membership\"}` or `{\"url\":\"https://example.org/membership\",\"site\":\"example\"}`. `url` MUST be an absolute http or https address. `site` names a site file (`<name>.yaml` in the webmaster sites directory) whose name, tier and platform are shown to the model; a missing file is an error. "
  + `Very slow (3 to 15 min) and sends many requests: it judges the target's purpose, has a model write search queries, runs web searches (OpenRouter with \`OPENROUTER_API_KEY\`, else DuckDuckGo's lite page), GETs every new result twice (up to 12 per set per round), has a model pick analogs from the pages actually fetched, rejects any pick that was not fetched or whose title does not match, gives a set below 3 up to ${FOLLOW_UP_ROUNDS} more rounds, then measures each kept page's mobile speed (PageSpeed with \`PSI_API_KEY\` or keychain, else \`bunx lighthouse\` launching Chrome). Several \`omp -p\` model calls. Changes nothing on the site. `
  + "Result: `{url, industry, sameIndustry, differentIndustry, rejected:[{url, reason}], shortfalls:[{set, kept, minimum}], unmeasured?}`; each analog is `{url, organization, industry, whyAnalogous, observedTitle, standoutPattern, measurements:{seo, content, performance}}`. A set below 3 is listed in `shortfalls`, never padded. A target judged `not auditable`, or first searches that all fail, return empty sets with the reason in `unmeasured`: that is NOT a finding that no analogs exist.";

export function makeTool(pi: Pi, deps: AnalogsToolDeps = {}) {
  const z = pi.zod;
  const questions = {
    analogs: loadQuestionFile(new URL("./questions/webmaster_page_analogs.yaml", import.meta.url)),
    purpose: loadQuestionFile(new URL("./questions/webmaster_page_purpose.yaml", import.meta.url)),
  };
  return {
    name: "webmaster_page_analogs",
    label: "Page analogs",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the target page, such as `https://example.org/membership`."),
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
      const scene = { url, ...(site === undefined ? {} : { site }) };
      const host = deps.host ?? systemHost;
      const probes = deps.probes ?? {
        content: (address: string) => measureContent(address, signal),
        seo: (address: string) => measureSeo(address, signal),
        performance: (address: string, factor: "mobile" | "desktop") => measurePerformance(host, address, factor, signal),
      };
      const env = stageEnv(pi, deps.step, onUpdate, signal);
      const result = await withHeartbeat(onUpdate, "Finding analogs", async () => {
        const measured = await contentAndSeo(probes, url);
        const purpose = await purposeStage(env, probes, scene, questions.purpose, measured);
        return analogsStage(
          env,
          { probes, search: deps.search ?? systemWebSearch() },
          scene,
          measured,
          purposeOf(purpose),
          questions.analogs,
        );
      });
      return jsonResult(result);
    },
  };
}
