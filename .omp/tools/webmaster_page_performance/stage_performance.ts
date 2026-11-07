import type { Finding } from "./finding.ts";
import { judgeFindings } from "./judge.ts";
import type { FormFactor, PerformanceMetrics, PerformanceSource } from "./measurement.ts";
import type { QuestionFile } from "./questions.ts";
import { performanceFindings, tonesOf, type Tones } from "./performance_rules.ts";
import { describeSite, type SiteContext } from "./site_context.ts";
import type { Probes, StageEnv } from "./stage_types.ts";

export interface PerformanceResult {
  url: string;
  form_factor: FormFactor;
  metrics?: PerformanceMetrics;
  tones: Tones;
  findings: Finding[];
  source: PerformanceSource | "unmeasured";
  reason?: string;
}

/** Findings that sit past a `poor` line stand as they are; only the borderline ones are put to the model. */
const needsJudgement = (finding: Finding): boolean => finding.severity === "medium";

/** The speed of one live page: metrics from the probe, a tone per metric from the shared thresholds, a model only for borderline findings. */
export async function performanceStage(
  env: StageEnv,
  probes: Pick<Probes, "performance">,
  scene: { readonly url: string; readonly site?: SiteContext },
  formFactor: FormFactor,
  questions: QuestionFile,
): Promise<PerformanceResult> {
  const page = await probes.performance(scene.url, formFactor);
  if (page.status === "unmeasured") {
    return { url: scene.url, form_factor: formFactor, tones: {}, findings: [], source: "unmeasured", reason: page.reason };
  }
  const tones = tonesOf(page.metrics);
  const found = performanceFindings(page.metrics, tones);
  const borderline = found.filter(needsJudgement);
  let judged: Finding[] = [];
  if (borderline.length > 0) {
    env.progress?.("performance: judging borderline findings");
    judged = await judgeFindings(
      env.z,
      env.step,
      borderline,
      { subject: scene.url, site: describeSite(scene.site) },
      questions,
      env.signal,
    );
  }
  const byId = new Map(judged.map((finding) => [finding.id, finding]));
  return {
    url: scene.url,
    form_factor: page.form_factor,
    metrics: page.metrics,
    tones,
    findings: found.map((finding) => byId.get(finding.id) ?? finding),
    source: page.source,
  };
}
