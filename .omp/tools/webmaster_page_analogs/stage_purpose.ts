import { languageNamed, askLanguage } from "./language.ts";
import { type MeasuredAreas, measuredGroundTruth } from "./measured_brief.ts";
import type { ContentMeasurement } from "./measurement.ts";
import type { QuestionFile } from "./questions.ts";
import { type PagePurpose, type PurposeResult, replySchemas } from "./schemas.ts";
import type { SiteContext } from "./site_context.ts";
import type { Probes, StageEnv } from "./stage_types.ts";

export const NOT_AUDITABLE_FIELD = "not auditable" as const;

/** The typed answer a page whose content could not be judged gets, every judgment field `not auditable`. */
export function notAuditable(url: string, reason: string): PurposeResult {
  return {
    url,
    purpose: `not auditable: ${reason}`,
    intentClass: NOT_AUDITABLE_FIELD,
    primaryAudience: NOT_AUDITABLE_FIELD,
    primaryAction: NOT_AUDITABLE_FIELD,
    evidence: [],
    unmeasured: reason,
  };
}

/** The purpose judgment's five fields, the part of the purpose result that is not the url wrapper. */
export function purposeOf(result: PurposeResult): PagePurpose {
  return {
    purpose: result.purpose,
    intentClass: result.intentClass,
    primaryAudience: result.primaryAudience,
    primaryAction: result.primaryAction,
    evidence: result.evidence,
  };
}

/** What the content-reading stages read: the content measurement always, with whichever other areas were measured. */
export type JudgmentMeasured = MeasuredAreas & { readonly content: ContentMeasurement };

/** What the content-reading stages measure: the page's text and its search facts, read at once. */
export async function contentAndSeo(probes: Pick<Probes, "content" | "seo">, url: string): Promise<JudgmentMeasured> {
  const [content, seo] = await Promise.all([probes.content(url), probes.seo(url)]);
  return { content, seo };
}

/** The PAGE PURPOSE stage of one page: what it appears to exist to accomplish, judged from the measured ground truth. */
export async function purposeStage(
  env: StageEnv,
  probes: Pick<Probes, "content" | "seo">,
  scene: { readonly url: string; readonly site?: SiteContext },
  questions: QuestionFile,
  measured?: Awaited<ReturnType<typeof contentAndSeo>>,
): Promise<PurposeResult> {
  const measurements = measured ?? (await contentAndSeo(probes, scene.url));
  if (measurements.content.status === "unmeasured") return notAuditable(scene.url, measurements.content.reason);
  const reply = replySchemas(env.z).purpose;
  env.progress?.("purpose: judging the page");
  const answered = await askLanguage(
    env,
    languageNamed(questions, "Purpose"),
    measuredGroundTruth({ url: scene.url, site: scene.site, measurements }),
    (value) => env.z.object({ Purpose: reply }).parse(value).Purpose,
  );
  return { url: scene.url, ...answered };
}
