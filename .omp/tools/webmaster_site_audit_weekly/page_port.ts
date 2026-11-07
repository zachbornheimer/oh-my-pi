import type { PageAuditSlice, SiteAuditPorts } from "./audit";
import { chromiumOpener, type PageOpener } from "./page/browser.ts";
import type { Exec, ModelStep } from "./page/omp_model.ts";
import { ompModelStep } from "./page/omp_model.ts";
import { measureAccessibility } from "./page/probe_accessibility.ts";
import { measureContent } from "./page/probe_content.ts";
import { measureLinks, type PageFetch } from "./page/probe_links.ts";
import { measurePerformance, type PerformanceHost, systemHost } from "./page/probe_performance.ts";
import { measurePrivacy } from "./page/probe_privacy.ts";
import { measureSeo } from "./page/probe_seo.ts";
import { loadQuestionFile } from "./page/questions.ts";
import { AUDIT_AREAS, type AuditDeps, type AuditQuestions, auditStage } from "./page/stage_audit.ts";
import type { Probes } from "./page/stage_types.ts";
import { pageUrl } from "./page/tool_common.ts";
import { siteOf } from "./page/tool_model.ts";
import { systemWebSearch, type WebSearch } from "./page/web_search.ts";
import type { Zod } from "./page/zod_type.ts";

/** What the page audit reaches outside itself for; tests pass fakes for each. */
export interface PageDeps {
  /** omp's `pi.zod`: validates the model replies. */
  zod: Zod;
  /** `pi.exec`: runs the `omp -p` model steps, Lighthouse and the other child processes. */
  exec: Exec;
  /** Every page probe except the screenshot; the real ones when omitted. */
  probes?: Omit<Probes, "screenshot">;
  host?: PerformanceHost;
  open?: PageOpener;
  fetchPage?: PageFetch;
  search?: WebSearch;
  step?: ModelStep;
  sitesDirectory?: string;
}

const QUESTION_NAMES = ["audit", "seo", "performance", "purpose", "sections", "interpretation", "analogs", "synthesis"] as const;

let questionFiles: AuditQuestions | undefined;
/** The page audit's question files, read once. */
function questions(): AuditQuestions {
  questionFiles ??= Object.fromEntries(
    QUESTION_NAMES.map((name) => [name, loadQuestionFile(new URL(`./page/questions/webmaster_page_${name}.yaml`, import.meta.url))]),
  ) as unknown as AuditQuestions;
  return questionFiles;
}

/**
 * The audit of one key page: SEO, performance, accessibility, links and privacy plus the judgment stages, over one
 * reading of the page, kept as the slice the site audit reports. Throws what failed (the site audit keeps that as data).
 * Accessibility and privacy open headless Chromium through `playwright`, which must be installed in this directory.
 */
export function pageAuditPort(deps: PageDeps): SiteAuditPorts["auditPage"] {
  return async (site, url, research, signal): Promise<PageAuditSlice> => {
    const address = pageUrl(url);
    const siteContext = await siteOf(site, deps.sitesDirectory);
    const host = deps.host ?? systemHost;
    const open = deps.open ?? chromiumOpener();
    const real: Omit<Probes, "screenshot"> = deps.probes ?? {
      seo: (page) => measureSeo(page, signal),
      content: (page) => measureContent(page, signal),
      performance: (page, factor) => measurePerformance(host, page, factor, signal),
      accessibility: (page) => measureAccessibility(page, open, signal),
      links: (page) => measureLinks(page, signal, deps.fetchPage),
      privacy: (page) => measurePrivacy(page, open, signal),
    };
    const auditDeps: AuditDeps = {
      probes: { ...real, screenshot: () => Promise.reject(new Error("the audit takes no screenshots")) },
      search: deps.search ?? systemWebSearch(),
    };
    const step = deps.step ?? ompModelStep(deps.exec);
    const result = await auditStage(
      { z: deps.zod, step, ...(signal === undefined ? {} : { signal }) },
      auditDeps,
      { url: address, ...(siteContext === undefined ? {} : { site: siteContext }) },
      { areas: [...AUDIT_AREAS], research },
      questions(),
    );
    return {
      health: result.summary.health,
      headline: result.summary.headline,
      findings: result.findings as unknown as PageAuditSlice["findings"],
      unmeasured: result.summary.unmeasured,
      purpose: result.judgment.purpose.purpose,
      interpretation: result.judgment.findings.findings as unknown as PageAuditSlice["interpretation"],
    };
  };
}
