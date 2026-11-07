import { contextOf, type RepositoryContext } from "./context.js";
import { GH_BIN, POLL_MS, RERUN_LIMIT_MS } from "./constants.js";
import type { Host } from "./host.js";
import type { Outcome } from "./states.js";
import type { Classification, JobFact } from "./triage.js";
import { isCancelled } from "./read_state.js";

/**
 * Reruns the flaky job and waits up to RERUN_LIMIT for the rerun to finish. The outcome is `flaky-rerun` only when the
 * rerun's conclusion is SUCCESS; a rerun that fails, is refused or does not finish in time is `rerun-failed`. Does
 * nothing on a dry run or when the classification is not a rerun.
 */
export async function rerunFlakyDefaultBranchJobs(
  host: Host,
  input: RepositoryContext,
  classification: Classification,
): Promise<{ context: RepositoryContext; outcome: Outcome }> {
  const context = contextOf(input);
  if (classification.action !== "rerun" || context.dryRun === true) return { context, outcome: { steps: [] } };
  const { runId, job } = classification;
  try {
    return { context, outcome: await rerun(host, context, runId, job) };
  } catch (error) {
    if (isCancelled(error)) throw error;
    const evidence = `rerun ${runId} failed: ${(error as Error).message}`;
    return { context, outcome: { steps: [{ from: "queued", to: "unclassified", evidence }] } };
  }
}

async function rerun(host: Host, context: RepositoryContext, runId: number, job: JobFact): Promise<Outcome> {
  const repo = context.nameWithOwner;
  const started = await host.exec(GH_BIN, ["run", "rerun", String(runId), "--repo", repo]);
  if (started.status !== 0) {
    const evidence = `gh run rerun ${runId} failed: ${started.stderr.trim()}`;
    return { steps: [{ from: "queued", to: "rerun-failed", evidence }] };
  }
  const result = await pollRerun(host, repo, runId);
  return {
    steps: [{
      from: "queued",
      to: result === "SUCCESS" ? "flaky-rerun" : "rerun-failed",
      evidence: `rerun ${runId} ${result} ${job.logUrl}`,
      failingJobs: [{ name: job.name, conclusion: job.conclusion, logUrl: job.logUrl }],
      defaultBranch: context.defaultBranch,
    }],
  };
}

async function pollRerun(host: Host, repo: string, runId: number): Promise<"SUCCESS" | "failed" | "timeout"> {
  const started = host.now().getTime();
  while (host.now().getTime() - started < RERUN_LIMIT_MS) {
    const view = await host.exec(GH_BIN, ["run", "view", String(runId), "--repo", repo, "--json", "conclusion,status"]);
    const conclusion = conclusionOf(view.stdout);
    if (conclusion === "SUCCESS") return "SUCCESS";
    if (conclusion === "FAILURE" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT") return "failed";
    await host.sleep(POLL_MS);
  }
  return "timeout";
}

function conclusionOf(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object" || !("conclusion" in parsed)) return "";
    return typeof parsed.conclusion === "string" ? parsed.conclusion.toUpperCase() : "";
  } catch {
    return "";
  }
}
