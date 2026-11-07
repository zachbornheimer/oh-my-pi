import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildQuotaCensus, queryLowWeeklyQuotas } from "./census.js";
import { FileClaimStore } from "./claims.js";
import { type Exec, ompModelStep } from "./omp_model.js";
import { loadPromptSpec, ompFilePort } from "./review.js";
import { outcomeText, type QuotaReviewInput, runQuotaBurnReview } from "./workflow.js";

const HEARTBEAT_MS = 10_000;

const DESCRIPTION =
  "Review why a weekly LLM provider quota is nearly spent, and file token-efficiency Linear issues. Use when a weekly quota is at or below 10% remaining; it does nothing otherwise. "
  + "Input `{\"threshold_used_fraction\":0.9,\"days\":7,\"re_review\":false}`; all optional (threshold 0.5-1, days a positive integer, defaults shown). "
  + "Steps: read the latest weekly rows of `usage_history` in `~/.omp/agent/agent.db` (read-only); claim each provider reset period in `~/.omp/agent/quota-burn-review/claims`; count tokens, cost, subagent share and model switches over the last `days` of `~/.omp/agent/sessions`; "
  + "ask a bare `omp -p` model for root causes and savings (JSON validated, up to 3 attempts); if it proposes issues, run ONE full `omp -p` with the Linear MCP tools to file them and require a Linear URL per issue; write the report to `~/.local/share/capability-replicas/annotated`. "
  + "Exactly one review runs per period: a claimed or reviewed period returns `already_reviewed`; a failed run may retry once. `re_review: true` DANGEROUSLY releases the claim on every triggered period and reviews it again. "
  + "Spends model quota and creates or comments on Linear issues. A missing database, bad model JSON or failed filing fails the call; a failed filing still saves the unfiled review. "
  + "Returns status (reviewed, no_low_quotas, already_reviewed), the triggered limits, report_path, root causes, recommendations and filed issues. "
  + "Omitted versus the Mastra workflow: cross-machine claim dedup (claims are local files), the chained optimize_tooling run, `await_result`, `force`.";

const factory: CustomToolFactory = (pi) => ({
  name: "quota_burn_review",
  label: "Quota Burn Review",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    threshold_used_fraction: pi.zod.number().min(0.5).max(1).nullable().optional().describe("Used fraction that triggers a review, 0.5-1. Default 0.9."),
    days: pi.zod.number().int().positive().nullable().optional().describe("Days of session history in the census. Default 7."),
    re_review: pi.zod.boolean().nullable().optional().describe("Dangerous: release the claim on every triggered period and review it again. Default false."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const input: QuotaReviewInput = {
      threshold_used_fraction: params.threshold_used_fraction ?? 0.9,
      days: params.days ?? 7,
      re_review: params.re_review ?? false,
    };
    if (!(input.threshold_used_fraction >= 0.5 && input.threshold_used_fraction <= 1)) throw new Error("threshold_used_fraction must be between 0.5 and 1");
    if (!Number.isInteger(input.days) || input.days <= 0) throw new Error("days must be a positive integer");

    const exec = pi.exec as unknown as Exec;
    const home = homedir();
    const spec = await loadPromptSpec();
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `quota_burn_review: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const output = await runQuotaBurnReview(
        input,
        {
          queryQuotas: (threshold) => queryLowWeeklyQuotas(threshold, join(home, ".omp", "agent", "agent.db")),
          census: (days) => buildQuotaCensus(join(home, ".omp", "agent", "sessions"), days, Date.now()),
          claims: new FileClaimStore(join(home, ".omp", "agent", "quota-burn-review", "claims")),
          step: ompModelStep(exec),
          spec,
          filer: ompFilePort(exec, spec),
          reportDir: join(home, ".local", "share", "capability-replicas", "annotated"),
          now: Date.now,
          progress: (next) => {
            phase = next;
          },
        },
        signal,
      );
      return { content: [{ type: "text", text: outcomeText(output) }], details: output };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
