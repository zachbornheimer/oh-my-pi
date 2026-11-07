import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { ModelStep } from "./omp_model.ts";
import { measureContent } from "./probe_content.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./probe_performance.ts";
import { measureSeo } from "./probe_seo.ts";
import { loadQuestionFile } from "./questions.ts";
import { analogsStage } from "./stage_analogs.ts";
import { everyMeasurement, interpretationStage, JUDGMENT_FORM_FACTOR } from "./stage_interpretation.ts";
import { purposeOf, purposeStage } from "./stage_purpose.ts";
import type { Probes } from "./stage_types.ts";
import { synthesisStage } from "./stage_synthesis.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";
import { siteOf, stageEnv } from "./tool_model.ts";
import { systemWebSearch, type WebSearch } from "./web_search.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface SynthesisToolDeps {
  /** The page probes (the target, the analog candidates and the kept analogs); real ones when omitted. */
  probes?: Pick<Probes, "content" | "seo" | "performance">;
  host?: PerformanceHost;
  /** The web search; OpenRouter's web plugin with `OPENROUTER_API_KEY`, else DuckDuckGo's lite page, when omitted. */
  search?: WebSearch;
  /** The model step; one `omp -p` child process when omitted. */
  step?: ModelStep;
  sitesDirectory?: string;
}

export const DESCRIPTION =
  "Say what a world-class version of one live page would do and what that implies for it, from three evidence layers: CURRENT (this page's measurements, purpose and interpretation findings), REMOTE (analog pages found by web search, cited by zero-based analog_index) and EXTERNAL (named outside examples with a plain https url). Use webmaster_page_audit for ranked, fixable findings; this gives organizing principles only: no layout, no HTML. "
  + "Input: `{\"url\":\"https://example.org/membership\"}` or `{\"url\":\"https://example.org/membership\",\"site\":\"example\"}`. `url` MUST be an absolute http or https address. `site` names a site file (`<name>.yaml` in the webmaster sites directory) whose name, tier and platform are shown to the model; a missing file is an error. "
  + "Very slow (5 to 20 min) and sends many requests: it runs, in order, the purpose judgment, the interpretation and the analog search (web searches, GETs of every candidate page, per-analog speed runs through PageSpeed or `bunx lighthouse` launching Chrome) as in webmaster_page_interpretation and webmaster_page_analogs, then one synthesis `omp -p` model call. Earlier results cannot be passed in; every stage always runs. Changes nothing on the site. "
  + "Result: `{url, page_intent, intent_rationale, purpose, current, remote, external, patterns:{ui, ux, content, seo}, world_class, recommendations, seo_recommendations, synthesis:{current, remote, world_class, implication}}` with at least 3 UI, 3 UX and 3 content patterns, each tagged CURRENT, REMOTE, EXTERNAL or SYNTHESIS. An analog_index outside the found analogs, or on a non-REMOTE row, is cleared. A page whose purpose is `not auditable` returns `{url, unmeasured}`. If the model never returns a valid answer the call fails.";

export function makeTool(pi: Pi, deps: SynthesisToolDeps = {}) {
  const z = pi.zod;
  const questions = {
    synthesis: loadQuestionFile(new URL("./questions/webmaster_page_synthesis.yaml", import.meta.url)),
    interpretation: loadQuestionFile(new URL("./questions/webmaster_page_interpretation.yaml", import.meta.url)),
    analogs: loadQuestionFile(new URL("./questions/webmaster_page_analogs.yaml", import.meta.url)),
    purpose: loadQuestionFile(new URL("./questions/webmaster_page_purpose.yaml", import.meta.url)),
  };
  return {
    name: "webmaster_page_synthesis",
    label: "Page world-class synthesis",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/membership`."),
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
      const result = await withHeartbeat(onUpdate, "Synthesizing", async () => {
        const measured = await everyMeasurement(probes, url);
        const purposeResult = await purposeStage(env, probes, scene, questions.purpose, {
          content: measured.content,
          seo: measured.seo,
        });
        const purpose = purposeOf(purposeResult);
        // A page that is not auditable stops here, as the synthesis itself would.
        if (purpose.intentClass === "not auditable") {
          return synthesisStage(env, scene, measured, purpose, [], { sameIndustry: [], differentIndustry: [] }, questions.synthesis);
        }
        const [interpretation, analogs] = await Promise.all([
          interpretationStage(env, scene, measured, purpose, questions.interpretation),
          analogsStage(
            env,
            { probes, search: deps.search ?? systemWebSearch() },
            scene,
            { content: measured.content, seo: measured.seo },
            purpose,
            questions.analogs,
          ),
        ]);
        return synthesisStage(env, scene, measured, purpose, interpretation.findings, analogs, questions.synthesis);
      });
      return jsonResult(result);
    },
  };
}
