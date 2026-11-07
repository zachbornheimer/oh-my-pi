import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QuotaLimitRow } from "./census.js";
import { type ClaimStore, quotaPeriodKey } from "./claims.js";
import type { ModelStep } from "./omp_model.js";
import {
  askQuotaReview,
  type FilePort,
  type LinearIssue,
  type PromptSpec,
  type QuotaReviewAnswer,
  type Recommendation,
  renderReview,
  type RootCause,
} from "./review.js";

export interface QuotaReviewInput {
  threshold_used_fraction: number;
  days: number;
  re_review: boolean;
}

export interface QuotaReviewOutput {
  status: "reviewed" | "no_low_quotas" | "already_reviewed";
  triggered_limits: QuotaLimitRow[];
  census_markdown: string;
  report_path?: string;
  review_markdown?: string;
  summary?: string;
  root_causes: RootCause[];
  recommendations: Recommendation[];
  linear_issues: LinearIssue[];
}

/** Everything the workflow touches outside itself; tests substitute every member. */
export interface Ports {
  queryQuotas(threshold: number): QuotaLimitRow[] | Promise<QuotaLimitRow[]>;
  census(days: number): Promise<string>;
  claims: ClaimStore;
  step: ModelStep;
  spec: PromptSpec;
  filer: FilePort;
  reportDir: string;
  now(): number;
  progress?(phase: string): void;
}

export function limitsTableOf(limits: readonly QuotaLimitRow[]): string {
  return [
    "## Weekly Quotas at <= 10% Remaining",
    "| Provider | Account | Limit | Window | Used % | Remaining % | Status | Resets (UTC) |",
    "|---|---|---|---|---:|---:|---|---|",
    ...limits.map(
      (l) =>
        `| \`${l.provider}\` | \`${l.email ?? l.account_key}\` | \`${l.limit_id}\` (${l.label}) | ${l.window_label ?? "Weekly"} | ${(l.used_fraction * 100).toFixed(1)}% | ${l.remaining_pct.toFixed(1)}% | ${l.status ?? "warning"} | ${l.resets_at ? new Date(l.resets_at).toISOString() : "unknown"} |`,
    ),
  ].join("\n");
}

async function writeReport(dir: string, now: number, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${name}-${stamp}.md`);
  await writeFile(path, body, "utf8");
  return path;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runQuotaBurnReview(input: QuotaReviewInput, ports: Ports, signal?: AbortSignal): Promise<QuotaReviewOutput> {
  const empty = { root_causes: [], recommendations: [], linear_issues: [] };
  ports.progress?.("querying weekly quotas");
  const triggered = await ports.queryQuotas(input.threshold_used_fraction);
  if (triggered.length === 0) return { status: "no_low_quotas", triggered_limits: [], census_markdown: "", ...empty };

  const keyOf = (row: QuotaLimitRow): string => quotaPeriodKey(row, ports.now());
  const keys = triggered.map(keyOf);
  if (input.re_review) await ports.claims.release(keys);
  const claimed = await ports.claims.claim(keys);
  const unreviewed = triggered.filter((row) => claimed.includes(keyOf(row)));
  if (unreviewed.length === 0) return { status: "already_reviewed", triggered_limits: triggered, census_markdown: "", ...empty };

  const claimedKeys = [...new Set(unreviewed.map(keyOf))];
  try {
    signal?.throwIfAborted();
    ports.progress?.("computing census");
    const census = await ports.census(input.days);
    const state = { limits_table: limitsTableOf(unreviewed), census };
    ports.progress?.("running model review");
    const answer = await askQuotaReview(ports.step, ports.spec, state, signal);

    let filed: QuotaReviewAnswer = answer;
    if (answer.linear_issues.length > 0) {
      ports.progress?.("filing Linear issues");
      try {
        filed = { ...answer, linear_issues: await ports.filer(answer, state, signal) };
      } catch (error) {
        const unfiled = await writeReport(
          ports.reportDir,
          ports.now(),
          "quota-burn-review-UNFILED",
          `${state.limits_table}\n\n${census}\n\n---\n\n**Linear filing failed: ${message(error)}**\n\n${renderReview(answer)}\n`,
        );
        throw new Error(`Linear filing failed: ${message(error)}. The review was saved, unfiled, to ${unfiled}.`);
      }
    }

    const review_markdown = renderReview(filed);
    const reportPath = await writeReport(ports.reportDir, ports.now(), "quota-burn-review", `${state.limits_table}\n\n${census}\n\n---\n\n${review_markdown}\n`);
    await ports.claims.markReviewed(claimedKeys, reportPath);
    return {
      status: "reviewed",
      triggered_limits: unreviewed,
      census_markdown: census,
      report_path: reportPath,
      review_markdown,
      summary: filed.summary,
      root_causes: filed.root_causes,
      recommendations: filed.recommendations,
      linear_issues: filed.linear_issues,
    };
  } catch (error) {
    // Return the claim to a retryable state so one transient failure does not silence this period; the error still fails the run.
    await ports.claims.markFailed(claimedKeys, message(error)).catch(() => undefined);
    throw error;
  }
}

export function outcomeText(output: QuotaReviewOutput): string {
  if (output.status === "no_low_quotas") return "No weekly quota is at or above the threshold; nothing reviewed.";
  if (output.status === "already_reviewed") {
    return `Every triggered quota period (${output.triggered_limits.length} limit(s)) is already claimed or reviewed; nothing run. Pass re_review: true to review them again.`;
  }
  return [`Quota burn review written to ${output.report_path}`, "", output.review_markdown ?? ""].join("\n");
}
