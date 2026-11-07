import { askLanguage, languageNamed } from "./language.ts";
import { analogsGround, interpretationGround, measuredGroundTruth, purposeGround, type MeasuredAreas } from "./measured_brief.ts";
import type { QuestionFile } from "./questions.ts";
import { type AnalogsResult, type AuditFinding, type PagePurpose, replySchemas, type SynthesisResult } from "./schemas.ts";
import type { SiteContext } from "./site_context.ts";
import type { StageEnv } from "./stage_types.ts";
import { validateSynthesis } from "./validate_synthesis.ts";

/**
 * What a world-class version of one page would do, from CURRENT (this page), REMOTE (the supplied analogs) and
 * EXTERNAL (named outside examples). Its inputs are the purpose, the interpretation findings and the analogs, which the
 * caller supplies; a page whose purpose is not auditable returns `{ url, unmeasured }`.
 */
export async function synthesisStage(
  env: StageEnv,
  scene: { readonly url: string; readonly site?: SiteContext },
  measured: MeasuredAreas,
  purpose: PagePurpose,
  interpretation: readonly AuditFinding[],
  analogs: Pick<AnalogsResult, "sameIndustry" | "differentIndustry">,
  questions: QuestionFile,
): Promise<SynthesisResult> {
  if (purpose.intentClass === "not auditable") return { url: scene.url, unmeasured: purpose.purpose };
  const supplied = [...analogs.sameIndustry, ...analogs.differentIndustry];
  const reply = replySchemas(env.z).synthesis;
  env.progress?.("synthesis: judging the evidence");
  const answered = await askLanguage(
    env,
    languageNamed(questions, "Synthesis"),
    [
      "## CURRENT",
      "",
      ...purposeGround(purpose),
      ...interpretationGround(interpretation),
      "",
      measuredGroundTruth({ url: scene.url, site: scene.site, measurements: measured }),
      "",
      "## REMOTE",
      "",
      analogsGround(supplied),
    ].join("\n"),
    (value) => env.z.object({ Synthesis: reply }).parse(value).Synthesis,
  );
  return { url: scene.url, ...validateSynthesis(answered, supplied.length) };
}
