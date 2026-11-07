import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { FINDING_CAP } from "./schemas.ts";
import type { ModelStep } from "./omp_model.ts";
import { measureContent } from "./probe_content.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./probe_performance.ts";
import { measureSeo } from "./probe_seo.ts";
import { loadQuestionFile } from "./questions.ts";
import { everyMeasurement, interpretationStage, JUDGMENT_FORM_FACTOR } from "./stage_interpretation.ts";
import { purposeOf, purposeStage } from "./stage_purpose.ts";
import type { Probes } from "./stage_types.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";
import { siteOf, stageEnv } from "./tool_model.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface InterpretationToolDeps {
  /** The page probes; real ones (GET, PageSpeed or Lighthouse) when omitted. */
  probes?: Pick<Probes, "content" | "seo" | "performance">;
  host?: PerformanceHost;
  /** The model step; one `omp -p` child process when omitted. */
  step?: ModelStep;
  sitesDirectory?: string;
}

export const DESCRIPTION =
  `Interpret one live page's measurements: at most ${FINDING_CAP} findings, most important first, each citing a measured fact and what it means for the page's apparent purpose. Findings only: no fixes, no generic best-practice commentary, no forced findings. Use webmaster_page_audit for ranked, fixable findings across every area and webmaster_page_purpose for the purpose alone. `
  + "Input: `{\"url\":\"https://example.org/\"}` or `{\"url\":\"https://example.org/\",\"site\":\"example\"}`. `url` MUST be an absolute http or https address. `site` names a site file (`<name>.yaml` in the webmaster sites directory) whose name, tier and platform are shown to the model; a missing file is an error. "
  + "Slow (30 s to 5 min): reads the page's search facts, content and mobile speed at once (PageSpeed with `PSI_API_KEY` or keychain `psi-api-key`, else a local Lighthouse through `bunx lighthouse` launching Chrome), then runs two `omp -p` model calls, the purpose judgment first and the interpretation second. A purpose passed from outside is not accepted; it is always re-judged. Changes nothing on the site. "
  + "Result: `{url, findings:[{measurement, consequence}], unmeasured?}`. If no probe could read anything, `findings` is `[]` and `unmeasured` holds the reason. A page whose purpose is `not auditable` gets only findings about what is observable. If the model never returns a valid answer the call fails.";

export function makeTool(pi: Pi, deps: InterpretationToolDeps = {}) {
  const z = pi.zod;
  const questions = {
    interpretation: loadQuestionFile(new URL("./questions/webmaster_page_interpretation.yaml", import.meta.url)),
    purpose: loadQuestionFile(new URL("./questions/webmaster_page_purpose.yaml", import.meta.url)),
  };
  return {
    name: "webmaster_page_interpretation",
    label: "Page interpretation",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/`."),
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
        performance: (address: string) => measurePerformance(host, address, JUDGMENT_FORM_FACTOR, signal),
      };
      const env = stageEnv(pi, deps.step, onUpdate, signal);
      const result = await withHeartbeat(onUpdate, "Interpreting the page", async () => {
        const measured = await everyMeasurement(probes, url);
        const purpose = await purposeStage(env, probes, scene, questions.purpose, {
          content: measured.content,
          seo: measured.seo,
        });
        return interpretationStage(env, scene, measured, purposeOf(purpose), questions.interpretation);
      });
      return jsonResult(result);
    },
  };
}
