export const DEPENDENCIES_CHECKED = "ai:dependencies-checked";

export const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A pull request is tried again no sooner than this after the tick that last launched it. */
export const RETRY_AFTER_MS = 4 * HOUR_MS;

/** The tick cycle: how often the caller is expected to run the tool. */
export const TICK_CYCLE_MS = 4 * HOUR_MS;

/**
 * 75% of the cycle (3 h): a tick launches nothing at or after its start plus this. Runs it already started keep going
 * past it, and the tick drains them (each run's exit, then REPO_HOLD_MS) before it releases its lock.
 */
export const SPAWN_WINDOW_MS = (TICK_CYCLE_MS * 3) / 4;

/** How long a launched run is watched before it counts as running. One that exits sooner records nothing. */
export const LAUNCH_WAIT_MS = 20 * 1000;

/**
 * A repository's lane stays held this long after its launched run exits, so the bots' rebases settle before the lane
 * lists the repository's pull requests again and takes the next.
 */
export const REPO_HOLD_MS = 5 * MINUTE_MS;

/** How often a launched run is checked for being alive. */
export const EXIT_POLL_MS = 30 * 1000;

/**
 * Repositories worked at once when LANES_ENV does not say otherwise. A lane works one repository's pull requests one
 * after another, so it holds at most one running upgrade and the lane count bounds the upgrades running.
 */
export const DEFAULT_LANES = 4;

/** Names the lane count of the tick that reads it: a positive integer. */
export const LANES_ENV = "UPGRADE_BOT_PRS_LANES";

/** `gh search prs --limit` ceiling: GitHub's search returns at most this many results. */
export const SEARCH_LIMIT = 1000;

/** Fields read from `gh search prs`. It has no head sha; the head is read per pull request with `gh pr view`. */
export const SEARCH_FIELDS = "repository,number,url,author,isDraft,labels,createdAt";

/** Under the home directory; shared with the Mastra twin so the two never launch the same pull request together. */
export const WEBMASTER_DIR = ".config/webmaster";
export const REGISTRY_FILE = "registry-upgrade_dependency.json";
export const LOCK_FILE = "registry-upgrade_dependency.lock";
export const LOG_DIR = "logs";

/** The omp tool each launched run calls, once, for one pull request. */
export const UPGRADE_TOOL = "upgrade_dependency";

/** A launched omp run is stopped by omp itself after this long (the upgrade loop's own budget is 6 h). */
export const RUN_MAX_TIME = "400m";

/** Interval between progress updates while the tick runs. */
export const HEARTBEAT_MS = 15_000;
