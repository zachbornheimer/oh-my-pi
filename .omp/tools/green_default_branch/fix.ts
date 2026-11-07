import { join } from "node:path";
import { AGENT_LIMIT_MS, FIX_BRANCH_PREFIX, OMP_BIN, OMP_TASK_ROLE, POLL_MS } from "./constants.js";
import { contextOf, type RepositoryContext } from "./context.js";
import { readListing } from "./github.js";
import type { CommandResult, Host } from "./host.js";
import { agentMsToday, readEvents } from "./ledger.js";
import { isCancelled } from "./read_state.js";
import { agentCapReached, localDay, type Outcome, type OutcomeStep } from "./states.js";
import type { Classification } from "./triage.js";

/** How the fixer stopped. */
export type FixResult =
  & (
    | { kind: "pushed"; branch: string; pid: number; elapsedSeconds: number }
    | { kind: "empty"; pid: number; elapsedSeconds: number }
    | { kind: "push-failed"; branch: string; reason: string; pid: number; elapsedSeconds: number }
    | { kind: "push-rejected"; ref: string; pid: number }
    | { kind: "timed-out"; pid: number; elapsedSeconds: number }
    | { kind: "deferred"; reason: string; elapsedSeconds: number }
    | { kind: "capped"; reason: string }
    | { kind: "failed"; error: string }
    | { kind: "skipped"; reason: string }
  )
  & {
    /** Set when the clone could not be removed. */
    cleanup?: string;
  };

export type FixOutput = { context: RepositoryContext; fix: FixResult; outcome: Outcome };

/**
 * omp's `@task` role, headless, in `cwd`. The one way a fixer starts omp. It is launched with no `--config`, so omp's own
 * fallback chain for the role applies.
 */
export function launchOmp(
  host: Host,
  input: { cwd: string; prompt: string; onPid?: (pid: number) => void },
): Promise<CommandResult> {
  const argv = ["-p", input.prompt, "--cwd", input.cwd, "--model", OMP_TASK_ROLE];
  return host.exec(OMP_BIN, argv, { cwd: input.cwd, onPid: input.onPid });
}

function fixBranch(date: Date): string {
  return `${FIX_BRANCH_PREFIX}${localDay(date)}`;
}

function allowedRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Tags, the default branch, and every ref other than the day's branch are refused. */
function allowPush(remoteRef: string, allowed: string): boolean {
  return remoteRef === allowed && remoteRef.startsWith("refs/heads/") && !remoteRef.startsWith("refs/tags/");
}

function pushRefspec(branch: string): string {
  const ref = allowedRef(branch);
  return `${ref}:${ref}`;
}

function fixerPrompt(branch: string): string {
  return `/green\n\nPush only ${
    allowedRef(branch)
  }, never the default branch, never force-push, never retag, never merge.`;
}

function hookScript(allowed: string, violationFile: string): string {
  return `#!/bin/sh
allowed='${allowed}'
violation='${violationFile}'
while read local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    "$allowed") ;;
    *)
      printf '%s\\n' "$remote_ref" >> "$violation"
      exit 1
      ;;
  esac
done
exit 0
`;
}

function violationPath(worktree: string): string {
  return join(worktree, ".repo-green", "push-violation");
}

type FixerStop =
  | { kind: "exited"; status: number; stdout: string; stderr: string; elapsedMs: number; pid: number }
  | { kind: "timed-out"; pid: number; elapsedMs: number }
  | { kind: "push-rejected"; ref: string; pid: number; elapsedMs: number };

/**
 * Clones the repository, runs omp's `/green` fixer on the day's `ci-green/` branch under a pre-push hook that refuses
 * every other ref and a timeout of AGENT_LIMIT, then pushes the branch when the agent changed anything. Refuses to
 * start once the day's agent time leaves no room for another run. Never runs on a dry run. The worktree is removed
 * before this returns. Stops are returned, not thrown; a cancelled run is thrown after the clone is removed.
 */
export async function pushOmpCiFixToCiGreenBranch(
  host: Host,
  input: RepositoryContext,
  classification: Classification,
  progress: (message: string) => void = () => {},
): Promise<FixOutput> {
  const context = contextOf(input);
  if (context.dryRun === true) return finished(context, { kind: "skipped", reason: "dry run" });
  if (classification.action !== "fix") {
    return finished(context, { kind: "skipped", reason: `classified ${classification.action}, not fix` });
  }
  if (agentCapReached(agentMsToday(await readEvents(host), host.now()))) {
    return finished(context, { kind: "capped", reason: "daily agent cap" });
  }
  const repo = context.nameWithOwner;
  const defaultBranch = context.defaultBranch ?? await defaultBranchOf(host, repo);
  const branch = classification.openPr?.branch ?? fixBranch(host.now());
  const worktree = join(host.worktrees(), repo);
  let fix: FixResult;
  let cancelled: unknown;
  try {
    progress(`${repo}: preparing a clone for the fixer`);
    await prepareWorktree(host, { repo, worktree, branch, defaultBranch, resumeBranch: classification.openPr?.branch });
    progress(`${repo}: omp /green is fixing ${branch}`);
    fix = await pushFix(host, worktree, defaultBranch, branch, await runFixer(host, { worktree, branch }));
  } catch (error) {
    if (isCancelled(error)) cancelled = error;
    fix = { kind: "failed", error: `fix ${repo} failed: ${(error as Error).message}` };
  }
  const cleanup = await removeWorktree(host, worktree);
  if (cancelled !== undefined) throw cancelled;
  return finished({ ...context, defaultBranch }, cleanup === undefined ? fix : { ...fix, cleanup });
}

function finished(context: RepositoryContext, fix: FixResult): FixOutput {
  return { context: contextOf(context), fix, outcome: outcomeOfFix(fix, context.defaultBranch) };
}

async function defaultBranchOf(host: Host, repo: string): Promise<string> {
  const listing = await readListing(host, repo);
  if (listing === undefined) throw new Error(`GitHub did not return ${repo}`);
  return listing.defaultBranch;
}

/**
 * The ledger steps a fixer's result implies. A pushed branch implies only that the fixer ran; merging is next. A clone
 * that could not be removed is named in the last step's evidence: the repository's state stays the fixer's result.
 */
export function outcomeOfFix(fix: FixResult, defaultBranch: string | undefined): Outcome {
  const outcome = stopOutcome(fix, defaultBranch);
  const last = outcome.steps.at(-1);
  if (fix.cleanup === undefined || last === undefined) return outcome;
  const noted: OutcomeStep = { ...last, evidence: `${last.evidence}; ${fix.cleanup}` };
  return { ...outcome, steps: [...outcome.steps.slice(0, -1), noted] };
}

function stopOutcome(fix: FixResult, defaultBranch: string | undefined): Outcome {
  if (fix.kind === "skipped") return { steps: [] };
  if (fix.kind === "capped") return { steps: [{ from: "", to: "deferred", evidence: fix.reason }] };
  if (fix.kind === "failed") return { steps: [{ from: "queued", to: "unclassified", evidence: fix.error }] };
  if (fix.kind === "push-rejected") {
    const reason = `push refused ${fix.ref}`;
    return { steps: [{ from: "queued", to: "needs-human", evidence: reason, pid: fix.pid }], human: reason };
  }
  if (fix.kind === "timed-out") {
    const step: OutcomeStep = {
      from: "fixing",
      to: "timed-out",
      evidence: `agent limit pid ${fix.pid}`,
      elapsedSeconds: fix.elapsedSeconds,
      pid: null,
    };
    return { steps: [step] };
  }
  if (fix.kind === "deferred") {
    const step: OutcomeStep = {
      from: "fixing",
      to: "deferred",
      evidence: fix.reason,
      elapsedSeconds: fix.elapsedSeconds,
      pid: null,
    };
    return { steps: [step] };
  }
  // The agent's time is charged once, on the `fixing` step: the daily cap sums every event's elapsedSeconds.
  const fixing: OutcomeStep = {
    from: "queued",
    to: "fixing",
    evidence: `omp pid ${fix.pid}`,
    pid: fix.pid,
    elapsedSeconds: fix.elapsedSeconds,
    defaultBranch,
  };
  if (fix.kind === "pushed") return { steps: [fixing] };
  if (fix.kind === "empty") {
    const unfixed: OutcomeStep = { from: "fixing", to: "unfixed", evidence: "empty diff; no pull request", pid: null };
    return { steps: [fixing, unfixed] };
  }
  const needsHuman: OutcomeStep = { from: "fixing", to: "needs-human", evidence: fix.reason, pid: null };
  return { steps: [fixing, needsHuman], human: fix.reason };
}

async function pushFix(
  host: Host,
  worktree: string,
  defaultBranch: string,
  branch: string,
  stop: FixerStop,
): Promise<FixResult> {
  if (stop.kind === "push-rejected") return { kind: "push-rejected", ref: stop.ref, pid: stop.pid };
  const elapsedSeconds = Math.round(stop.elapsedMs / 1000);
  if (stop.kind === "timed-out") return { kind: "timed-out", pid: stop.pid, elapsedSeconds };
  if (deferredExit(stop)) return { kind: "deferred", reason: stop.stderr.trim() || "rate limit", elapsedSeconds };
  const diff = await host.exec("git", ["diff", `${defaultBranch}...HEAD`], { cwd: worktree });
  if (diff.stdout.trim() === "") return { kind: "empty", pid: stop.pid, elapsedSeconds };
  const ref = allowedRef(branch);
  if (!allowPush(ref, ref)) {
    return { kind: "push-failed", branch, reason: `refused push ${ref}`, pid: stop.pid, elapsedSeconds };
  }
  const pushed = await host.exec("git", ["push", "origin", ref], { cwd: worktree });
  if (pushed.status !== 0) {
    const reason = `push ${ref} failed: ${pushed.stderr.trim()}`;
    return { kind: "push-failed", branch, reason, pid: stop.pid, elapsedSeconds };
  }
  return { kind: "pushed", branch, pid: stop.pid, elapsedSeconds };
}

/** What a killed run can leave half done in a checkout; each exits non-zero when nothing is in progress. */
const ABORT_IN_PROGRESS_OPERATION = ["merge", "rebase", "cherry-pick", "am"].map((operation) => [operation, "--abort"]);

function isOriginOf(url: string, repo: string): boolean {
  const normalised = url.trim().toLowerCase().replace(/\.git\/?$/, "");
  const name = repo.toLowerCase();
  return normalised.endsWith(`github.com/${name}`) || normalised.endsWith(`github.com:${name}`);
}

/**
 * Resets an existing clone of the repository to the tip of its default branch: aborts any merge, rebase, cherry-pick
 * or am a crashed run left, fetches the default branch, points `refs/remotes/origin/HEAD` at it (a fetch never creates
 * it, and the global pre-push hooks diff against it), hard resets, cleans every untracked and ignored file (so a
 * stale `.repo-green/push-violation` cannot stop the next run), and puts the local default branch on the fetched tip.
 * False when the path is not a usable clone of the repository, so the caller replaces it.
 */
async function reuseClone(
  host: Host,
  input: { repo: string; worktree: string; defaultBranch: string },
): Promise<boolean> {
  if (!(await host.exists(join(input.worktree, ".git")))) return false;
  const git = (args: string[]) => host.exec("git", args, { cwd: input.worktree });
  const origin = await git(["remote", "get-url", "origin"]);
  if (origin.status !== 0 || !isOriginOf(origin.stdout, input.repo)) return false;
  for (const abort of ABORT_IN_PROGRESS_OPERATION) await git(abort);
  const remote = `refs/remotes/origin/${input.defaultBranch}`;
  const steps = [
    ["fetch", "--depth", "1", "origin", `+refs/heads/${input.defaultBranch}:${remote}`],
    ["remote", "set-head", "origin", input.defaultBranch],
    ["reset", "--hard"],
    ["clean", "-ffdx"],
    ["checkout", "-f", "-B", input.defaultBranch, remote],
  ];
  for (const args of steps) {
    if ((await git(args)).status !== 0) return false;
  }
  return true;
}

/** Leaves the cache path at a clean checkout of the default branch, whatever an earlier run left there. */
async function checkoutDefaultBranch(
  host: Host,
  input: { repo: string; worktree: string; defaultBranch: string },
): Promise<void> {
  if (await reuseClone(host, input)) return;
  await host.remove(input.worktree);
  await host.mkdirp(join(input.worktree, ".."));
  const cloned = await host.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    input.defaultBranch,
    `https://github.com/${input.repo}.git`,
    input.worktree,
  ]);
  if (cloned.status !== 0) throw new Error(`clone ${input.repo} failed: ${cloned.stderr.trim()}`);
  const head = await host.exec("git", ["remote", "set-head", "origin", input.defaultBranch], { cwd: input.worktree });
  if (head.status !== 0) {
    throw new Error(`set origin/HEAD to ${input.defaultBranch} in ${input.repo} failed: ${head.stderr.trim()}`);
  }
}

async function prepareWorktree(
  host: Host,
  input: { repo: string; worktree: string; branch: string; defaultBranch: string; resumeBranch?: string },
): Promise<void> {
  const branch = input.resumeBranch ?? input.branch;
  await checkoutDefaultBranch(host, input);
  if (input.resumeBranch) {
    // The clone is single-branch, so a bare `fetch origin <branch>` leaves no ref to check out: name the ref.
    const remote = `refs/remotes/origin/${input.resumeBranch}`;
    const fetched = await host.exec("git", ["fetch", "origin", `+refs/heads/${input.resumeBranch}:${remote}`], {
      cwd: input.worktree,
    });
    if (fetched.status !== 0) throw new Error(`fetch ${input.resumeBranch} failed: ${fetched.stderr.trim()}`);
    const switched = await host.exec("git", ["checkout", "-B", input.resumeBranch, remote], { cwd: input.worktree });
    if (switched.status !== 0) throw new Error(`checkout ${input.resumeBranch} failed: ${switched.stderr.trim()}`);
  } else {
    const switched = await host.exec("git", ["checkout", "-B", branch], { cwd: input.worktree });
    if (switched.status !== 0) throw new Error(`checkout ${branch} failed: ${switched.stderr.trim()}`);
  }
  const hookPath = join(input.worktree, ".git", "hooks", "pre-push");
  await host.mkdirp(join(input.worktree, ".repo-green"));
  await host.mkdirp(join(input.worktree, ".git", "hooks"));
  await host.writeText(hookPath, hookScript(allowedRef(branch), violationPath(input.worktree)));
  await host.makeExecutable(hookPath);
  const configured = await host.exec("git", ["config", "remote.origin.push", pushRefspec(branch)], {
    cwd: input.worktree,
  });
  if (configured.status !== 0) {
    throw new Error(`git config remote.origin.push failed in ${input.repo}: ${configured.stderr.trim()}`);
  }
}

async function runFixer(host: Host, input: { worktree: string; branch: string }): Promise<FixerStop> {
  const started = host.now().getTime();
  let pid = 0;
  const running = launchOmp(host, {
    cwd: input.worktree,
    prompt: fixerPrompt(input.branch),
    onPid: (spawned) => {
      pid = spawned;
    },
  });
  // A launch that fails or is cancelled must not become an unhandled rejection while the watch loop runs.
  running.catch(() => undefined);
  const stopped = await watchFixer(host, input.worktree, started, running);
  if (stopped === "exited") {
    const result = await running;
    return {
      kind: "exited",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs: host.now().getTime() - started,
      pid,
    };
  }
  if (pid !== 0) await host.kill(pid);
  const rejected = await host.readText(violationPath(input.worktree));
  if (stopped === "push-rejected" || (rejected !== undefined && rejected.trim() !== "")) {
    return { kind: "push-rejected", ref: rejected?.trim() ?? "", pid, elapsedMs: host.now().getTime() - started };
  }
  return { kind: "timed-out", pid, elapsedMs: host.now().getTime() - started };
}

async function watchFixer(
  host: Host,
  worktree: string,
  started: number,
  running: Promise<unknown>,
): Promise<"exited" | "timed-out" | "push-rejected"> {
  while (host.now().getTime() - started < AGENT_LIMIT_MS) {
    const rejected = await host.readText(violationPath(worktree));
    if (rejected !== undefined && rejected.trim() !== "") return "push-rejected";
    const tick = host.sleep(POLL_MS).then(() => "tick" as const);
    // A launch that rejects (omp missing, run cancelled) ends the wait; awaiting `running` afterwards rethrows it.
    const done = running.then(() => "exited" as const, () => "exited" as const);
    const step = await Promise.race([tick, done]);
    if (step === "exited") {
      const after = await host.readText(violationPath(worktree));
      return after !== undefined && after.trim() !== "" ? "push-rejected" : "exited";
    }
  }
  return "timed-out";
}

const RATE_LIMIT_TEXT = /rate[ -]?limit|model refusal|\b429\b/i;

/**
 * The fixer stopped because the model provider would not serve it, not because it finished: exit status 75, or a failed
 * exit whose error output says so. A clean exit is never deferred, whatever the agent's own summary mentions.
 */
function deferredExit(result: { status: number; stderr: string }): boolean {
  return result.status === 75 || (result.status !== 0 && RATE_LIMIT_TEXT.test(result.stderr));
}

async function removeWorktree(host: Host, worktree: string): Promise<string | undefined> {
  try {
    await host.remove(worktree);
    return undefined;
  } catch (error) {
    return `worktree remove ${worktree} failed: ${(error as Error).message}`;
  }
}
