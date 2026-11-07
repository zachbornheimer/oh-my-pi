import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { fixRedCi, outputText, toOutput } from "./fix.js";
import { livePorts } from "./live_ports.js";
import { HEARTBEAT_MS } from "./omp_model.js";
import { parsePullRequestUrl } from "./parse_url.js";

const DESCRIPTION =
  "Fix one pull request's red CI check (not a dependency upgrade): ask a bare model for exact-text edits, commit and push them, and repeat until the pull request is mergeable, no in-repo fix exists, or the budget is spent. "
  + "Use when you already read a failing check and want it repaired; it never merges. Use make_pr_mergable for review threads and merging, upgrade_dependency for dependency bumps. "
  + "Input `{\"url\":\"https://github.com/o/r/pull/1\",\"check\":{\"check\":\"test\",\"red\":true,\"thisRepo\":true,\"log\":\"expected 1 to be 2\"}}`. `check.log` is the whole first-round prompt; `red` and `thisRepo` are ignored. Later rounds re-read the pull request: each red check's `gh run view --log-failed`, open threads and comments, and the earlier attempt's summary. "
  + "Each round the model (omp @task, no tools) answers `{can_fix, summary, edits[{path,old,new}]}`; can_fix false (cause outside this repository) ends `impossible`. "
  + "Edits are refused for an absolute, `..` or `.git` path, a path resolving outside the checkout, a non-unique `old`, or deleting expect/assert/it( without putting one back; nothing is written when one fails, the round counts as failed, and the next prompt says why. "
  + "Applied edits are committed in a private checkout and pushed once to the PR's head branch (never forced; pre-push hooks run), then CI is polled. Mergeable means checks green, no conflict, no open thread or comment; reviewers are not waited for. "
  + "Limits: 3 rounds per head, 20 in all, 6 hours, $25 per PR ($2 charged per round). "
  + "Pushes commits and spends model quota; runs minutes to hours with progress updates. Returns {summary, green, changed[], status done|impossible|spent, rounds, reasons[]}.";

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "fix_red_ci",
    label: "Fix Red CI",
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().url().describe("Pull request URL, exactly `https://github.com/OWNER/REPO/pull/N` (no query, fragment or extra path)."),
      check: z.object({
        check: z.string().describe("Name of the failed CI check."),
        red: z.boolean().describe("Carried for compatibility; not used. The run judges from a fresh read of the pull request, and a head that is already settled ends `done` with no round."),
        thisRepo: z.boolean().describe("Carried for compatibility; not used. The model decides from the log whether the cause is outside this repository, and then ends the run `impossible`."),
        log: z.string().describe("The failed check's log, as you already read it; this is the first round's whole prompt."),
      }).describe("The failed check you already read."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      parsePullRequestUrl(params.url);
      // `red` and `thisRepo` are carried for compatibility and are not used: the run judges from a fresh read of the pull
      // request, and the model says when the cause is outside this repository.
      const began = Date.now();
      let phase = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `fix_red_ci: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
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
        const state = await fixRedCi(ports, { prUrl: params.url, check: { check: params.check.check, log: params.check.log } }, signal);
        const output = toOutput(state);
        return {
          content: [{ type: "text", text: outputText(params.url, output) }],
          details: { url: params.url, ...output, seconds: Math.round((Date.now() - began) / 1000) },
        };
      } finally {
        clearInterval(beat);
      }
    },
  };
};

export default factory;
