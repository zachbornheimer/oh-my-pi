import { languageNamed, askLanguage } from "./language.ts";
import { type MeasuredAreas, measuredGroundTruth, purposeGround } from "./measured_brief.ts";
import type { FormFactor } from "./measurement.ts";
import type { QuestionFile } from "./questions.ts";
import { type InterpretationResult, type PagePurpose, replySchemas } from "./schemas.ts";
import type { SiteContext } from "./site_context.ts";
import type { Probes, StageEnv } from "./stage_types.ts";

export const NO_MEASUREMENT_REASON = "no probe measured this page";
/** The device profile the page's judgments read speed under. */
export const JUDGMENT_FORM_FACTOR: FormFactor = "mobile";

/** The three measurements the interpretation and synthesis judgments read: seo, speed (mobile) and content, read at once. */
export async function everyMeasurement(
  probes: Pick<Probes, "seo" | "performance" | "content">,
  url: string,
): Promise<Required<MeasuredAreas>> {
  const [seo, performance, content] = await Promise.all([
    probes.seo(url),
    probes.performance(url, JUDGMENT_FORM_FACTOR),
    probes.content(url),
  ]);
  return { seo, performance, content };
}

const reasonOf = (measurement: { status: string; reason?: string }): string | undefined =>
  measurement.status === "unmeasured" ? measurement.reason : undefined;

/**
 * The INTERPRETATION stage of one page: what the measurements mean for this page and its apparent purpose. The purpose
 * is its declared input and is supplied by the caller (`purposeStage` produces it).
 */
export async function interpretationStage(
  env: StageEnv,
  scene: { readonly url: string; readonly site?: SiteContext },
  measured: MeasuredAreas,
  purpose: PagePurpose,
  questions: QuestionFile,
): Promise<InterpretationResult> {
  const areas = [measured.seo, measured.performance, measured.content].filter((area) => area !== undefined);
  if (areas.every((area) => area.status !== "measured")) {
    const reason = areas.map(reasonOf).find((r) => r !== undefined);
    return { url: scene.url, findings: [], unmeasured: reason ?? NO_MEASUREMENT_REASON };
  }
  const reply = replySchemas(env.z).findings;
  env.progress?.("interpretation: judging the measurements");
  const findings = await askLanguage(
    env,
    languageNamed(questions, "Findings"),
    [
      ...purposeGround(purpose),
      "",
      measuredGroundTruth({ url: scene.url, site: scene.site, measurements: measured }),
    ].join("\n"),
    (value) => env.z.object({ Findings: reply }).parse(value).Findings,
  );
  return { url: scene.url, findings };
}
