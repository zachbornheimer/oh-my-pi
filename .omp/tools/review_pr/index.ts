import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { spawnRunner } from "./exec.js";
import { parsePullRequestUrl } from "./parse_url.js";
import { outcomeText, reviewPr } from "./review_pr.js";

const HEARTBEAT_MS = 15_000;

const DESCRIPTION = [
  "Review one open GitHub pull request with every local reviewer (OpenCodeReview `ocr` and Semgrep) and attach the findings to the PR as one `COMMENT` review: an inline thread per finding whose lines are in the diff, with a one-click suggestion when the reviewer proposed replacement code, plus a summary listing every finding.",
  "Use `review_code` or `review_code_security` to review a diff without touching a PR, and `improve_pr` to also fix what is found.",
  'Call `{"url":"https://github.com/OWNER/REPO/pull/N"}`; any other URL form, or a PR that is not open, is refused.',
  "Needs `gh` signed in with write access to the PR, `ocr` configured and `semgrep` installed.",
  "It WRITES TO THE PR with the user's `gh` credentials: it posts a review, replaces the body of its own earlier summary review, and resolves its own older threads whose finding is gone. It never approves, requests changes or edits code. A finding an earlier run posted is counted, not posted again.",
  "Each reviewer clones the PR into a temp directory (removed afterwards); `ocr` spends its configured model quota. Runs minutes to an hour and sends progress updates.",
  "A reviewer that fails is reported `failed` and the others still attach; when every reviewer fails it throws and posts nothing.",
  "Returns `{url, head_sha, reviewers:[{reviewer, status, findings, error?}], review:{posted, id?, html_url?, inline, in_summary, already_posted, updated, resolved}}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => ({
  name: "review_pr",
  label: "Review PR",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    url: pi.zod
      .string()
      .url()
      .describe("The open pull request to review, exactly `https://github.com/OWNER/REPO/pull/N` (no query, fragment or extra path)."),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    parsePullRequestUrl(params.url);
    const began = Date.now();
    let phase = "starting";
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `review_pr: ${phase} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { phase },
      });
    }, HEARTBEAT_MS);
    try {
      const output = await reviewPr(params.url, {
        run: spawnRunner({ signal }),
        signal,
        progress: (next) => {
          phase = next;
        },
      });
      return { content: [{ type: "text", text: outcomeText(output) }], details: output };
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
