/** Values from the desktop spec constants table. Do not copy them elsewhere. */

export const CONCURRENCY = 3;
export const AGENT_LIMIT_MINUTES = 45;
export const DAILY_AGENT_CAP_HOURS = 6;
export const RERUN_LIMIT_MINUTES = 15;
export const WORKTREES = "~/Library/Caches/repo-green/worktrees";
export const STATE_DIR = "~/Library/Application Support/repo-green";
export const REPO_GREEN_CANARY = "zachbornheimer/repo-green-canary";
export const OMP_BIN = "omp";
export const OMP_TASK_ROLE = "@task";
/** `gh`, resolved from PATH. The real host runs only `git`, `gh` and `omp`, so there is no override. */
export const GH_BIN = "gh";

export const STATE_DIR_ENV = "REPO_GREEN_STATE_DIR";
export const WORKTREES_ENV = "REPO_GREEN_WORKTREES";
/** Comma-separated owners whose repositories an account-wide run leaves out (their Actions billing is on hold). */
export const BILLING_HOLD_ENV = "REPO_GREEN_BILLING_HOLD_OWNERS";
export const DEFAULT_BILLING_HOLD_OWNERS = ["zachbornheimer"] as const;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

export const AGENT_LIMIT_MS = AGENT_LIMIT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
export const DAILY_AGENT_CAP_MS = DAILY_AGENT_CAP_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
export const RERUN_LIMIT_MS = RERUN_LIMIT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
/** How long a wait on the fixer or a rerun sleeps between looks. */
export const POLL_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
/** After a squash merge, how long the default branch's rollup may stay pending before the merge is judged as it is. */
export const MERGED_ROLLUP_BUDGET_MS = 30 * SECONDS_PER_MINUTE * MS_PER_SECOND;
/** After a squash merge, how long the default branch may show no checks at all while they register. */
export const MERGED_CHECKS_REGISTRATION_MS = 5 * SECONDS_PER_MINUTE * MS_PER_SECOND;
/** One `upgrade_dependency` run on one pull request is stopped after this long. */
export const UPGRADE_LIMIT_MS = 60 * SECONDS_PER_MINUTE * MS_PER_SECOND;

export const PUSHABLE_PERMISSIONS = ["ADMIN", "MAINTAIN", "WRITE"] as const;
export const RERUN_ALLOWLIST = ["test", "lint", "build", "ci"] as const;
export const NEVER_RERUN = [
  "billing",
  "quota",
  "permissions",
  "missing-secret",
  "missing secret",
  "deploy",
  "release",
  "publish",
] as const;
export const INFRA_MARKERS = [
  "billing",
  "quota",
  "missing secret",
  "missing-secret",
  "permissions",
  "runner unavailable",
  "external service",
] as const;

export const FIX_BRANCH_PREFIX = "ci-green/";
export const EVENTS_FILE = "events.jsonl";
export const STATE_FILE = "state.json";
export const DEPENDENCIES_CHECKED = "ai:dependencies-checked";
