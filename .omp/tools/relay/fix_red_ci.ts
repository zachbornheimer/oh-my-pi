import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, type Exec } from "./exec.js";
import { parsePullRequestUrl } from "./github.js";
import { FIX_BUDGET_MS, OMP_TASK_ROLE, type AgentStore, runAgent } from "./omp.js";
import { fillTemplate } from "./template.js";
import { readFileSync } from "node:fs";

/** Attempts one pull request gets before the pass gives up: each is a clone, an agent run, a push and a wait for CI. */
export const FIX_ROUNDS = 3;
/** How long after a push the pass waits for the new head's checks to finish, and how often it looks. */
export const CHECK_WAIT_MS = 30 * 60_000;
export const CHECK_POLL_MS = 30_000;
/** How long a pushed head may show no check at all before the pass reads that as "this repository has none". */
export const CHECKS_APPEAR_MS = 5 * 60_000;
/** The longest a failed check's log is carried into a prompt: its end, where the failure is. */
export const LOG_TAIL_CHARS = 6_000;

export type RedCiDeps = {
  exec: Exec;
  store: AgentStore;
  sleep(ms: number): Promise<void>;
  now(): number;
  signal?: AbortSignal;
};

type Check = { name: string; bucket: string; link: string };

/** The run id in a check's link: `https://github.com/o/r/actions/runs/<id>/job/<id>`. */
const RUN_ID = /\/actions\/runs\/(\d+)/;

/**
 * The pull request's checks. `gh pr checks` exits 1 when a check failed and 8 when one is pending even with `--json`, so
 * those codes still carry the JSON; a pull request with no checks answers an empty list.
 */
async function readChecks(deps: RedCiDeps, repo: string, number: number): Promise<Check[]> {
  const result = await deps.exec("gh", ["pr", "checks", String(number), "--repo", repo, "--json", "name,bucket,link"], {
    signal: deps.signal,
    timeout: 5 * 60_000,
  });
  if (result.killed) throw new Error(deps.signal?.aborted === true ? "gh pr checks was cancelled" : "gh pr checks timed out");
  if (result.code !== 0 && /no checks reported/i.test(result.stderr)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh pr checks ${number} (exit ${result.code}) answered no JSON: ${(result.stderr || result.stdout).trim().slice(-500)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`gh pr checks ${number} answered an unexpected shape`);
  return parsed.map((entry) => {
    const check = entry as Record<string, unknown>;
    if (typeof check.name !== "string" || typeof check.bucket !== "string") throw new Error(`gh pr checks ${number} answered a check with no name or bucket`);
    return { name: check.name, bucket: check.bucket, link: typeof check.link === "string" ? check.link : "" };
  });
}

/** What `gh` reports of a failed check: its log, or why there is none to show. */
export async function failedCheckLog(deps: RedCiDeps, repo: string, check: Check): Promise<string> {
  const runId = RUN_ID.exec(check.link)?.[1];
  if (runId === undefined) return "(no log: the check is not a GitHub Actions job)";
  try {
    return (await command(deps.exec, "gh", ["run", "view", runId, "--repo", repo, "--log-failed"], { signal: deps.signal })).slice(-LOG_TAIL_CHARS);
  } catch (error) {
    return `(no log: ${(error as Error).message.split("\n")[0]})`;
  }
}

async function headOf(deps: RedCiDeps, repo: string, number: number): Promise<string> {
  const view = JSON.parse(await command(deps.exec, "gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,headRefName"], { signal: deps.signal })) as Record<string, unknown>;
  if (typeof view.headRefOid !== "string") throw new Error(`gh pr view ${number} answered no head commit`);
  return view.headRefOid;
}

/** The last non-empty line of an agent's final text: what it says it changed, or why it did not. */
function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? "the agent said nothing";
}

type Round = { pushed: false; summary: string } | { pushed: true; sha: string; summary: string };

/**
 * One attempt: a clone of the pull request's head in a private directory, one headless agent run there that fixes the red
 * check and commits (it never pushes), then this code's own push of those commits. No commit means no fix was possible
 * from this repository, whatever the agent said.
 */
async function fixRound(deps: RedCiDeps, input: { url: string; repo: string; number: number; check: Check; log: string; earlier: string }): Promise<Round> {
  const directory = await mkdtemp(join(tmpdir(), "relay-fix-"));
  try {
    const checkout = join(directory, "checkout");
    await command(deps.exec, "gh", ["repo", "clone", input.repo, checkout], { signal: deps.signal, timeout: 30 * 60_000 });
    await command(deps.exec, "gh", ["pr", "checkout", String(input.number)], { cwd: checkout, signal: deps.signal });
    const branch = (await command(deps.exec, "git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: checkout, signal: deps.signal })).trim();
    const before = (await command(deps.exec, "git", ["rev-parse", "HEAD"], { cwd: checkout, signal: deps.signal })).trim();
    const prompt = fillTemplate(
      readFileSync(new URL("./prompts/fix_red_ci.md", import.meta.url), "utf8"),
      {
        url: input.url,
        branch,
        check: input.check.name,
        log: input.log,
        earlier: input.earlier === "" ? "" : `\nAn earlier attempt on this pull request did this, and the check is still red, so do not repeat it: ${input.earlier}\n`,
      },
      "fix_red_ci.md",
    );
    const final = await runAgent(deps.exec, deps.store, {
      cwd: checkout,
      prompt,
      model: OMP_TASK_ROLE,
      timeoutMs: FIX_BUDGET_MS,
      label: "the red-CI fixer",
      signal: deps.signal,
    });
    const ahead = Number((await command(deps.exec, "git", ["rev-list", "--count", `${before}..HEAD`], { cwd: checkout, signal: deps.signal })).trim());
    if (!Number.isInteger(ahead) || ahead === 0) return { pushed: false, summary: lastLine(final) };
    await command(deps.exec, "git", ["push"], { cwd: checkout, signal: deps.signal, timeout: 30 * 60_000 });
    const sha = (await command(deps.exec, "git", ["rev-parse", "HEAD"], { cwd: checkout, signal: deps.signal })).trim();
    return { pushed: true, sha, summary: lastLine(final) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Waits until the pull request's head is `sha` and its checks have finished; `undefined` when they never did within the wait. */
async function settledChecks(deps: RedCiDeps, repo: string, number: number, sha: string): Promise<Check[] | undefined> {
  const began = deps.now();
  while (deps.now() - began < CHECK_WAIT_MS) {
    if ((await headOf(deps, repo, number)) === sha) {
      const checks = await readChecks(deps, repo, number);
      if (checks.length > 0 && !checks.some((check) => check.bucket === "pending")) return checks;
      if (checks.length === 0 && deps.now() - began >= CHECKS_APPEAR_MS) return checks;
    }
    await deps.sleep(CHECK_POLL_MS);
  }
  return undefined;
}

/**
 * REMOTE (GitHub; pushes to the pull request's branch; spends model quota when a check is red): takes one pull request red in
 * CI and answers whether it could be greened, with a report. A pull request with no failed check is green with no round.
 * A failed check gets up to `FIX_ROUNDS` attempts, each pushed and then waited out in CI; the pass stops `impossible` when
 * an attempt makes no commit (the cause is outside this repository) and `spent` when the rounds are gone. Only failed
 * checks are judged: review threads, comments and merge conflicts are not examined.
 */
export async function fixRedCi(deps: RedCiDeps, prUrl: string): Promise<{ green: boolean; report: string }> {
  const { owner, repo: name, number } = parsePullRequestUrl(prUrl);
  const repo = `${owner}/${name}`;
  let failed = (await readChecks(deps, repo, number)).find((check) => check.bucket === "fail");
  if (failed === undefined) return { green: true, report: "The pull request has no failed check." };
  const reports: string[] = [];
  let earlier = "";
  for (let round = 1; round <= FIX_ROUNDS; round++) {
    deps.signal?.throwIfAborted();
    const log = await failedCheckLog(deps, repo, failed);
    const attempt = await fixRound(deps, { url: prUrl, repo, number, check: failed, log, earlier });
    reports.push(`  - round ${round} on ${failed.name}: ${attempt.summary}`);
    if (!attempt.pushed) {
      return { green: false, report: [`${prUrl}: impossible (the fixer made no commit)`, ...reports].join("\n") };
    }
    earlier = attempt.summary;
    const checks = await settledChecks(deps, repo, number, attempt.sha);
    if (checks === undefined) {
      return { green: false, report: [`${prUrl}: spent (the checks on the pushed head did not finish within ${CHECK_WAIT_MS / 60_000} minutes)`, ...reports].join("\n") };
    }
    failed = checks.find((check) => check.bucket === "fail");
    if (failed === undefined) {
      return { green: true, report: [`${prUrl}: done after ${round} round${round === 1 ? "" : "s"}`, ...reports].join("\n") };
    }
  }
  return { green: false, report: [`${prUrl}: spent (${FIX_ROUNDS} rounds, ${failed.name} is still red)`, ...reports].join("\n") };
}
