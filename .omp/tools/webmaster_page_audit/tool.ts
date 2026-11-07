import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { chromiumOpener, type PageOpener } from "./browser.ts";
import type { ModelStep } from "./omp_model.ts";
import { measureAccessibility } from "./probe_accessibility.ts";
import { measureContent } from "./probe_content.ts";
import { measureLinks, type PageFetch } from "./probe_links.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./probe_performance.ts";
import { measurePrivacy } from "./probe_privacy.ts";
import { measureSeo } from "./probe_seo.ts";
import { loadQuestionFile } from "./questions.ts";
import { AUDIT_AREAS, type AuditArea, type AuditDeps, auditStage } from "./stage_audit.ts";
import type { Probes } from "./stage_types.ts";
import { jsonResult, pageUrl, withHeartbeat } from "./tool_common.ts";
import { siteOf, stageEnv } from "./tool_model.ts";
import { systemWebSearch, type WebSearch } from "./web_search.ts";

type Pi = Parameters<CustomToolFactory>[0];

export interface AuditToolDeps {
  /** Every page probe; the real ones when omitted. */
  probes?: Omit<Probes, "screenshot">;
  host?: PerformanceHost;
  open?: PageOpener;
  fetchPage?: PageFetch;
  search?: WebSearch;
  step?: ModelStep;
  sitesDirectory?: string;
}

export const DESCRIPTION =
  "Audit one live web page end to end: SEO, performance, accessibility, broken-link and pre-consent-tracking findings, plus the page's purpose, sections and an interpretation of the measurements, ranked fix-first with an overall health. Use the single-area webmaster_page_* tools for one area only. "
  + "Input: `{\"url\":\"https://example.org/membership\"}`, `{\"url\":\"...\",\"site\":\"example\",\"areas\":[\"seo\",\"links\"]}` or `{\"url\":\"...\",\"research\":true}`. `url` MUST be an absolute http or https address. `areas` is any of seo, performance, accessibility, links, privacy (default all five). `research` (default false) adds the analog search and a world-class synthesis. `site` names a site file (`<name>.yaml` in the webmaster sites directory); a missing file is an error. "
  + "Slow (2 to 10 min; up to 30 with research): GETs the page, measures mobile speed (PageSpeed with `PSI_API_KEY` or keychain `psi-api-key`, else `bunx lighthouse` launching Chrome), opens it in headless Chromium for accessibility and privacy (needs `playwright` and `@axe-core/playwright` installed in this tool's directory), checks up to 40 internal links and makes several `omp -p` model calls. Only asked areas are measured. Page requests are GETs; the page's own scripts and trackers run in the browser; nothing on the site changes. "
  + "Result: `{url, areas, judgment:{purpose, sections, findings}, research?:{analogs, synthesis}, findings:[{id, area, severity, evidence, fix_hint, confidence?, priority, rank}], summary:{health, finding_counts, unmeasured:[{area, reason}], headline}}`; rank 1 first, priority 0 ignore to 3 now, health healthy, needs_attention, critical or `unknown` when every asked area was unmeasured. An unmeasured area is listed in `summary.unmeasured` and gives no findings: that is NOT a clean area. A failed research stage degrades to its own unmeasured result; a failed area or judgment step, or a model that never answers validly, fails the call.";

export function makeTool(pi: Pi, deps: AuditToolDeps = {}) {
  const z = pi.zod;
  const file = (name: string) => loadQuestionFile(new URL(`./questions/webmaster_page_${name}.yaml`, import.meta.url));
  const questions = {
    audit: file("audit"),
    seo: file("seo"),
    performance: file("performance"),
    purpose: file("purpose"),
    sections: file("sections"),
    interpretation: file("interpretation"),
    analogs: file("analogs"),
    synthesis: file("synthesis"),
  };
  return {
    name: "webmaster_page_audit",
    label: "Page audit",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().min(1).describe("Absolute http or https address of the page, such as `https://example.org/membership`."),
      site: z.string().nullable().optional().describe(
        "Name of a site file (`<name>.yaml`) in the webmaster sites directory, such as `example`. Omit for an unknown site.",
      ),
      areas: z.array(z.enum(AUDIT_AREAS)).nullable().optional().describe(
        "Areas to audit: seo, performance, accessibility, links, privacy. Default all five.",
      ),
      research: z.boolean().nullable().optional().describe(
        "Also find analog pages and synthesize what a world-class version would do (slow). Default false.",
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string; site?: string | null; areas?: AuditArea[] | null; research?: boolean | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const url = pageUrl(params.url);
      const site = await siteOf(params.site, deps.sitesDirectory);
      const areas = params.areas === undefined || params.areas === null || params.areas.length === 0
        ? [...AUDIT_AREAS]
        : [...new Set(params.areas)];
      const host = deps.host ?? systemHost;
      const open = deps.open ?? chromiumOpener();
      const real: Omit<Probes, "screenshot"> = deps.probes ?? {
        seo: (address) => measureSeo(address, signal),
        content: (address) => measureContent(address, signal),
        performance: (address, factor) => measurePerformance(host, address, factor, signal),
        accessibility: (address) => measureAccessibility(address, open, signal),
        links: (address) => measureLinks(address, signal, deps.fetchPage),
        privacy: (address) => measurePrivacy(address, open, signal),
      };
      const auditDeps: AuditDeps = {
        probes: { ...real, screenshot: () => Promise.reject(new Error("the audit takes no screenshots")) },
        search: deps.search ?? systemWebSearch(),
      };
      const env = stageEnv(pi, deps.step, onUpdate, signal);
      const result = await withHeartbeat(onUpdate, "Auditing the page", () =>
        auditStage(
          env,
          auditDeps,
          { url, ...(site === undefined ? {} : { site }) },
          { areas, research: params.research === true },
          questions,
        ));
      return jsonResult(result);
    },
  };
}
