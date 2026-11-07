/**
 * Bounds and names the rules fix. Nothing else in the tool carries a number except `PR_BUDGET` (`budget.ts`): how many
 * rounds may start and what they may cost.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** Rule 5: how long after a push a reviewer who has not reviewed the new head is waited for. Measured from the push. */
export const REVIEWER_REREVIEW_WAIT_MS = 10 * MS_PER_MINUTE;

/** A fresh push registers its checks within this long; an empty rollup after it is "no checks", not "not yet". */
export const CHECKS_REGISTRATION_WAIT_MS = 2 * MS_PER_MINUTE;

/** Never poll GitHub faster than this. */
export const SETTLE_POLL_MS = 30 * MS_PER_SECOND;

/** One wait-until-settled step gives up, as blocked, after this long. */
export const SETTLE_BUDGET_MS = 45 * MS_PER_MINUTE;

/** After a push, GitHub is polled (every SETTLE_POLL_MS) this long for the pushed SHA to become the pull request's head. */
export const PUSH_VISIBLE_BUDGET_MS = 5 * MS_PER_MINUTE;

/** The host's push runs the repository's pre-push hooks (linters, scanners, pin checks); this long before it is killed. */
export const PUSH_HOOK_BUDGET_MS = 30 * MS_PER_MINUTE;
/**
 * Rule 6: how long one round's agent is waited for before the host stops it. A round may run the same pre-push gate
 * the host's push runs (`PUSH_HOOK_BUDGET_MS`) and still do its own work; past twice that it is idle, and an idle
 * round must not eat the run's wall clock (a round that waits on a gate with sleep polls wedges for hours).
 */
export const ROUND_AGENT_BUDGET_MS = 2 * PUSH_HOOK_BUDGET_MS;

/** The status the live agent port reports when it stopped the agent at `ROUND_AGENT_BUDGET_MS`, as `timeout(1)` reports 124. */
export const ROUND_BUDGET_EXIT = 124;

/** The omp roles a fix round can run on: round 1 on `@task`, every later round on `@slow` (`roleOfRound`). */
export const ROUND_ROLES = ["@task", "@slow"] as const;

/** The omp role of fix round `number` (1-based). */
export function roleOfRound(number: number): (typeof ROUND_ROLES)[number] {
  return number === 1 ? "@task" : "@slow";
}

/** The push URL the agent's checkout carries while the agent runs, so a push by the agent has nowhere to go. */
export const AGENT_PUSH_URL = "no-push://the-host-pushes-after-the-agent-stops";

/** The longest an issue's text is carried into a prompt. */
export const ISSUE_BODY_CAP = 4_000;

/** `Attempt.agentStatus` when no agent ran: the round failed before it, or the host's own merge left it nothing to do. */
export const AGENT_NOT_RUN = -1;

/** The most files a failed round's reason names; the rest are counted. */
export const NAMED_FILES_CAP = 5;

/** `git status --porcelain` puts two status letters and a space before the path. */
export const PORCELAIN_PATH_OFFSET = 3;

/** How many times a GitHub read is attempted before a transient failure (5xx, network, timeout) is surfaced: the first try plus three more. */
export const GH_READ_MAX_ATTEMPTS = 4;

/** The wait before the first retry of a GitHub read: doubled for each retry after it, up to the cap, then jittered upward by up to a quarter. */
export const GH_READ_RETRY_BASE_MS = 1_000;
export const GH_READ_RETRY_MAX_MS = 8_000;
