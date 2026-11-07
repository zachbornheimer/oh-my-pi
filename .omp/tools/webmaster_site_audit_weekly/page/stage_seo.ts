import type { Finding } from "./finding.ts";
import { judgeFindings } from "./judge.ts";
import { describeSite, type SiteContext } from "./site_context.ts";
import type { QuestionFile } from "./questions.ts";
import { type SeoFacts, seoFacts, seoFindings } from "./seo_rules.ts";
import type { Probes, StageEnv } from "./stage_types.ts";

export interface SeoResult {
  url: string;
  facts?: SeoFacts;
  findings: Finding[];
  unmeasured?: string;
}

/** The SEO of one live page: facts read by the probe, findings raised by rules, each confirmed and ranked by one model call. */
export async function seoStage(
  env: StageEnv,
  probes: Pick<Probes, "seo">,
  scene: { readonly url: string; readonly site?: SiteContext },
  questions: QuestionFile,
): Promise<SeoResult> {
  const page = await probes.seo(scene.url);
  if (page.status === "unmeasured") return { url: scene.url, findings: [], unmeasured: page.reason };
  const found = seoFindings(page);
  env.progress?.("seo: judging findings");
  const findings = await judgeFindings(
    env.z,
    env.step,
    found,
    { subject: page.final_url, site: describeSite(scene.site) },
    questions,
    env.signal,
  );
  return { url: scene.url, facts: seoFacts(page), findings };
}
