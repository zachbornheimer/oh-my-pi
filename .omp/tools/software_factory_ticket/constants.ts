import { homedir } from "node:os";
import { join } from "node:path";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** One ticket per sweep unless the caller asks for more; they still run one at a time. */
export const SWEEP_DEFAULT_LIMIT = 1;

export const LINEAR_PAGE_SIZE = 250;
/**
 * A runaway bound, not a size budget: the board the loop files into holds thousands of tickets in one status (7,790 and
 * counting in ZYS), and ordering by priority then age needs every one of them. 20 pages stopped every run at 5,000.
 */
export const MAX_LINEAR_PAGES = 100;

/** Linear's priority: 1 Urgent … 4 Low; 0 is "No priority", which sorts after every real priority. */
export const NO_PRIORITY = 0;

/** The implementation runs once, and once more with the change review's findings; a third round is never started. */
export const MAX_IMPLEMENTATION_ROUNDS = 2;

const CACHE_DIR = join(homedir(), "Library", "Caches", "software-factory");

/** The machine-wide lock that keeps the factory to one ticket at a time. */
export const LOCK_FILE = join(CACHE_DIR, "lock");
/** A lock older than this is reclaimed even when its holder's pid is alive (a pid can be reused). */
export const LOCK_MAX_AGE_MS = 12 * MS_PER_HOUR;

/** Where each ticket's per-step checkpoint file lives: `<dir>/<TICKET>.json`. */
export const CHECKPOINT_DIR = join(CACHE_DIR, "checkpoints");
/** A checkpoint of a run that did not finish is resumed only this long after its last finished step. */
export const CHECKPOINT_MAX_AGE_MS = 24 * MS_PER_HOUR;

/** The append-only run record, `$FACTORY_RUN_LEDGER` overriding. */
export const DEFAULT_LEDGER_PATH = join(homedir(), ".local", "state", "capability-replicas", "factory-runs.jsonl");

/**
 * The bounded lease a run's ledger record holds: a run that goes this long with no step event and no closure is no
 * longer live, so its opening record stops counting as an in-flight run and the ledger heals it as `stale`. Longer than
 * the slowest single step (the reviewer's 45-minute budget), so a live run never looks dead.
 */
export const RUN_LEASE_MS = MS_PER_HOUR;

/** Where a reviewer writes its one JSON verdict. Outside every worktree: a review never writes into the target tree. */
export const REVIEW_VERDICT_DIR = join(CACHE_DIR, "reviews");
export const REVIEW_BUDGET_MS = 45 * MS_PER_MINUTE;

/** Where the ticket worker of a repo-less ticket runs: a scratch directory with no checkout in it. */
export const WORK_WITHOUT_CHECKOUT_DIR = join(CACHE_DIR, "work-without-checkout");

/** Where the adversarial review of a ticket with no repository runs: a scratch directory with no checkout in it. */
export const REVIEW_WITHOUT_CHECKOUT_DIR = join(CACHE_DIR, "review-without-checkout");

/** Where a delegated sibling-tool call (landing, CI repair, dependency upgrade) runs: a scratch directory. */
export const DELEGATE_DIR = join(CACHE_DIR, "delegate");

/**
 * The adversarial reviewer's model. It is a different family from the implementer's (omp's default role): the skill
 * asks for it because same-family models share blind spots.
 */
export const REVIEWER_MODEL = "xai-oauth/grok-4.7:high";
export const REVIEW_SKILL = "adversarial-review";

export const TICKETS_SKILL = "tickets";

/** omp's default role. Literal `default` without `@` fails omp preflight. */
export const OMP_DEFAULT_MODEL = "@default";
/** The implementer and the repo-less worker are each stopped after this long. */
export const IMPLEMENT_BUDGET_MS = 60 * MS_PER_MINUTE;
export const WORK_BUDGET_MS = 60 * MS_PER_MINUTE;
/** One bare model question (the /tickets pass, the repository question). */
export const ASK_BUDGET_MS = 5 * MS_PER_MINUTE;

/** The delegated sibling tools: `make_pr_mergable` runs for hours; the other two are bounded tighter. */
export const MAKE_PR_MERGABLE_BUDGET_MS = 7 * MS_PER_HOUR;
export const FIX_RED_CI_BUDGET_MS = 2 * MS_PER_HOUR;
export const UPGRADE_DEPENDENCY_BUDGET_MS = 2 * MS_PER_HOUR;

export const GIT_BUDGET_MS = 10 * MS_PER_MINUTE;
export const GIT_PUSH_BUDGET_MS = 30 * MS_PER_MINUTE;
export const CLONE_BUDGET_MS = 30 * MS_PER_MINUTE;
export const GH_BUDGET_MS = 5 * MS_PER_MINUTE;
export const LINEAR_REQUEST_BUDGET_MS = 30_000;

/** How often a running tool tells omp it is alive. */
export const HEARTBEAT_MS = 15_000;

/** The commit message of whatever the implementer left uncommitted in the worktree. */
export const LEFTOVERS_COMMIT_MESSAGE = (ticket: string): string => `chore(${ticket.toLowerCase()}): commit leftover changes`;

/** make_pr_mergable's target for a PR the factory opened. */
export const MAKE_PR_MERGABLE_TARGET = "approved" as const;
