import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { livePorts } from "./live_ports.js";
import { parsePullRequestUrl } from "./parse_url.js";
import { makePrMergable, stateText } from "./workflow.js";

const HEARTBEAT_MS = 15_000;

const DESCRIPTION =
  "Drive one GitHub pull request to a settled target by fixing what blocks it, and optionally squash-merge it. "
  + "Use for a PR you can push to with open threads, comments, red checks or base conflicts; improve_pr reviews code, and `dryRun` is the read-only status check. "
  + "Input `{\"prUrl\":\"https://github.com/OWNER/REPO/pull/N\",\"target\":\"approved\",\"merge\":false,\"dryRun\":false}`; only prUrl is required. "
  + "Target `approved` (default): no unresolved thread or unanswered human comment, head checks SUCCESS, every reviewer re-reviewed the head (or 10 minutes passed), no CHANGES_REQUESTED or REVIEW_REQUIRED, mergeStateStatus CLEAN. `mergeable` leaves out what only reviewers decide. "
  + "While blocked, each round runs headless omp (round 1 `@task`, later `@slow`) on a private checkout, one commit per issue, then the tool pushes once to the PR branch (never forced; pre-push hooks run) and waits for CI. The agent NEVER replies to, resolves or reviews anything. "
  + "Rounds stop at 3 per head, 20 in all, 6 hours, or $25 lifetime per PR ($2 charged per round, kept in `~/.cache/capability-runtime/until`). "
  + "`merge` true with target approved runs `gh pr merge --squash --match-head-commit <judged sha>`, then observes merged versus merge queue. "
  + "Unless `dryRun`, it pushes commits, may merge, and spends model quota. "
  + "Returns status `merged`, `done`, `queued`, `impossible` (closed, draft with nothing left, no push access, merge refused), `spent` or `working` (dryRun found work), with reasons and rounds. "
  + "Runs minutes to hours with progress updates; not resumable.";

const factory: CustomToolFactory = (pi) => ({
  name: "make_pr_mergable",
  label: "Make PR mergable",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    prUrl: pi.zod.string().url().describe("Pull request URL, exactly `https://github.com/OWNER/REPO/pull/N` (no query, fragment or extra path)."),
    target: pi.zod.enum(["mergeable", "approved"]).nullable().optional().describe(
      "What settled means: `approved` (default) is mergeable plus reviewers satisfied; `mergeable` is checks green, no conflict, no open thread or comment.",
    ),
    merge: pi.zod.boolean().nullable().optional().describe("Merge when, and only when, the pull request is done for the `approved` target. Default false."),
    dryRun: pi.zod.boolean().nullable().optional().describe("Observe and judge only: no edit, push, wait or merge. Default false."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    parsePullRequestUrl(params.prUrl);
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `make_pr_mergable: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
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
      const state = await makePrMergable(ports, {
        prUrl: params.prUrl,
        target: params.target ?? undefined,
        merge: params.merge ?? undefined,
        dryRun: params.dryRun ?? undefined,
      });
      return {
        content: [{ type: "text", text: stateText(state) }],
        details: { ...state, seconds: Math.round((Date.now() - began) / 1000) },
      };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
