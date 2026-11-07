import { readFileSync } from "node:fs";
import { askJson, type ModelStep } from "./omp_model.ts";
import type { SiteContext } from "./site_context.ts";
import type { Finding } from "./types.ts";

/** Findings past this many keep the severity their rule gave; one model call stays small. */
export const MAX_JUDGED_FINDINGS = 12;
/** A real-probability at or above this confirms the finding. */
export const CONFIRMED_AT = 0.5;

const JUDGED_SEVERITIES = ["high", "medium", "low"] as const;

interface QuestionFile {
  Real: { instructions: string; criteria: Record<string, string> };
  Severity: { instructions: string; criteria: Record<string, string> };
}

let loaded: QuestionFile | undefined;
function questions(): QuestionFile {
  if (loaded === undefined) {
    const parsed = Bun.YAML.parse(readFileSync(new URL("./webmaster_sitemap.yaml", import.meta.url), "utf8")) as Partial<QuestionFile>;
    if (parsed.Real === undefined || parsed.Severity === undefined) throw new Error("webmaster_sitemap.yaml needs a Real and a Severity question");
    loaded = parsed as QuestionFile;
  }
  return loaded;
}

/** One line a model reads about the site. */
export function describeSite(site: SiteContext | undefined): string {
  if (site === undefined) return "unknown site";
  return [site.name, site.tier === undefined ? "" : `${site.tier} tier`, site.platform ?? ""].filter(Boolean).join(", ");
}

export interface Judgement {
  readonly id: string;
  readonly real_probability: number;
  readonly severity: (typeof JUDGED_SEVERITIES)[number];
  readonly confidence: number;
}

const criteria = (entries: Record<string, string>): string => Object.entries(entries).map(([label, rubric]) => `- ${String(label)}: ${rubric}`).join("\n");

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    Judgement: {
      type: "array",
      description: "One element per finding, in the order given.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The finding id, copied." },
          real_probability: { type: "number", minimum: 0, maximum: 1, description: "Probability the Real question is true for this finding." },
          severity: { enum: [...JUDGED_SEVERITIES], description: "The answer to the Severity question." },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are of that severity." },
        },
        required: ["id", "real_probability", "severity", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["Judgement"],
  additionalProperties: false,
} as const;

/** What the model reads: both questions with their criteria, the site, then every finding quoted. */
export function judgementPrompt(findings: readonly Finding[], subject: string, site: string): string {
  const { Real, Severity } = questions();
  const quoted = findings.map((finding) => `- ${finding.id}: ${finding.evidence}`).join("\n");
  return [
    "## Judgement",
    "A deterministic check of one XML sitemap raised the findings quoted below. For EACH finding answer both questions, in the order the findings are given.",
    `Real: ${Real.instructions.trim()}\nReal answers:\n${criteria(Real.criteria)}\nGive the probability (0 to 1) that the answer is true.`,
    `Severity: ${Severity.instructions.trim()}\nSeverity answers:\n${criteria(Severity.criteria)}`,
    `Sitemap: ${subject}\nSite: ${site}\n\nFindings:\n${quoted}`,
    `Respond as JSON matching this schema:\n${JSON.stringify(REPLY_SCHEMA)}`,
  ].join("\n\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const probability = (value: unknown, where: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${where}: expected a number from 0 to 1`);
  return value;
};

/** The reply as one judgement per finding, in order. Throws, naming the field, when the reply is not that. */
export function parseJudgements(value: unknown, findings: readonly Finding[]): Judgement[] {
  if (!isRecord(value) || !Array.isArray(value["Judgement"])) throw new Error("reply: expected {\"Judgement\": [...]}");
  const items = value["Judgement"] as unknown[];
  if (items.length !== findings.length) throw new Error(`Judgement: expected ${findings.length} elements (one per finding), got ${items.length}`);
  return items.map((item, index) => {
    const where = `Judgement[${index}]`;
    if (!isRecord(item)) throw new Error(`${where}: expected an object`);
    const expected = findings[index]!.id;
    if (item["id"] !== expected) throw new Error(`${where}.id: expected "${expected}" (findings in the order given)`);
    const severity = item["severity"];
    if (!JUDGED_SEVERITIES.includes(severity as never)) throw new Error(`${where}.severity: expected high, medium or low`);
    return {
      id: expected,
      real_probability: probability(item["real_probability"], `${where}.real_probability`),
      severity: severity as Judgement["severity"],
      confidence: probability(item["confidence"], `${where}.confidence`),
    };
  });
}

/**
 * Asks the model, in one call, whether each finding is real for this site and how severe it is. A finding the model does
 * not confirm drops to `info`. The rules found the findings; the model only confirms and ranks them. Findings past
 * `MAX_JUDGED_FINDINGS` keep their rule severity. Throws when the model never gave a valid reply.
 */
export async function judgeFindings(
  findings: readonly Finding[],
  scene: { subject: string; site: string },
  model: ModelStep,
  signal?: AbortSignal,
): Promise<Finding[]> {
  const judged = findings.slice(0, MAX_JUDGED_FINDINGS);
  if (judged.length === 0) return [...findings];
  const judgements = await askJson(
    model,
    judgementPrompt(judged, scene.subject, scene.site),
    (reply) => parseJudgements(reply, judged),
    signal === undefined ? {} : { signal },
  );
  return [
    ...judged.map((finding, index): Finding => {
      const answer = judgements[index]!;
      return {
        ...finding,
        severity: answer.real_probability >= CONFIRMED_AT ? answer.severity : "info",
        confidence: answer.confidence,
      };
    }),
    ...findings.slice(MAX_JUDGED_FINDINGS),
  ];
}
