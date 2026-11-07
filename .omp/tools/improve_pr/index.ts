import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { livePorts } from "./live_ports.js";
import { parsePullRequestUrl } from "./parse_url.js";
import { improvePr, type Outcome, outcomeText } from "./workflow.js";

const HEARTBEAT_MS = 15_000;

const DESCRIPTION =
  "Review one open GitHub pull request, then fix what the review and CI find until CI is green or a budget is spent. "
  + "Use to improve a PR you are authorized to push to; it does not merge (make_pr_mergable drives a PR to settled and merges it) and is not a read-only review. "
  + "Input `{\"prUrl\":\"https://github.com/OWNER/REPO/pull/N\"}`; any other URL form is refused. "
  + "Steps, in order: OpenCodeReview (`ocr`) on the pinned base and head; one omp agent run for all findings; one omp agent run per unresolved inline review thread; "
  + "then CI is awaited on the current head and each red head gets up to 3 omp fix rounds (also at most 20 rounds, 6 hours, and $25 of lifetime spend per PR, charged $2 a round in `~/.cache/capability-runtime/until`). "
  + "Each agent run edits a private checkout and MAY push commits to the PR branch and reply to or resolve review threads with the user's `gh` credentials: it mutates the PR and spends model quota. "
  + "Fails, with nothing further attempted, when the PR is not open, `ocr` is missing or fails, or the head moves during review. "
  + "Returns ciStatus (green, red, no-checks, timed-out, stale), reviewStatus, unresolvedThreads, reviewedHeadSha, finalHeadSha and requiresAnotherPass; only ciStatus green with requiresAnotherPass false is done. "
  + "Runs minutes to hours, sends progress updates, and is not resumable.";

const factory: CustomToolFactory = (pi) => ({
  name: "improve_pr",
  label: "Improve PR",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    prUrl: pi.zod.string().url().describe("Pull request URL, exactly `https://github.com/OWNER/REPO/pull/N` (no query, fragment or extra path)."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    parsePullRequestUrl(params.prUrl);
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `improve_pr: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const ports = livePorts({
        signal,
        progress: (message) => {
          phase = message;
        },
      });
      const outcome: Outcome = await improvePr(ports, params.prUrl);
      return {
        content: [{ type: "text", text: outcomeText(outcome) }],
        details: { ...outcome, seconds: Math.round((Date.now() - began) / 1000) },
      };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
