import { accessibilityStage, type AccessibilityResult } from "./stage_accessibility.ts";
import { analogsStage, analogsUnmeasured, type AnalogDeps } from "./stage_analogs.ts";
import type { Finding } from "./finding.ts";
import { interpretationStage, JUDGMENT_FORM_FACTOR } from "./stage_interpretation.ts";
import { linksStage, type LinksResult } from "./stage_links.ts";
import type { MeasuredAreas } from "./measured_brief.ts";
import type {
  AccessibilityMeasurement,
  ContentMeasurement,
  LinksMeasurement,
  PerformanceMeasurement,
  PrivacyMeasurement,
  SeoMeasurement,
} from "./measurement.ts";
import { mapLimit } from "./omp_model.ts";
import { performanceStage, type PerformanceResult } from "./stage_performance.ts";
import { privacyStage, type PrivacyResult } from "./stage_privacy.ts";
import { purposeOf, purposeStage } from "./stage_purpose.ts";
import type { QuestionFile } from "./questions.ts";
import { type Health, rankFindings, type RankedFinding, severityCounts } from "./ranking.ts";
import type {
  AnalogsResult,
  InterpretationResult,
  PurposeResult,
  SectionsResult,
  SynthesisResult,
} from "./schemas.ts";
import { sectionsStage } from "./stage_sections.ts";
import { seoStage, type SeoResult } from "./stage_seo.ts";
import type { SiteContext } from "./site_context.ts";
import type { Probes, StageEnv } from "./stage_types.ts";
import { auditHeadline } from "./summary.ts";
import { synthesisStage } from "./stage_synthesis.ts";
import type { Severity } from "./finding.ts";

export const AUDIT_AREAS = ["seo", "performance", "accessibility", "links", "privacy"] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

/** The areas a summary can name as unmeasured: the rule areas, the content probe the judgment stages read, and the research stages. */
export type UnmeasuredArea = AuditArea | "content" | "research";

const AREAS_AT_ONCE = 2;

/** Every question file the audit reads, by the stage that asks it. */
export interface AuditQuestions {
  readonly audit: QuestionFile;
  readonly seo: QuestionFile;
  readonly performance: QuestionFile;
  readonly purpose: QuestionFile;
  readonly sections: QuestionFile;
  readonly interpretation: QuestionFile;
  readonly analogs: QuestionFile;
  readonly synthesis: QuestionFile;
}

export interface AuditAreas {
  seo?: SeoResult;
  performance?: PerformanceResult;
  accessibility?: AccessibilityResult;
  links?: LinksResult;
  privacy?: PrivacyResult;
}

export interface AuditResearch {
  analogs: AnalogsResult;
  synthesis: SynthesisResult;
}

export interface AuditResult {
  url: string;
  areas: AuditAreas;
  judgment: {
    purpose: Omit<PurposeResult, "url">;
    sections: Omit<SectionsResult, "url">;
    findings: Omit<InterpretationResult, "url">;
  };
  research?: AuditResearch;
  findings: RankedFinding[];
  summary: {
    health: Health;
    finding_counts: Record<Severity, number>;
    unmeasured: { area: UnmeasuredArea; reason: string }[];
    headline: string;
  };
}

type AreaResult = SeoResult | PerformanceResult | AccessibilityResult | LinksResult | PrivacyResult;

const unmeasuredReason = (result: AreaResult): string | undefined =>
  "unmeasured" in result ? result.unmeasured : "reason" in result ? result.reason : undefined;

const failureOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const omitUrl = <T extends { url: string }>(result: T): Omit<T, "url"> => {
  const { url: _url, ...rest } = result;
  return rest;
};

/** Why each research stage came back unmeasured, one entry per stage that did. */
function researchUnmeasured(found: AuditResearch | undefined): { area: "research"; reason: string }[] {
  if (found === undefined) return [];
  return [found.analogs, found.synthesis].flatMap((stage) =>
    "unmeasured" in stage && stage.unmeasured !== undefined
      ? [{ area: "research" as const, reason: stage.unmeasured }]
      : []
  );
}

/** The measurements an audit reads: one per asked area, plus the content the judgment stages read. */
interface Readings {
  seo?: SeoMeasurement;
  performance?: PerformanceMeasurement;
  accessibility?: AccessibilityMeasurement;
  links?: LinksMeasurement;
  privacy?: PrivacyMeasurement;
  content: ContentMeasurement;
}

async function readAll(probes: Probes, url: string, areas: readonly AuditArea[]): Promise<Readings> {
  const asked = (area: AuditArea) => areas.includes(area);
  const [seo, performance, accessibility, links, privacy, content] = await Promise.all([
    asked("seo") ? probes.seo(url) : undefined,
    asked("performance") ? probes.performance(url, JUDGMENT_FORM_FACTOR) : undefined,
    asked("accessibility") ? probes.accessibility(url) : undefined,
    asked("links") ? probes.links(url) : undefined,
    asked("privacy") ? probes.privacy(url) : undefined,
    probes.content(url),
  ]);
  return {
    ...(seo === undefined ? {} : { seo }),
    ...(performance === undefined ? {} : { performance }),
    ...(accessibility === undefined ? {} : { accessibility }),
    ...(links === undefined ? {} : { links }),
    ...(privacy === undefined ? {} : { privacy }),
    content,
  };
}

/** What the audit needs beyond its probes: the analog search, for the research stages. */
export interface AuditDeps {
  readonly probes: Probes;
  readonly search: AnalogDeps["search"];
}

/**
 * One page, audited by running the area stages and the judgment stages over one reading of the page: each area judges
 * its own findings, purpose and sections judge the page in parallel, interpretation reads the purpose plus every
 * measurement, the research stages find analog pages and synthesize what a world-class version would do, and one model
 * call ranks the findings. A research stage that fails degrades to its typed unmeasured result and never fails the audit.
 */
export async function auditStage(
  env: StageEnv,
  deps: AuditDeps,
  scene: { readonly url: string; readonly site?: SiteContext },
  options: { readonly areas: readonly AuditArea[]; readonly research: boolean },
  questions: AuditQuestions,
): Promise<AuditResult> {
  const areas = [...new Set(options.areas)];
  const { url } = scene;
  env.progress?.("audit: measuring the page");
  const read = await readAll(deps.probes, url, areas);
  // The stages read what the audit already measured; nothing is fetched twice.
  const settled: Probes = {
    seo: () => Promise.resolve(read.seo!),
    performance: () => Promise.resolve(read.performance!),
    accessibility: () => Promise.resolve(read.accessibility!),
    links: () => Promise.resolve(read.links!),
    privacy: () => Promise.resolve(read.privacy!),
    content: () => Promise.resolve(read.content),
    screenshot: deps.probes.screenshot,
  };

  const runArea = async (area: AuditArea): Promise<AreaResult> => {
    try {
      switch (area) {
        case "seo":
          return await seoStage(env, settled, scene, questions.seo);
        case "performance":
          return await performanceStage(env, settled, scene, JUDGMENT_FORM_FACTOR, questions.performance);
        case "accessibility":
          return await accessibilityStage(settled, url);
        case "links":
          return await linksStage(settled, url);
        case "privacy":
          return await privacyStage(settled, url);
      }
    } catch (error) {
      env.signal?.throwIfAborted();
      throw new Error(`audit ${area} of ${url}: ${failureOf(error)}`, { cause: error });
    }
  };
  env.progress?.("audit: judging the areas");
  const results = await mapLimit(areas, AREAS_AT_ONCE, runArea);
  const merged: Finding[] = results.flatMap((result) => result.findings);

  const measured: MeasuredAreas & { content: ContentMeasurement } = {
    ...(read.seo === undefined ? {} : { seo: read.seo }),
    ...(read.performance === undefined ? {} : { performance: read.performance }),
    content: read.content,
  };
  const [purpose, sections] = await Promise.all([
    purposeStage(env, settled, scene, questions.purpose, measured),
    sectionsStage(env, settled, scene, questions.sections, measured),
  ]);
  let interpretation: InterpretationResult;
  try {
    interpretation = await interpretationStage(env, scene, measured, purposeOf(purpose), questions.interpretation);
  } catch (error) {
    env.signal?.throwIfAborted();
    throw new Error(`audit interpretation of ${url}: ${failureOf(error)}`, { cause: error });
  }

  let researched: AuditResearch | undefined;
  if (options.research) {
    env.progress?.("audit: researching analog pages");
    let analogs: AnalogsResult;
    try {
      analogs = await analogsStage(
        env,
        { probes: deps.probes, search: deps.search },
        scene,
        measured,
        purposeOf(purpose),
        questions.analogs,
      );
    } catch (error) {
      env.signal?.throwIfAborted();
      analogs = analogsUnmeasured(url, `analogs: ${failureOf(error)}`);
    }
    let synthesis: SynthesisResult;
    try {
      synthesis = await synthesisStage(
        env,
        scene,
        measured,
        purposeOf(purpose),
        interpretation.findings,
        analogs,
        questions.synthesis,
      );
    } catch (error) {
      env.signal?.throwIfAborted();
      synthesis = { url, unmeasured: `synthesis: ${failureOf(error)}` };
    }
    researched = { analogs, synthesis };
  }

  env.progress?.("audit: ranking the findings");
  const ranking = await rankFindings(env.z, env.step, merged, { url, site: scene.site }, questions.audit, env.signal);
  // Purpose and sections both read the content probe, so either one's reason is the content area's reason.
  const contentReason = purpose.unmeasured ?? sections.unmeasured;
  const unmeasured: AuditResult["summary"]["unmeasured"] = [
    ...areas.flatMap((area, index) => {
      const reason = unmeasuredReason(results[index]!);
      return reason === undefined ? [] : [{ area, reason }];
    }),
    ...(contentReason === undefined ? [] : [{ area: "content" as const, reason: contentReason }]),
    ...researchUnmeasured(researched),
  ];
  const allAreasUnmeasured = areas.every((_, index) => unmeasuredReason(results[index]!) !== undefined);
  const health: Health = allAreasUnmeasured ? "unknown" : ranking.health;
  const counts = severityCounts(ranking.findings);
  return {
    url,
    areas: Object.fromEntries(areas.map((area, index) => [area, results[index]])) as AuditAreas,
    judgment: { purpose: omitUrl(purpose), sections: omitUrl(sections), findings: omitUrl(interpretation) },
    ...(researched === undefined ? {} : { research: researched }),
    findings: ranking.findings,
    summary: {
      health,
      finding_counts: counts,
      unmeasured,
      headline: auditHeadline(scene.site?.name ?? url, health, counts, ranking.findings[0]),
    },
  };
}
