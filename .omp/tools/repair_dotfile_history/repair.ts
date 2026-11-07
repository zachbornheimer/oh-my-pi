import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type GitRunner,
  LOCAL_BRANCH,
  PUBLISHED_REF,
  allowsPlaintextHistory,
  blobAt,
  blobIsEncrypted,
  filterBranchCommand,
  gitArgs,
  livePathFor,
  plaintextCommits,
  refuseIfPublished,
  storePathFor,
} from "./history.ts";

/**
 * The playbook for removing local-only plaintext versions of encrypted dotfile paths from the mise history store, so
 * `mise dot sync` can publish. Every process goes through `ports.exec` with an argument list (no shell), so a test runs
 * it against a temp repository and fakes only the services and `mise`.
 */

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Process exit code; -1 when the process was killed. */
  readonly code: number;
  /** True when the process was killed by its timeout or the abort signal. */
  readonly killed: boolean;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Everything the playbook touches outside this module. Production binds it to `pi.exec` and the real home. */
export interface RepairPorts {
  exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** The home directory the live paths sit under. */
  readonly home: string;
  /** The mise history store: a bare git repository. */
  readonly storeDir: string;
  /** Where the private working directory (bundle and rewritten copy) is made. */
  readonly tmpRoot: string;
  readonly uid: number;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** The mise history services' launchd labels. */
  readonly watchdogLabel?: string;
  readonly historyLabel?: string;
  progress?(message: string): void;
}

export interface RepairInput {
  readonly paths: readonly string[];
  readonly dryRun: boolean;
}

export interface RepairOutput {
  dry_run: boolean;
  old_main: string;
  new_main: string;
  origin_tip_before: string;
  origin_tip_after: string;
  offenders_removed: { path: string; store_path: string; plaintext_commits: number }[];
  backups: { bundle: string; copy: string; bak_dir: string | null };
  services_stopped: boolean;
  services_restored: boolean;
  publish_succeeded: boolean | null;
  remaining_offenders: string[];
}

const DEFAULT_WATCHDOG = "dev.mise.mise-history-watchdog";
const DEFAULT_HISTORY = "dev.mise.mise-history";
const WATCHER_PATTERN = "mise dot watch";
const COPY = "/bin/cp";
const OUTPUT_TAIL = 2000;
const WATCHER_POLLS = 10;
const WATCHER_POLL_MS = 1000;
const TRANSIENT_ATTEMPTS = 6;
const TRANSIENT_WAIT_MS = 3000;

const tail = (text: string): string => (text.length > OUTPUT_TAIL ? `...${text.slice(-OUTPUT_TAIL)}` : text).trim();
const combined = (result: ExecResult): string => `${result.stdout}\n${result.stderr}`.trim();

/** One process. Nothing this tool builds may pass the plaintext escape hatch; that is checked here, before anything runs. */
async function run(ports: RepairPorts, command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
  if (allowsPlaintextHistory(command, args)) {
    throw new Error("refusing to run a command that passes --allow-plaintext-history");
  }
  options?.signal?.throwIfAborted();
  return ports.exec(command, args, options);
}

/** A process that must succeed: a non-zero exit or a kill (timeout) throws with the output tail. */
async function ok(ports: RepairPorts, command: string, args: readonly string[], options?: ExecOptions): Promise<string> {
  const result = await run(ports, command, args, options);
  if (result.killed) {
    options?.signal?.throwIfAborted();
    throw new Error(`command timed out or was killed: ${command} ${args.join(" ")}`);
  }
  if (result.code !== 0) {
    throw new Error(`command failed (exit ${result.code}): ${command} ${args.join(" ")}\n${tail(combined(result))}`);
  }
  return result.stdout;
}

function gitRunner(ports: RepairPorts, signal?: AbortSignal): GitRunner {
  return (args, repoDir) => ok(ports, "git", gitArgs(repoDir, args), { signal });
}

/** The store's ref tips as `name sha` lines, `origin/setup` and every `backup-*` ref included. */
async function refTips(git: GitRunner, repoDir: string): Promise<string[]> {
  const out = await git(["for-each-ref", "--format=%(refname:short) %(objectname)"], repoDir);
  return out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** Which store-relative paths still hold a plaintext blob reachable from main. */
async function remainingOffenders(git: GitRunner, repoDir: string, storePaths: readonly string[]): Promise<string[]> {
  const offenses = await plaintextCommits(git, repoDir, LOCAL_BRANCH, storePaths);
  return offenses.filter((offense) => offense.commits.length > 0).map((offense) => offense.storePath);
}

/** A command whose transient failure (a concurrent history operation holding the lock) is retried, not raised. */
const isTransientLock = (output: string): boolean =>
  output.includes("another history operation is running") || output.includes("index.lock");

async function retryTransient(
  ports: RepairPorts,
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<string> {
  let last: ExecResult | undefined;
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await ports.sleep(TRANSIENT_WAIT_MS);
    last = await run(ports, command, args, options);
    if (last.killed) {
      options.signal?.throwIfAborted();
      throw new Error(`command timed out or was killed: ${command} ${args.join(" ")}`);
    }
    if (last.code === 0) return combined(last);
    if (!isTransientLock(combined(last))) break;
  }
  throw new Error(`command failed (exit ${last?.code}): ${command} ${args.join(" ")}\n${tail(last === undefined ? "" : combined(last))}`);
}

/** Whether a `mise dot watch` process is alive. `pgrep` exits 1 when none matches; no shell is involved, so it cannot match itself. */
async function watcherRunning(ports: RepairPorts): Promise<boolean> {
  const result = await run(ports, "pgrep", ["-f", WATCHER_PATTERN]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`pgrep could not tell whether the mise history watcher runs (exit ${result.code}): ${tail(combined(result))}`);
}

async function waitForWatcher(ports: RepairPorts, wanted: boolean): Promise<boolean> {
  for (let poll = 0; poll < WATCHER_POLLS; poll += 1) {
    if ((await watcherRunning(ports)) === wanted) return true;
    await ports.sleep(WATCHER_POLL_MS);
  }
  return (await watcherRunning(ports)) === wanted;
}

/** Stop the two history services and confirm the watcher is gone; throws when it is still alive. */
async function stopServices(ports: RepairPorts): Promise<void> {
  const domain = `gui/${ports.uid}`;
  for (const label of [ports.watchdogLabel ?? DEFAULT_WATCHDOG, ports.historyLabel ?? DEFAULT_HISTORY]) {
    // `bootout` of a service that is not loaded exits non-zero, which is the state wanted.
    await run(ports, "launchctl", ["bootout", `${domain}/${label}`]);
  }
  if (!(await waitForWatcher(ports, false))) throw new Error("the mise history watcher is still running after the services were stopped");
}

/** Bring the services back and confirm the watcher process is live. */
async function startServices(ports: RepairPorts): Promise<void> {
  await run(ports, "mise", ["bootstrap", "services", "apply"], { cwd: ports.home, timeoutMs: 300_000 });
  if (!(await waitForWatcher(ports, true))) {
    const plist = join(ports.home, "Library", "LaunchAgents", `${ports.watchdogLabel ?? DEFAULT_WATCHDOG}.plist`);
    await run(ports, "launchctl", ["bootstrap", `gui/${ports.uid}`, plist]);
  }
  if (!(await waitForWatcher(ports, true))) throw new Error("the mise history watcher did not come back");
}

/** Whether `path` is a file or directory on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Repairs the store, or with `dryRun` rehearses the repair in a copy. See the tool description for the full sequence. */
export async function repairDotfileHistory(
  input: RepairInput,
  ports: RepairPorts,
  signal?: AbortSignal,
): Promise<RepairOutput> {
  const { home, storeDir } = ports;
  const say = (message: string): void => ports.progress?.(message);
  const git = gitRunner(ports, signal);
  const storePaths = input.paths.map((live) => storePathFor(live, home));
  if (new Set(storePaths).size !== storePaths.length) throw new Error("the same path was named twice");
  if (!(await exists(storeDir))) throw new Error(`no history store at ${storeDir}`);

  // Step 1: refuse before anything moves. Published plaintext needs a force-push; no plaintext means nothing to repair.
  say("checking that no plaintext is reachable from the published ref");
  await refuseIfPublished(git, storeDir, storePaths);
  const oldMain = (await git(["rev-parse", LOCAL_BRANCH], storeDir)).trim();
  const originTipBefore = (await git(["rev-parse", PUBLISHED_REF], storeDir)).trim();
  const tipsBefore = await refTips(git, storeDir);
  const localOffenses = await plaintextCommits(git, storeDir, LOCAL_BRANCH, storePaths);
  const clean = localOffenses.filter((offense) => offense.commits.length === 0).map((offense) => offense.storePath);
  if (clean.length > 0) {
    throw new Error(
      `nothing to repair: no plaintext commit on ${LOCAL_BRANCH} for ${clean.join(", ")}; rewriting would only drop that path's history`,
    );
  }

  const stamp = ports.now().toISOString().replaceAll(/[:.]/g, "-");
  const workDir = await mkdtemp(join(ports.tmpRoot, "mise-history-repair-"));
  const bundlePath = join(workDir, `pre-repair-${stamp}.bundle`);
  const copyPath = join(workDir, "repair.git");
  const bakPath = `${storeDir}.bak-${stamp}`;

  if (!input.dryRun) {
    say("stopping the mise history services");
  }
  let servicesStopped = false;
  let bakMoved = false;
  let swapped = false;
  let published = false;
  try {
    if (!input.dryRun) {
      servicesStopped = true;
      await stopServices(ports);
    }

    // Step 3: bundle (must be nonzero) and a verified full copy, into a private directory.
    say("bundling and copying the store");
    await ok(ports, "git", gitArgs(storeDir, ["bundle", "create", bundlePath, "--all"]), { timeoutMs: 600_000, signal });
    if ((await stat(bundlePath)).size === 0) throw new Error(`bundle is empty: ${bundlePath}`);
    if (await exists(copyPath)) throw new Error(`copy destination already exists: ${copyPath}`);
    await ok(ports, COPY, ["-R", storeDir, copyPath], { timeoutMs: 600_000, signal });
    const copiedMain = (await git(["rev-parse", LOCAL_BRANCH], copyPath)).trim();
    if (copiedMain !== oldMain) throw new Error("copy is not the store (nested cp destination, or the store changed during the copy)");

    // Step 4: rewrite main in the copy, then drop the backup ref filter-branch left behind.
    say("rewriting main in the copy");
    const filter = filterBranchCommand(copyPath, storePaths);
    await ok(ports, filter.command, filter.args, { timeoutMs: 900_000, signal });
    await ok(ports, "git", gitArgs(copyPath, ["update-ref", "-d", `refs/original/refs/heads/${LOCAL_BRANCH}`]), { signal });

    // Step 5: verify in the copy: no plaintext reachable from main, published and backup refs untouched.
    say("verifying the copy");
    const offendersAfter = await remainingOffenders(git, copyPath, storePaths);
    if (offendersAfter.length > 0) throw new Error(`plaintext still reachable from ${LOCAL_BRANCH} after rewrite: ${offendersAfter.join(", ")}`);
    const copyOriginTip = (await git(["rev-parse", PUBLISHED_REF], copyPath)).trim();
    if (copyOriginTip !== originTipBefore) throw new Error(`${PUBLISHED_REF} changed in the copy`);
    const tipsAfter = await refTips(git, copyPath);
    const changedGuardRefs = tipsBefore.filter((tip) => {
      const name = tip.split(" ")[0] ?? "";
      return (name === PUBLISHED_REF || name.startsWith("backup-")) && !tipsAfter.includes(tip);
    });
    if (changedGuardRefs.length > 0) throw new Error(`published or backup refs changed in the copy: ${changedGuardRefs.join(", ")}`);
    const newMain = (await git(["rev-parse", LOCAL_BRANCH], copyPath)).trim();
    const removed = storePaths.map((storePath, index) => ({
      path: input.paths[index]!,
      store_path: storePath,
      plaintext_commits: localOffenses[index]?.commits.length ?? 0,
    }));

    if (input.dryRun) {
      return {
        dry_run: true,
        old_main: oldMain,
        new_main: newMain,
        origin_tip_before: originTipBefore,
        origin_tip_after: copyOriginTip,
        offenders_removed: removed,
        backups: { bundle: bundlePath, copy: copyPath, bak_dir: null },
        services_stopped: false,
        services_restored: true,
        publish_succeeded: null,
        remaining_offenders: offendersAfter,
      };
    }

    // Step 6: swap the verified copy in. From here a failure restores the .bak store.
    say("swapping the verified copy in");
    await ok(ports, "mv", [storeDir, bakPath], { signal });
    bakMoved = true;
    await ok(ports, COPY, ["-R", copyPath, storeDir], { timeoutMs: 600_000, signal });
    swapped = true;
    const swappedMain = (await git(["rev-parse", LOCAL_BRANCH], storeDir)).trim();
    if (swappedMain !== newMain) throw new Error("swapped store does not hold the verified main");

    // Step 7: re-save each path, then check the store holds an encrypted blob for each and no plaintext anywhere on main.
    say("re-saving the paths with mise dot save");
    for (const storePath of storePaths) {
      await retryTransient(ports, "mise", ["dot", "save", livePathFor(storePath, home)], { cwd: home, timeoutMs: 600_000, signal });
    }
    const stillPlain = await remainingOffenders(git, storeDir, storePaths);
    if (stillPlain.length > 0) throw new Error(`re-save left plaintext blobs: ${stillPlain.join(", ")}`);
    const notEncrypted: string[] = [];
    for (const storePath of storePaths) {
      const blob = await blobAt(git, storeDir, LOCAL_BRANCH, storePath);
      if (blob === undefined || !blobIsEncrypted(await git(["cat-file", "blob", blob], storeDir))) notEncrypted.push(storePath);
    }
    if (notEncrypted.length > 0) throw new Error(`re-save did not leave an encrypted blob at ${LOCAL_BRANCH} for: ${notEncrypted.join(", ")}`);

    // Step 8: publish. Success is no `cannot publish`.
    say("publishing with mise dot sync");
    const syncOut = await retryTransient(ports, "mise", ["dot", "sync"], { cwd: home, timeoutMs: 600_000, signal });
    if (syncOut.includes("cannot publish")) throw new Error(`mise dot sync could not publish:\n${tail(syncOut)}`);
    published = true;
    const originTipAfter = (await git(["rev-parse", PUBLISHED_REF], storeDir)).trim();

    // Step 9: services back and confirmed live.
    say("restarting the mise history services");
    await startServices(ports);
    servicesStopped = false;

    return {
      dry_run: false,
      old_main: oldMain,
      new_main: newMain,
      origin_tip_before: originTipBefore,
      origin_tip_after: originTipAfter,
      offenders_removed: removed,
      backups: { bundle: bundlePath, copy: copyPath, bak_dir: bakPath },
      services_stopped: false,
      services_restored: true,
      publish_succeeded: true,
      remaining_offenders: stillPlain,
    };
  } catch (error) {
    // Never leave the store swapped with an unverified copy. Rollback ignores the abort signal: it must finish.
    const problems: string[] = [];
    if (published) {
      problems.push(`the publish had already succeeded, so the repaired store was KEPT (the old store is at ${bakPath})`);
    } else if (bakMoved) {
      try {
        if (swapped || (await exists(storeDir))) await rm(storeDir, { recursive: true, force: true });
        await ok(ports, "mv", [bakPath, storeDir]);
      } catch (restoreError) {
        problems.push(`RESTORING THE ORIGINAL STORE FAILED: ${(restoreError as Error).message}; the original is at ${bakPath}`);
      }
    }
    if (servicesStopped) {
      try {
        await startServices(ports);
      } catch (restartError) {
        problems.push(`restarting the services failed: ${(restartError as Error).message}`);
      }
    }
    const message = (error as Error).message;
    if (problems.length === 0) throw error;
    throw new Error(`${message}\n${problems.join("\n")}`, { cause: error });
  }
}
