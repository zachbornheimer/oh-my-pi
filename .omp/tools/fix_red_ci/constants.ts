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

/** The omp role every fix round's model call runs on. */
export const FIX_MODEL_ROLE = "@task";

/** The longest an issue's text is carried into a prompt. */
export const ISSUE_BODY_CAP = 4_000;

/** The longest a failed check's log is carried into a prompt: its end, where the failure is. */
export const LOG_TAIL_CHARS = 6_000;

/** The most files a failed round's reason names; the rest are counted. */
export const NAMED_FILES_CAP = 5;

/** `git status --porcelain` puts two status letters and a space before the path. */
export const PORCELAIN_PATH_OFFSET = 3;

/** The longest a commit subject is (the repository's hooks often cap it near 60). */
export const COMMIT_SUBJECT_CAP = 60;

/** How many times a GitHub read is attempted before a transient failure (5xx, network, timeout) is surfaced: the first try plus three more. */
export const GH_READ_MAX_ATTEMPTS = 4;

/** The wait before the first retry of a GitHub read: doubled for each retry after it, up to the cap, then jittered upward by up to a quarter. */
export const GH_READ_RETRY_BASE_MS = 1_000;
export const GH_READ_RETRY_MAX_MS = 8_000;
