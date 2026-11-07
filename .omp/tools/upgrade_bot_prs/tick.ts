import { join } from "node:path";
import {
  EXIT_POLL_MS,
  HOUR_MS,
  LAUNCH_WAIT_MS,
  LOG_DIR,
  LANES_ENV,
  REPO_HOLD_MS,
  RETRY_AFTER_MS,
  RUN_MAX_TIME,
  SPAWN_WINDOW_MS,
  UPGRADE_TOOL,
  WEBMASTER_DIR,
} from "./constants.js";
import type { UpgradeBotHost } from "./host.js";
import { searchOpenBotPulls } from "./list_open_bot_prs.js";
import { holdInForce, holdNeedsHead, lanesFrom, oldestFirst, triedLongEnoughAgo } from "./policy.js";
import { RegistryStore, takeLock } from "./registry.js";
import type { Listed, Pull, Registry, TickResult } from "./schemas.js";

/** What one repository's turn adds to the tick's report. */
type RepoOutcome = Pick<TickResult, "launched" | "wouldLaunch" | "skipped">;

type Tick = {
  host: UpgradeBotHost;
  store: RegistryStore;
  start: Date;
  /** No launch at or after this instant: the tick's start plus SPAWN_WINDOW_MS. */
  spawnDeadline: number;
  dryRun: boolean;
  registry: Registry;
  /** Progress line the tool call shows. */
  progress: (message: string) => void;
};

/** The instruction one launched omp run gets: one tool call for one pull request, nothing else. */
export function runPrompt(url: string): string {
  return [
    `Call the \`${UPGRADE_TOOL}\` tool exactly once, for the GitHub pull request ${url}, passing that URL as the pull request it asks for.`,
    "Do nothing else: do not edit files, do not run other commands, do not call any other tool.",
    "When it returns, reply with its verdict and its first line of reasons in one line.",
  ].join(" ");
}

/** The command a launched run executes: a headless omp session limited to the one upgrade tool. */
export function runCommand(url: string): { bin: string; args: string[] } {
  return {
    bin: "omp",
    args: ["-p", runPrompt(url), "--tools", UPGRADE_TOOL, "--no-session", "--no-title", "--max-time", RUN_MAX_TIME],
  };
}

/**
 * One tick. Under the process-wide lock, the repositories of `listed.pulls` are worked by lanes (LANES_ENV, four unless
 * it says otherwise): a
 * lane takes the next repository the moment it frees up and works all of that repository's pull requests, oldest
 * first, one `upgrade_dependency` run after another (see `workRepo`). A run is waited for until it has exited,
 * however long it takes, and REPO_HOLD_MS more, so at most that many upgrades run at once. Nothing is launched at or
 * after the start plus SPAWN_WINDOW_MS (3 h); runs already started keep going, and the tick drains them all before it
 * releases the lock. A tick launches nothing while any run recorded in the registry is still alive (one a dead tick
 * left behind), so recovery never pushes the count past four. A dry run takes no lock, writes nothing and launches
 * nothing. Nothing throws out of here: a failed repository, or a tick that cannot read its registry or take its lock,
 * is reported as skips. Cancelling the call stops launching and waiting, records any run still alive, and releases
 * the lock; those runs keep going.
 */
export async function launchUpgradeDependencyPerRepo(
  host: UpgradeBotHost,
  listed: Listed,
  progress: (message: string) => void = () => {},
): Promise<TickResult> {
  const dryRun = listed.dryRun === true;
  const repos = groupByRepo(listed.pulls);
  const result: TickResult = {
    dryRun,
    repos: repos.size,
    launched: [],
    wouldLaunch: [],
    skipped: [...listed.skipped],
  };
  if (!dryRun && repos.size > 0 && !host.toolInstalled(UPGRADE_TOOL)) {
    throw new Error(
      `BLOCKED: the \`${UPGRADE_TOOL}\` omp tool is not installed (looked in ~/.omp/agent/tools and .omp/tools); each launched run calls it, so nothing was launched`,
    );
  }
  const { lanes, problem } = lanesFrom(host.env(LANES_ENV));
  if (problem !== undefined) result.skipped.push({ pr: "tick", reason: problem });
  const start = host.now();
  const lock = dryRun ? { release: async () => {} } : await takeLock(host, start);
  if ("refused" in lock) {
    result.skipped.push({ pr: "tick", reason: lock.refused });
    return result;
  }
  const { release } = lock;
  try {
    const store = new RegistryStore(host);
    const registry = await store.read();
    const orphans = Object.entries(registry.lastTrys).filter(([, run]) => host.isAlive(run.pid));
    if (orphans.length > 0) {
      const running = orphans.map(([pr, run]) => `${pr} (pid ${run.pid})`).join(", ");
      result.skipped.push({ pr: "tick", reason: `recorded upgrades are still running: ${running}; launching nothing` });
      return result;
    }
    const tick: Tick = {
      host,
      store,
      start,
      spawnDeadline: start.getTime() + SPAWN_WINDOW_MS,
      dryRun,
      registry,
      progress,
    };
    const outcomes = await inPool([...repos], lanes, ([repo, pulls]) => workRepo(tick, repo, pulls));
    for (const outcome of outcomes) {
      result.launched.push(...outcome.launched);
      result.wouldLaunch.push(...outcome.wouldLaunch);
      result.skipped.push(...outcome.skipped);
    }
    if (host.signal?.aborted) {
      result.skipped.push({
        pr: "tick",
        reason: "cancelled: launching and waiting stopped; runs already started keep going and block the next tick while alive",
      });
    }
  } catch (error) {
    result.skipped.push({ pr: "tick", reason: (error as Error).message });
  } finally {
    await release().catch((error: Error) => {
      result.skipped.push({ pr: "tick", reason: `releasing the lock failed: ${error.message}` });
    });
  }
  return result;
}

/**
 * One repository, worked by one lane: never two of its pull requests at once. The oldest eligible pull request is
 * launched and waited for; then, REPO_HOLD_MS after it exited (the bots rebase the repository's other pull requests
 * when one lands), the repository's open bot pull requests are listed again, unless the list the lane holds has none
 * left, and the oldest eligible one not yet settled this tick is next, until none is left or the spawn window closes.
 * A pull request is settled for the tick once it was launched or skipped, so it is reported once and never launched
 * twice, whether or not its run labeled it. A dry run lists every eligible pull request, oldest first, and lists the
 * repository once.
 */
async function workRepo(tick: Tick, repo: string, first: readonly Pull[]): Promise<RepoOutcome> {
  const { host, dryRun } = tick;
  const outcome: RepoOutcome = { launched: [], wouldLaunch: [], skipped: [] };
  const settled = new Set<string>();
  const skip = (pull: Pull, reason: string) => {
    settled.add(pull.pr);
    outcome.skipped.push({ pr: pull.pr, reason });
  };
  let pulls: readonly Pull[] = first;
  try {
    for (let turn = 0;; turn++) {
      host.signal?.throwIfAborted();
      if (turn > 0 && !dryRun) {
        if (pulls.every((pull) => settled.has(pull.pr))) return outcome;
        try {
          pulls = await searchOpenBotPulls(host, { repo });
        } catch (error) {
          host.signal?.throwIfAborted();
          const reason = `listing ${repo} again failed: ${(error as Error).message}; not launched this tick`;
          for (const pull of pulls) if (!settled.has(pull.pr)) skip(pull, reason);
          return outcome;
        }
      }
      const open = pulls.filter((pull) => !settled.has(pull.pr));
      if (open.length === 0) return outcome;
      if (!dryRun && host.now().getTime() >= tick.spawnDeadline) {
        for (const pull of open) skip(pull, spawnClosed(tick));
        return outcome;
      }
      const chosen = await nextEligible(tick, open, skip);
      if (chosen === undefined) return outcome;
      settled.add(chosen.pr);
      if (dryRun) {
        outcome.wouldLaunch.push({ pr: chosen.pr, url: chosen.url });
        continue;
      }
      try {
        await launchOne(tick, chosen, outcome);
      } catch (error) {
        if (host.signal?.aborted) throw error;
        skip(chosen, `failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    const reason = host.signal?.aborted ? `${repo} cancelled` : `${repo} failed: ${(error as Error).message}`;
    const done = new Set([...outcome.launched, ...outcome.wouldLaunch, ...outcome.skipped].map((entry) => entry.pr));
    for (const pull of pulls) if (!done.has(pull.pr)) outcome.skipped.push({ pr: pull.pr, reason });
    return outcome;
  }
}

/**
 * The oldest of `pulls` that is eligible: no hold in force, and not tried within RETRY_AFTER_MS of the tick's start. Each
 * one passed over is skipped with its reason; one whose hold cannot be judged is skipped as failed and the next is tried.
 */
async function nextEligible(
  tick: Tick,
  pulls: readonly Pull[],
  skip: (pull: Pull, reason: string) => void,
): Promise<Pull | undefined> {
  const { host, registry, start } = tick;
  for (const pull of oldestFirst(pulls)) {
    try {
      const hold = registry.holds[pull.pr];
      if (hold !== undefined) {
        const head = holdNeedsHead(hold, host.now()) ? await headOf(host, pull) : undefined;
        if (holdInForce(hold, head, host.now())) {
          skip(pull, `held until ${hold.until}: ${hold.reason}`);
          continue;
        }
        if (!tick.dryRun) await tick.store.update((current) => void delete current.holds[pull.pr]);
      }
      if (!triedLongEnoughAgo(registry, pull.pr, start)) {
        skip(pull, `tried at ${registry.lastTrys[pull.pr]!.at}; not again within ${RETRY_AFTER_MS / HOUR_MS} h`);
        continue;
      }
      return pull;
    } catch (error) {
      if (host.signal?.aborted) throw error;
      skip(pull, `failed: ${(error as Error).message}`);
    }
  }
  return undefined;
}

/**
 * Starts the run detached, unless the spawn window closed while this lane was reading the head. It is watched for
 * LAUNCH_WAIT_MS: one that exits sooner records nothing, so the next tick tries again. Either way the lane stays held
 * until the run has exited, however long that takes (age never makes a live run dead), and REPO_HOLD_MS after the
 * exit. A registry write that fails while the run is alive is reported, and the lane still waits for the run, so the
 * lock is never released with it running. If the call is cancelled while the run is alive it is recorded first.
 */
async function launchOne(tick: Tick, pull: Pull, outcome: RepoOutcome): Promise<void> {
  const { host, store, start } = tick;
  const head = await headOf(host, pull);
  if (host.now().getTime() >= tick.spawnDeadline) {
    outcome.skipped.push({ pr: pull.pr, reason: spawnClosed(tick) });
    return;
  }
  const logPath = join(host.home(), WEBMASTER_DIR, LOG_DIR, `upgrade_dependency-${pull.pr.replace(/[/#]/g, "-")}.log`);
  const startedAt = host.now().toISOString();
  const command = runCommand(pull.url);
  const run = host.launch(command.bin, command.args, logPath);
  tick.progress(`launched ${pull.pr} (pid ${run.pid})`);
  const exited = run.exit.then((code) => ({ code }), (error: Error) => ({ code: error.message }));
  const record = async (): Promise<void> => {
    outcome.launched.push({ pr: pull.pr, url: pull.url, pid: run.pid });
    try {
      await store.update((current) => {
        current.lastTrys[pull.pr] = { at: start.toISOString(), pid: run.pid, startedAt, head };
      });
    } catch (error) {
      outcome.skipped.push({
        pr: pull.pr,
        reason: `pid ${run.pid} is running but recording it failed: ${(error as Error).message}; the lane waits for it`,
      });
    }
  };
  try {
    const early = await Promise.race([exited, host.sleep(LAUNCH_WAIT_MS).then(() => undefined)]);
    if (early !== undefined) {
      outcome.skipped.push({
        pr: pull.pr,
        reason: `omp exited ${early.code} within ${LAUNCH_WAIT_MS / 1000} s, so nothing was recorded; log ${logPath}`,
      });
    } else {
      await record();
      while (host.isAlive(run.pid)) {
        const done = await Promise.race([exited, host.sleep(EXIT_POLL_MS).then(() => undefined)]);
        if (done !== undefined) break;
      }
      tick.progress(`${pull.pr} finished`);
    }
    await host.sleep(REPO_HOLD_MS);
  } catch (error) {
    if (host.signal?.aborted && host.isAlive(run.pid) && !outcome.launched.some((entry) => entry.pr === pull.pr)) {
      await record();
    }
    throw error;
  }
}

const spawnClosed = (tick: Tick): string =>
  `the spawn window closed at ${new Date(tick.spawnDeadline).toISOString()} (${
    SPAWN_WINDOW_MS / HOUR_MS
  } h after the tick started); not launched this tick`;

async function headOf(host: UpgradeBotHost, pull: Pull): Promise<string> {
  const ran = await host.exec("gh", ["pr", "view", pull.url, "--json", "headRefOid", "--jq", ".headRefOid"]);
  const head = ran.stdout.trim();
  if (ran.status !== 0 || head === "") {
    throw new Error(`gh pr view ${pull.url} gave no head (exit ${ran.status}): ${ran.stderr.trim()}`);
  }
  return head;
}

function groupByRepo(pulls: readonly Pull[]): Map<string, Pull[]> {
  const repos = new Map<string, Pull[]>();
  for (const pull of pulls) repos.set(pull.repo, [...(repos.get(pull.repo) ?? []), pull]);
  return repos;
}

/** `work` over `items`, `limit` at a time, results in item order. `work` never rejects here. */
async function inPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
