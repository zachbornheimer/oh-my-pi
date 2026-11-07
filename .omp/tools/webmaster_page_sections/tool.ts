import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { ModelStep } from "./omp_model.ts";
import { measureContent } from "./probe_content.ts";
import { measureSeo } from "./probe_seo.ts";
import { loadQuestionFile } from "./questions.ts";
import { sectionsStage } from "./stage_sections.ts";
import type { Probes } from "./stage_types.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";
import { siteOf, stageEnv } from "./tool_model.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface SectionsToolDeps {
  /** The page probes; real GETs when omitted. */
  probes?: Pick<Probes, "content" | "seo">;
  /** The model step; one `omp -p` child process when omitted. */
  step?: ModelStep;
  sitesDirectory?: string;
}

export const DESCRIPTION =
  "Judge one live page's major sections, top to bottom: what each contains, the role it appears to play, whether it serves the page's purpose (yes, partially, no, unclear) and one specific note per section. Use webmaster_page_purpose for the page's purpose, webmaster_page_interpretation for what its measurements mean and webmaster_page_audit for the whole page. "
  + "Input: `{\"url\":\"https://example.org/membership\"}` or `{\"url\":\"https://example.org/membership\",\"site\":\"example\"}`. `url` MUST be an absolute http or https address. `site` names a site file (`<name>.yaml` in the webmaster sites directory) whose name, tier and platform are shown to the model; a missing file is an error. "
  + "Sends two GETs (the page's HTML twice, for content and search facts) and one `omp -p` model call (up to 5 min, 3 attempts); the model reads the measured visible text and heading outline, not a screenshot. Changes nothing on the site. "
  + "Result: `{url, sections:[{ordinal, name, content, goal, servesPurpose, note}], unmeasured?}` in page order. If the content probe cannot read the page, `sections` is `[]` and `unmeasured` holds the reason; a login wall, error page or wrong redirect target is also judged by the model and may come back with no sections. If the model never returns a valid answer the call fails.";

export function makeTool(pi: Pi, deps: SectionsToolDeps = {}) {
  const z = pi.zod;
  const questions = loadQuestionFile(new URL("./questions/webmaster_page_sections.yaml", import.meta.url));
  return {
    name: "webmaster_page_sections",
    label: "Page sections",
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
      const probes = deps.probes ?? {
        content: (address: string) => measureContent(address, signal),
        seo: (address: string) => measureSeo(address, signal),
      };
      const env = stageEnv(pi, deps.step, onUpdate, signal);
      const result = await withHeartbeat(onUpdate, "Judging sections", () =>
        sectionsStage(env, probes, { url, ...(site === undefined ? {} : { site }) }, questions));
      return jsonResult(result);
    },
  };
}
