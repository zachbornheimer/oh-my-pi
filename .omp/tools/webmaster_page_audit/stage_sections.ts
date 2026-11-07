import { languageNamed, askLanguage } from "./language.ts";
import { measuredGroundTruth } from "./measured_brief.ts";
import type { QuestionFile } from "./questions.ts";
import { replySchemas, type SectionsResult } from "./schemas.ts";
import type { SiteContext } from "./site_context.ts";
import { contentAndSeo, type JudgmentMeasured } from "./stage_purpose.ts";
import type { Probes, StageEnv } from "./stage_types.ts";

/** The SECTIONS stage of one page: its major sections in page order, judged from the measured ground truth. */
export async function sectionsStage(
  env: StageEnv,
  probes: Pick<Probes, "content" | "seo">,
  scene: { readonly url: string; readonly site?: SiteContext },
  questions: QuestionFile,
  measured?: JudgmentMeasured,
): Promise<SectionsResult> {
  const measurements = measured ?? (await contentAndSeo(probes, scene.url));
  if (measurements.content.status === "unmeasured") {
    return { url: scene.url, sections: [], unmeasured: measurements.content.reason };
  }
  const reply = replySchemas(env.z).sections;
  env.progress?.("sections: judging the page");
  const sections = await askLanguage(
    env,
    languageNamed(questions, "Sections"),
    measuredGroundTruth({ url: scene.url, site: scene.site, measurements }),
    (value) => env.z.object({ Sections: reply }).parse(value).Sections,
  );
  return { url: scene.url, sections };
}
