import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJson, type Exec, type ModelStep, parseJsonReply } from "./omp_model.js";

export const ROOT_CAUSE_CATEGORIES = [
  "inefficient_tool_calls",
  "reasoning",
  "wild_goose_chase",
  "bad_instructions",
  "normal_code_writing",
  "other",
] as const;
export type RootCauseCategory = (typeof ROOT_CAUSE_CATEGORIES)[number];

export interface RootCause {
  category: RootCauseCategory;
  why: string;
  evidence: { session_ids: string[]; detail: string };
  estimated_share: number;
}
export interface Recommendation {
  change: string;
  saving: string;
}
export interface LinearIssue {
  action: "create" | "compound";
  title: string;
  summary: string;
  link?: string;
}
export interface QuotaReviewAnswer {
  summary: string;
  root_causes: RootCause[];
  recommendations: Recommendation[];
  linear_issues: LinearIssue[];
}

export interface ReviewState {
  limits_table: string;
  census: string;
}

function isRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function nonEmpty(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${where} must be a non-empty string`);
  return value;
}
function list(value: unknown, where: string, min = 0): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  if (value.length < min) throw new Error(`${where} must have at least ${min} item(s)`);
  return value;
}
function noExtra(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${where} has unexpected property "${key}"`);
}

/** Validates the reviewer's reply against the schema in quota_burn_review.yaml; throws with the first mismatch. */
export function validateReviewAnswer(value: unknown): QuotaReviewAnswer {
  const root = isRecord(value, "answer");
  noExtra(root, ["summary", "root_causes", "recommendations", "linear_issues"], "answer");
  const summary = nonEmpty(root.summary, "summary");
  const root_causes = list(root.root_causes, "root_causes", 1).map((raw, i): RootCause => {
    const where = `root_causes[${i}]`;
    const c = isRecord(raw, where);
    noExtra(c, ["category", "why", "evidence", "estimated_share"], where);
    if (!(ROOT_CAUSE_CATEGORIES as readonly unknown[]).includes(c.category)) {
      throw new Error(`${where}.category must be one of ${ROOT_CAUSE_CATEGORIES.join(", ")}`);
    }
    const e = isRecord(c.evidence, `${where}.evidence`);
    noExtra(e, ["session_ids", "detail"], `${where}.evidence`);
    const share = c.estimated_share;
    if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) {
      throw new Error(`${where}.estimated_share must be a number between 0 and 1`);
    }
    return {
      category: c.category as RootCauseCategory,
      why: nonEmpty(c.why, `${where}.why`),
      evidence: {
        session_ids: list(e.session_ids, `${where}.evidence.session_ids`, 1).map((id, j) => nonEmpty(id, `${where}.evidence.session_ids[${j}]`)),
        detail: nonEmpty(e.detail, `${where}.evidence.detail`),
      },
      estimated_share: share,
    };
  });
  const recommendations = list(root.recommendations, "recommendations", 1).map((raw, i): Recommendation => {
    const where = `recommendations[${i}]`;
    const r = isRecord(raw, where);
    noExtra(r, ["change", "saving"], where);
    return { change: nonEmpty(r.change, `${where}.change`), saving: nonEmpty(r.saving, `${where}.saving`) };
  });
  const linear_issues = list(root.linear_issues, "linear_issues").map((raw, i): LinearIssue => {
    const where = `linear_issues[${i}]`;
    const r = isRecord(raw, where);
    noExtra(r, ["action", "title", "summary", "link"], where);
    if (r.action !== "create" && r.action !== "compound") throw new Error(`${where}.action must be "create" or "compound"`);
    const issue: LinearIssue = { action: r.action, title: nonEmpty(r.title, `${where}.title`), summary: nonEmpty(r.summary, `${where}.summary`) };
    if (r.link !== undefined) issue.link = nonEmpty(r.link, `${where}.link`);
    return issue;
  });
  return { summary, root_causes, recommendations, linear_issues };
}

export interface PromptSpec {
  instructions: string;
  schema: unknown;
}

/** Reads the question file shipped next to this module: the reviewer's instructions and its JSON schema. */
export async function loadPromptSpec(file: string = join(import.meta.dir, "quota_burn_review.yaml")): Promise<PromptSpec> {
  const parsed = Bun.YAML.parse(await readFile(file, "utf8")) as { QuotaBurnReview?: { instructions?: unknown; schema?: unknown } };
  const question = parsed.QuotaBurnReview;
  if (typeof question?.instructions !== "string" || question.schema === undefined) {
    throw new Error(`${file} has no QuotaBurnReview.instructions and schema`);
  }
  return { instructions: question.instructions, schema: question.schema };
}

/** The instructions with the quota table and census substituted for `{limits_table}` and `{census}`. */
export function fillInstructions(spec: PromptSpec, state: ReviewState): string {
  return spec.instructions.replace("{limits_table}", () => state.limits_table).replace("{census}", () => state.census);
}

export function reviewPrompt(spec: PromptSpec, state: ReviewState): string {
  return [
    fillInstructions(spec, state),
    "",
    "## Output",
    "Reply with ONLY one JSON object (no prose, no code fence) matching this JSON Schema:",
    JSON.stringify(spec.schema, null, 2),
  ].join("\n");
}

/** The structured answer: one `askJson` loop (3 attempts, the rejection reason shown on each retry) validated in code. */
export function askQuotaReview(step: ModelStep, spec: PromptSpec, state: ReviewState, signal?: AbortSignal): Promise<QuotaReviewAnswer> {
  return askJson(step, reviewPrompt(spec, state), validateReviewAnswer, { signal });
}

/** The report markdown rendered from the structured answer. */
export function renderReview(answer: QuotaReviewAnswer): string {
  const lines: string[] = ["## Quota Burn Review", "", answer.summary, "", "### Root Causes (why the quota was spent)", ""];
  answer.root_causes.forEach((cause, index) => {
    const share = `${Math.round(cause.estimated_share * 100)}%`;
    const evidence = `${cause.evidence.session_ids.map((id) => `\`${id}\``).join(", ")} — ${cause.evidence.detail}`;
    lines.push(`${index + 1}. **${cause.category}** (${share} of the burn) — ${cause.why}`, `   - Evidence: ${evidence}`);
  });
  lines.push("", "### Recommendations", "");
  for (const r of answer.recommendations) lines.push(`- **${r.change}** — ${r.saving}`);
  if (answer.linear_issues.length > 0) {
    lines.push("", "### Linear Issues", "");
    for (const issue of answer.linear_issues) {
      const link = issue.link === undefined ? "" : ` — ${issue.link}`;
      lines.push(`- **[${issue.action}]** ${issue.title}: ${issue.summary}${link}`);
    }
  }
  return lines.join("\n");
}

/** Files the answer's Linear issues and returns them with their links. Throws on any failure; never partial. */
export type FilePort = (answer: QuotaReviewAnswer, state: ReviewState, signal?: AbortSignal) => Promise<LinearIssue[]>;

export function linearFilingPrompt(spec: PromptSpec, state: ReviewState, answer: QuotaReviewAnswer): string {
  const issues = answer.linear_issues.map((issue, index) => `${index + 1}. [${issue.action}] ${issue.title}: ${issue.summary}${issue.link ? ` (existing: ${issue.link})` : ""}`).join("\n");
  return [
    fillInstructions(spec, state),
    "",
    "## Linear Filing",
    "Using the `linear-personal` MCP tools, search Personal Linear (`Zysys` / `AI Tooling`) and create or compound these token-efficiency issues, at most 1-2 high-ROI ones not already covered:",
    issues,
    "",
    "When done, reply with ONLY one JSON object (no prose, no code fence): "
      + `{"filed":[{"title":"<issue title>","url":"https://linear.app/..."}]} with exactly one entry per issue above, in the same order, each with the real Linear issue URL you created or compounded into.`,
  ].join("\n");
}

const LINEAR_URL = /^https:\/\/linear\.app\/\S+$/;

/** Validates the filing reply: one Linear URL per issue, in order; returns the issues with those links. */
export function parseFilingReply(reply: string, issues: readonly LinearIssue[]): LinearIssue[] {
  const root = isRecord(parseJsonReply(reply), "filing reply");
  const filed = list(root.filed, "filing reply.filed");
  if (filed.length !== issues.length) throw new Error(`filing reply listed ${filed.length} issue(s) for ${issues.length} requested`);
  return issues.map((issue, i) => {
    const entry = isRecord(filed[i], `filing reply.filed[${i}]`);
    const url = nonEmpty(entry.url, `filing reply.filed[${i}].url`);
    if (!LINEAR_URL.test(url)) throw new Error(`filing reply.filed[${i}].url is not a https://linear.app URL: ${url}`);
    return { ...issue, link: url };
  });
}

/** Flags for the filing run: a full omp session (MCP tools stay on), but no session file, title, pty or repo context. */
export const FILING_OMP_FLAGS = ["--no-session", "--no-title", "--no-pty", "--no-rules", "--no-context-files"] as const;
export const FILING_TIMEOUT_MS = 600_000;

/**
 * The live FilePort: ONE full `omp -p` run (so the user's Linear MCP tools are available) whose printed JSON is
 * validated. It is not retried: a second run could file the same issues twice.
 */
export function ompFilePort(exec: Exec, spec: PromptSpec, options: { timeoutMs?: number } = {}): FilePort {
  return async (answer, state, signal) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "quota-burn-filing-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, linearFilingPrompt(spec, state, answer), { mode: 0o600 });
      const timeout = options.timeoutMs ?? FILING_TIMEOUT_MS;
      const result = await exec("omp", ["-p", `@${file}`, ...FILING_OMP_FLAGS], { signal, timeout, cwd: directory });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`Linear filing run was killed after ${timeout / 1000} s; issues may or may not have been filed`);
      }
      if (result.code !== 0) throw new Error(`Linear filing run exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      return parseFilingReply(result.stdout, answer.linear_issues);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
