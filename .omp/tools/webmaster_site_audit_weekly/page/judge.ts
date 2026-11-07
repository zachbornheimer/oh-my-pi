import type { Finding } from "./finding.ts";
import { askJson, type ModelStep } from "./omp_model.ts";
import { criteriaLines, type DecisionQuestion, type QuestionFile } from "./questions.ts";
import type { Zod } from "./zod_type.ts";

export const REAL_QUESTION = "Real";
export const SEVERITY_QUESTION = "Severity";

/** Findings past this many keep the severity their rule gave; one model call stays small. */
export const MAX_JUDGED_FINDINGS = 12;

const JUDGED_SEVERITIES = ["high", "medium", "low"] as const;

/** What the model is told about the page the findings belong to. */
export interface JudgedScene {
  readonly subject: string;
  readonly site: string;
}

export function decisionNamed(file: QuestionFile, field: string): DecisionQuestion {
  const found = file.decisions.find((question) => question.field === field);
  if (found === undefined) throw new Error(`question file has no ${field} question`);
  return found;
}

/** A decision question as the section of a prompt a model answers: its instructions, then each answer and what it means. */
export const questionSection = (question: DecisionQuestion): string =>
  [`### ${question.field}`, question.instructions, "Answers:", ...criteriaLines(question)].join("\n");

/**
 * Asks a model, in one call, whether each finding is real for this site and how severe it is. A finding the model
 * does not confirm drops to `info`; a confirmed one takes the severity the model gave and its stated confidence (0 to
 * 1) in it. The rules found the findings; the model only confirms and ranks them. Fields a tool adds to its findings
 * ride through unchanged. A reply that skips or repeats a finding, or names one that was not asked, is asked again.
 */
export async function judgeFindings<F extends Finding>(
  z: Zod,
  step: ModelStep,
  findings: readonly F[],
  scene: JudgedScene,
  file: QuestionFile,
  signal?: AbortSignal,
): Promise<F[]> {
  const judged = findings.slice(0, MAX_JUDGED_FINDINGS);
  if (judged.length === 0) return [...findings];
  const prompt = [
    `A deterministic check raised the findings listed below on one web page (${scene.subject}). Site: ${scene.site}.`,
    "Answer both questions below for EACH finding.",
    "",
    questionSection(decisionNamed(file, REAL_QUESTION)),
    "",
    questionSection(decisionNamed(file, SEVERITY_QUESTION)),
    "",
    "## Findings",
    ...judged.map((finding) => `- ${finding.id}: ${finding.evidence}`),
    "",
    'Respond as JSON: {"findings":[{"id":"<finding id>","real":true|false,"severity":"high"|"medium"|"low","confidence":<number 0 to 1: how sure you are of the severity>}]}',
    "with exactly one entry per finding id listed above and no other id. Answer with only that JSON object, no prose and no code fence.",
  ].join("\n");
  const answer = z.object({
    findings: z.array(z.object({
      id: z.string(),
      real: z.boolean(),
      severity: z.enum(JUDGED_SEVERITIES),
      confidence: z.number().min(0).max(1),
    })),
  });
  const verdicts = await askJson(step, prompt, (value) => {
    const parsed = answer.parse(value);
    const byId = new Map(parsed.findings.map((entry) => [entry.id, entry]));
    const wanted = new Set(judged.map((finding) => finding.id));
    const missing = judged.filter((finding) => !byId.has(finding.id)).map((finding) => finding.id);
    const extra = parsed.findings.filter((entry) => !wanted.has(entry.id)).map((entry) => entry.id);
    if (missing.length > 0 || extra.length > 0 || byId.size !== parsed.findings.length) {
      throw new Error(
        `answer every listed finding exactly once and no other (missing: ${missing.join(", ") || "none"}; unknown: ${
          extra.join(", ") || "none"
        }; repeated ids are refused)`,
      );
    }
    return byId;
  }, { signal });
  return [
    ...judged.map((finding) => {
      const verdict = verdicts.get(finding.id)!;
      return {
        ...finding,
        severity: verdict.real ? verdict.severity : ("info" as const),
        confidence: verdict.confidence,
      };
    }),
    ...findings.slice(MAX_JUDGED_FINDINGS),
  ];
}
