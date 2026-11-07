import { ISSUE_BODY_CAP, PUSH_HOOK_BUDGET_MS, PUSH_VISIBLE_BUDGET_MS, SETTLE_POLL_MS } from "./constants.js";
import { obj, parseJson, sha } from "./decode.js";
import { headContains } from "./head_contains.js";
import type { PrPorts } from "./ports.js";
import { canPushHead } from "./settled.js";
import type { Attempt, Facts, RoundRecord } from "./types.js";

/**
 * Polls GitHub, every SETTLE_POLL_MS and within PUSH_VISIBLE_BUDGET_MS, until the pull request's head contains `pushed`:
 * a push is not visible to a read at once, and a bot can commit on top of it before the first read. Returns the head
 * GitHub last reported when it never does.
 */
async function awaitPushedHeadOnGitHub(
  ports: Pick<PrPorts, "gh" | "now" | "sleep">,
  facts: Facts,
  pushed: string,
): Promise<{ visible: true } | { visible: false; reported: string }> {
  const deadline = ports.now().getTime() + PUSH_VISIBLE_BUDGET_MS;
  const reportedHead = async (): Promise<string> => {
    const where = "gh pr view headRefOid";
    const view = obj(
      parseJson(await ports.gh(["pr", "view", String(facts.number), "--repo", facts.repo, "--json", "headRefOid"]), where),
      where,
    );
    return sha(view.headRefOid, `${where} headRefOid`);
  };
  let reported = await reportedHead();
  while (!await headContains(ports, facts.repo, pushed, reported)) {
    if (ports.now().getTime() + SETTLE_POLL_MS > deadline) return { visible: false, reported };
    await ports.sleep(SETTLE_POLL_MS);
    reported = await reportedHead();
  }
  return { visible: true };
}

/**
 * The host's one push of a round: the agent's commits to the pull request's own head branch, no force. What the round
 * pushed is what the checkout's HEAD was, read before the push: if that is the head the round started from, nothing
 * changed and nothing is pushed, `failed`. A refused push (a pre-push hook or GitHub) is `failed` with git's output in
 * `refusal`, its tail when long, so the next round can fix what refused it. Otherwise the round is `pushed` once GitHub
 * reports that SHA as the pull request's head, which can take a few reads; a head that never shows within
 * PUSH_VISIBLE_BUDGET_MS is `failed`, and its `toSha` still names what was pushed, so the run re-reads the head instead
 * of trusting its old judgment.
 */
export async function pushPrFixRoundToHeadBranch(
  ports: Pick<PrPorts, "git" | "gh" | "now" | "sleep" | "progress">,
  input: { facts: Facts; attempt: Attempt },
): Promise<RoundRecord> {
  const { facts, attempt } = input;
  const round = { number: attempt.number, role: attempt.role, fromSha: attempt.fromSha, commits: attempt.commits };
  const failed = (reason: string, toSha: string | null = null, refusal = ""): RoundRecord => ({
    ...round,
    status: "failed",
    reason,
    toSha,
    refusal,
  });
  if (facts.state !== "OPEN") return failed(`the pull request is ${facts.state.toLowerCase()}`);
  if (attempt.problem !== "") return failed(attempt.problem);
  if (facts.isCrossRepository && !canPushHead(facts)) {
    return failed("the head branch is on a fork; this run pushes only to a fork the viewer owns");
  }
  const pushed = (await ports.git(["rev-parse", "HEAD"], attempt.cwd)).trim();
  if (pushed === attempt.fromSha) return failed(`the head SHA is unchanged: the checkout is still at ${pushed}`);
  const remote = facts.isCrossRepository
    ? `https://github.com/${facts.headRepo ?? `${facts.author}/${facts.repo.split("/")[1]}`}.git`
    : "origin";
  // The push runs the repository's pre-push hooks in full; that wait must read as a wait, not as silent work.
  ports.progress(
    `round ${attempt.number} (${attempt.role}): pushing ${attempt.commits} commit${
      attempt.commits === 1 ? "" : "s"
    }; the pre-push gate runs, bounded at ${PUSH_HOOK_BUDGET_MS / 60_000} minutes`,
  );
  try {
    await ports.git(["push", remote, `HEAD:refs/heads/${facts.headRef}`], attempt.cwd);
  } catch (error) {
    const output = (error as Error).message.trim().slice(-ISSUE_BODY_CAP);
    return failed(`push refused: ${output}`, null, output);
  }
  const seen = await awaitPushedHeadOnGitHub(ports, facts, pushed);
  if (!seen.visible) {
    return failed(
      `GitHub still reports the head as ${seen.reported} ${
        PUSH_VISIBLE_BUDGET_MS / 60_000
      } minutes after the push of ${pushed}`,
      pushed,
    );
  }
  return { ...round, status: "pushed", reason: "", toSha: pushed, refusal: "" };
}
