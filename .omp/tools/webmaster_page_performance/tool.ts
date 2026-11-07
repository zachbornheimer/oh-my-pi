import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { FORM_FACTORS, type FormFactor } from "./measurement.ts";
import type { ModelStep } from "./omp_model.ts";
import { loadQuestionFile } from "./questions.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./probe_performance.ts";
import { stageEnv, siteOf } from "./tool_model.ts";
import { performanceStage } from "./stage_performance.ts";
import type { Probes } from "./stage_types.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface PerformanceToolDeps {
  /** The speed probe; PageSpeed or local Lighthouse through `host` when omitted. */
  probes?: Pick<Probes, "performance">;
  /** What the real probe needs from the machine: environment, `fetch` and subprocesses. */
  host?: PerformanceHost;
  /** The model step; one `omp -p` child process when omitted. */
  step?: ModelStep;
  sitesDirectory?: string;
}

export const DESCRIPTION =
  "Measure one live page's speed and return performance findings. Use webmaster_page_seo for search facts, webmaster_page_accessibility for axe findings and webmaster_page_audit for every area at once. "
  + "Input: `{\"url\":\"https://example.org/\"}` or `{\"url\":\"https://example.org/\",\"form_factor\":\"desktop\",\"site\":\"example\"}`. `url` MUST be an absolute http or https address. `form_factor` is `mobile` (default) or `desktop`. `site` names a site file (`<name>.yaml` in the webmaster sites directory); a missing file is an error. "
  + "Slow (30 s to 4 min). With a PageSpeed key (`PSI_API_KEY`, else macOS keychain item `psi-api-key`) it sends the page URL and the key to Google's PageSpeed Insights API; on no key or any failure it runs a local Lighthouse through `bunx lighthouse` (launches Chrome, may download Lighthouse on first use). A model call (`omp -p`) is made only for borderline (medium) findings; poor findings stand as measured. Changes nothing on the site. "
  + "Result: `{url, form_factor, source:\"psi\"|\"lighthouse\"|\"unmeasured\", metrics?, tones, findings:[{id, area, severity, evidence, fix_hint, confidence?}], reason?}`. `metrics` has TTFB, FCP, LCP, INP, TBT, Speed Index, CLS, score, weight, resource summary, third parties, unused CSS/JS bytes, largest image, render-blocking count, frameworks and up to 10 failing Lighthouse opportunities. `tones` is good, warn or poor per metric. If both sources fail, `source` is `unmeasured`, `findings` is `[]` and `reason` lists every cause: that is NOT a fast page.";

export function makeTool(pi: Pi, deps: PerformanceToolDeps = {}) {
  const z = pi.zod;
  const questions = loadQuestionFile(new URL("./questions/webmaster_page_performance.yaml", import.meta.url));
  return {
    name: "webmaster_page_performance",
    label: "Page performance",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/`."),
      form_factor: z.enum(FORM_FACTORS).nullable().optional().describe(
        "Device profile to measure under: `mobile` (default) or `desktop`.",
      ),
      site: z.string().nullable().optional().describe(
        "Name of a site file (`<name>.yaml`) in the webmaster sites directory, such as `example`. Omit for an unknown site.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string; form_factor?: FormFactor | null; site?: string | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const url = pageUrl(params.url);
      const formFactor: FormFactor = params.form_factor ?? "mobile";
      const site = await siteOf(params.site, deps.sitesDirectory);
      const host = deps.host ?? systemHost;
      const probes = deps.probes ?? {
        performance: (address: string, factor: FormFactor) => measurePerformance(host, address, factor, signal),
      };
      const env = stageEnv(pi, deps.step, onUpdate, signal);
      const result = await withHeartbeat(onUpdate, "Measuring speed", () =>
        performanceStage(env, probes, { url, ...(site === undefined ? {} : { site }) }, formFactor, questions));
      return jsonResult(result);
    },
  };
}
