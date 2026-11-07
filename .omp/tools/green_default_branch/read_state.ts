import { readListing, readOpenFix, readPreviousConclusion, readRollup, readWorkflows } from "./github.js";
import type { Host } from "./host.js";
import { readRow } from "./ledger.js";
import { contextOf, type RepositoryContext } from "./context.js";
import { type Classification, classifyRepository, type JobFact, type RepoFacts } from "./triage.js";

export type FactsRead = RepositoryContext & { facts?: RepoFacts; failure?: string };

/**
 * What the repository's default branch shows right now: its Actions workflows, the status-check rollup with each
 * failing job and that workflow's previous conclusion, and an open `ci-green/` pull request. A read that answers a
 * non-200 is repeated once; the status is kept so triage can call it an API error. An unreadable repository returns
 * `failure`, never throws.
 */
export async function readDefaultBranchCiState(host: Host, input: RepositoryContext): Promise<FactsRead> {
  const context = contextOf(input);
  try {
    const repo = input.nameWithOwner;
    const defaultBranch = input.defaultBranch ?? await defaultBranchOf(host, repo);
    let workflows = await readWorkflows(host, repo);
    if (workflows.status !== 200) workflows = await readWorkflows(host, repo);
    let rollup = await readRollup(host, repo);
    if (rollup.status !== 200) rollup = await readRollup(host, repo);
    const jobs: JobFact[] = [];
    for (const job of rollup.jobs) {
      const previousConclusion = job.actionsRun
        ? await readPreviousConclusion(host, repo, defaultBranch, job.workflowName || job.name)
        : null;
      jobs.push({ ...job, previousConclusion });
    }
    const facts: RepoFacts = {
      nameWithOwner: repo,
      defaultBranch,
      workflowStatus: workflows.status,
      workflowCount: workflows.count,
      workflowNames: workflows.names,
      rollupStatus: rollup.status,
      rollup: rollup.rollup,
      headSha: rollup.headSha,
      jobs,
      openPr: await readOpenFix(host, repo),
    };
    return { ...context, defaultBranch, facts };
  } catch (error) {
    if (isCancelled(error)) throw error;
    return { ...context, failure: `reading ${input.nameWithOwner} failed: ${(error as Error).message}` };
  }
}

/** A cancelled run is not a repository that failed to read: it stops the run. */
export function isCancelled(error: unknown): boolean {
  return error instanceof Error && /was cancelled/.test(error.message);
}

export async function defaultBranchOf(host: Host, repo: string): Promise<string> {
  const listing = await readListing(host, repo);
  if (listing === undefined) throw new Error(`GitHub did not return ${repo}`);
  return listing.defaultBranch;
}

export type Classified = { context: RepositoryContext; classification: Classification };

/**
 * The one action for the repository and the state it records. The ledger row is only context: every repository is
 * triaged fresh from GitHub, whatever state the ledger last recorded. A dry run turns every rerun and fix into a
 * recorded `queued`. Facts that could not be read are recorded as `unclassified`.
 */
export async function classifyDefaultBranchCiState(host: Host, input: RepositoryContext, read?: FactsRead): Promise<Classified> {
  const facts = read ?? await readDefaultBranchCiState(host, input);
  const context = { ...contextOf(input), defaultBranch: facts.facts?.defaultBranch ?? input.defaultBranch };
  if (facts.facts === undefined) {
    return {
      context,
      classification: {
        action: "record",
        from: "",
        to: "unclassified",
        evidence: facts.failure ?? "facts were not read",
      },
    };
  }
  const row = await readRow(host, input.nameWithOwner);
  const prior = row === undefined ? undefined : { state: row.state, prUrl: row.prUrl };
  const classification = classifyRepository(facts.facts, prior, {
    dryRun: input.dryRun ?? false,
    resumed: input.resumed ?? false,
  });
  return { context, classification };
}
