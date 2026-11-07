import { bySeverity, type Finding, SEVERITIES, type Severity } from "./finding.ts";
import { decisionNamed, questionSection } from "./judge.ts";
import { askJson, type ModelStep } from "./omp_model.ts";
import type { QuestionFile } from "./questions.ts";
import type { Zod } from "./zod_type.ts";
import { describeSite, type SiteContext } from "./site_context.ts";

export const PRIORITY_QUESTION = "Priority";
export const HEALTH_QUESTION = "Health";

export const HEALTHS = ["healthy", "needs_attention", "critical", "unknown"] as const;
export type Health = (typeof HEALTHS)[number];

/** Priority levels the model picks from: the index of the level it chose (0 ignore, 1 later, 2 soon, 3 now). */
export const PRIORITY_IGNORE = 0;
const PRIORITY_LEVELS = 4;
export const MAX_RANKED_FINDINGS = 40;

export interface RankedFinding extends Finding {
  /** How soon the audit says to fix it: 0 ignore, 1 later, 2 soon, 3 now. */
  priority: number;
  /** 1 is the finding to fix first. */
  rank: number;
}

export interface Ranking {
  readonly findings: RankedFinding[];
  readonly health: Health;
}

/** Highest priority first, then worst severity, then the order the findings came in. */
export function orderedByPriority(findings: readonly Finding[], priorities: ReadonlyMap<string, number>): RankedFinding[] {
  return findings
    .map((finding, index) => ({ finding, index, priority: priorities.get(finding.id) ?? PRIORITY_IGNORE }))
    .sort((a, b) => b.priority - a.priority || bySeverity(a.finding, b.finding) || a.index - b.index)
    .map(({ finding, priority }, position) => ({ ...finding, priority, rank: position + 1 }));
}

/** Counts of findings by severity, every severity present. */
export function severityCounts(findings: readonly Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * Ranks the merged findings of an audit with one model call: a priority per finding and the page's overall health.
 * With no findings there is nothing to rank and no model is asked. Finding ids repeat across areas only by mistake;
 * a repeated id is refused rather than ranked twice.
 */
export async function rankFindings(
  z: Zod,
  step: ModelStep,
  findings: readonly Finding[],
  scene: { readonly url: string; readonly site: SiteContext | undefined },
  file: QuestionFile,
  signal?: AbortSignal,
): Promise<Ranking> {
  if (findings.length === 0) return { findings: [], health: "healthy" };
  const asked = findings.slice(0, MAX_RANKED_FINDINGS);
  const prompt = [
    `A webmaster audited one web page (${scene.url}) across several areas. Site: ${describeSite(scene.site)}.`,
    "Answer the Priority question for EACH finding, then the Health question once for the whole page.",
    "",
    questionSection(decisionNamed(file, PRIORITY_QUESTION)),
    "",
    questionSection(decisionNamed(file, HEALTH_QUESTION)),
    "",
    "## Findings",
    ...asked.map((finding) => `- ${finding.id} (${finding.area}, ${finding.severity}): ${finding.evidence}`),
    "",
    'Respond as JSON: {"priorities":[{"id":"<finding id>","level":<0, 1, 2 or 3>}],"health":"healthy"|"needs_attention"|"critical"}',
    "with exactly one priority entry per finding id listed above and no other id. Answer with only that JSON object, no prose and no code fence.",
  ].join("\n");
  const answer = z.object({
    priorities: z.array(z.object({ id: z.string(), level: z.number().int().min(0).max(PRIORITY_LEVELS - 1) })),
    health: z.enum(["healthy", "needs_attention", "critical"]),
  });
  const ranked = await askJson(step, prompt, (value) => {
    const parsed = answer.parse(value);
    const byId = new Map(parsed.priorities.map((entry) => [entry.id, entry.level]));
    const wanted = new Set(asked.map((finding) => finding.id));
    const missing = [...wanted].filter((id) => !byId.has(id));
    const extra = parsed.priorities.filter((entry) => !wanted.has(entry.id)).map((entry) => entry.id);
    if (missing.length > 0 || extra.length > 0 || byId.size !== parsed.priorities.length) {
      throw new Error(
        `answer every listed finding exactly once and no other (missing: ${missing.join(", ") || "none"}; unknown: ${
          extra.join(", ") || "none"
        }; repeated ids are refused)`,
      );
    }
    return { priorities: byId, health: parsed.health };
  }, { signal });
  return { findings: orderedByPriority(findings, ranked.priorities), health: ranked.health };
}
