import { INFRA_MARKERS, NEVER_RERUN, RERUN_ALLOWLIST } from "./constants.js";
import { type Basis, type FailingJob, GREEN_BASIS, NO_CI_BASIS, type RepoState } from "./states.js";

export type RollupState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | "ABSENT";

export type Triage =
  | { kind: "green" }
  | { kind: "queued"; evidence: string }
  | { kind: "no-ci" }
  | { kind: "api-error"; endpoint: string; status: number }
  | { kind: "classify" }
  | { kind: "pr-only"; evidence: string };

export type JobFact = FailingJob & {
  actionsRun: boolean;
  workflowName: string;
  runId: number | null;
  previousConclusion: string | null;
};

export type Classified =
  | { kind: "infra"; jobs: JobFact[]; evidence: string }
  | { kind: "flake"; job: JobFact; evidence: string }
  | { kind: "code"; jobs: JobFact[]; evidence: string };

const FAILING: Record<string, true> = { FAILURE: true, ERROR: true, CANCELLED: true, TIMED_OUT: true };

export function triageRepo(input: {
  workflowStatus: number;
  workflowCount: number;
  rollupStatus: number;
  rollup: RollupState;
}): Triage {
  if (input.workflowStatus !== 200) {
    return { kind: "api-error", endpoint: "actions/workflows", status: input.workflowStatus };
  }
  if (input.rollupStatus !== 200) {
    return { kind: "api-error", endpoint: "statusCheckRollup", status: input.rollupStatus };
  }
  if (input.rollup === "SUCCESS") return { kind: "green" };
  if (input.rollup === "PENDING" || input.rollup === "EXPECTED") {
    return { kind: "queued", evidence: `statusCheckRollup ${input.rollup}` };
  }
  if (input.rollup === "ABSENT" && input.workflowCount === 0) return { kind: "no-ci" };
  if (input.rollup === "ABSENT") {
    return { kind: "pr-only", evidence: "workflows present, default-branch rollup absent" };
  }
  return { kind: "classify" };
}

export function classifyJobs(jobs: JobFact[]): Classified {
  const failing = jobs.filter((job) => FAILING[job.conclusion.toUpperCase()] === true);
  if (failing.length === 0) return { kind: "code", jobs, evidence: "uncertain classification defaults to code" };
  if (failing.every(isInfra)) return { kind: "infra", jobs: failing, evidence: infraEvidence(failing) };
  const flake = failing.find(isFlake);
  if (flake && failing.every((job) => isFlake(job) || isInfra(job))) {
    return { kind: "flake", job: flake, evidence: `flake ${flake.name} ${flake.logUrl}` };
  }
  return { kind: "code", jobs: failing, evidence: "uncertain classification defaults to code" };
}

function isInfra(job: JobFact): boolean {
  if (!job.actionsRun) return true;
  const hay = `${job.name} ${job.workflowName}`.toLowerCase();
  return markerHits(hay, INFRA_MARKERS) || markerHits(hay, NEVER_RERUN);
}

function isFlake(job: JobFact): boolean {
  if (!job.actionsRun || isInfra(job) || !allowlisted(job)) return false;
  const conclusion = job.conclusion.toUpperCase();
  if (conclusion === "CANCELLED" || conclusion === "TIMED_OUT") return true;
  return job.previousConclusion?.toUpperCase() === "SUCCESS";
}

function allowlisted(job: JobFact): boolean {
  const workflow = job.workflowName.toLowerCase();
  const name = job.name.toLowerCase();
  if (workflow.includes("mise") || name.includes("mise")) return true;
  return RERUN_ALLOWLIST.some((allowed) => workflow === allowed || name === allowed);
}

function markerHits(hay: string, markers: readonly string[]): boolean {
  return markers.some((marker) => hay.includes(marker));
}

function infraEvidence(jobs: JobFact[]): string {
  const job = jobs[0];
  return job === undefined ? "infra" : `infra ${job.name} ${job.logUrl}`;
}

export type OpenFix = { number: number; url: string; branch: string; headSha: string };

/** Everything one repository's default branch showed when it was read. */
export type RepoFacts = {
  nameWithOwner: string;
  defaultBranch: string;
  workflowStatus: number;
  workflowCount: number;
  workflowNames: string[];
  rollupStatus: number;
  rollup: RollupState;
  headSha: string;
  jobs: JobFact[];
  openPr?: OpenFix;
};

/** What the ledger already says about the repository. It never keeps a repository from being triaged again. */
export type Prior = { state: RepoState; prUrl: string };

/** The one thing to do for a repository. Only `record` writes a state without further work. */
export type Classification =
  | {
    action: "record";
    from: string;
    to: RepoState;
    evidence: string;
    basis?: Basis;
    failingJobs?: FailingJob[];
  }
  | { action: "rerun"; evidence: string; runId: number; job: JobFact }
  | { action: "fix"; evidence: string; headSha: string; jobs: JobFact[]; openPr?: OpenFix }
  | { action: "reread"; evidence: string; prUrl: string; prNumber: number };

export type ClassifyContext = { dryRun: boolean; resumed: boolean };

/**
 * The one action for a repository, from what it showed and what the ledger holds. A dry run records and never
 * reruns or fixes: the work it would have done is recorded as `queued`. A pending merge is re-read, not redone.
 */
export function classifyRepository(
  facts: RepoFacts,
  prior: Prior | undefined,
  context: ClassifyContext,
): Classification {
  if (context.resumed && prior?.state === "awaiting-merge") {
    return {
      action: "reread",
      evidence: "awaiting merge on resume",
      prUrl: prior.prUrl,
      prNumber: pullNumber(prior.prUrl),
    };
  }
  return classifyTriage(facts, prior?.state ?? "", context.dryRun);
}

function classifyTriage(facts: RepoFacts, from: string, dryRun: boolean): Classification {
  const triage = triageRepo(facts);
  if (triage.kind === "green") {
    return { ...recordState(from, "green", "statusCheckRollup SUCCESS"), basis: GREEN_BASIS };
  }
  if (triage.kind === "no-ci") {
    return { ...recordState(from, "no-ci", "actions/workflows 200 empty"), basis: NO_CI_BASIS };
  }
  if (triage.kind === "api-error") {
    return recordState(from, "api-error", `${triage.endpoint} HTTP ${triage.status}`);
  }
  if (triage.kind === "queued") return recordState(from, "queued", triage.evidence);
  if (triage.kind === "pr-only") {
    if (dryRun) return recordState(from, "queued", triage.evidence);
    return { action: "fix", evidence: triage.evidence, headSha: facts.headSha, jobs: facts.jobs, openPr: facts.openPr };
  }
  return classifyFailure(facts, from, dryRun);
}

function classifyFailure(facts: RepoFacts, from: string, dryRun: boolean): Classification {
  const classified = classifyJobs(facts.jobs);
  if (classified.kind === "infra") {
    return { ...recordState(from, "infra", classified.evidence), failingJobs: failingOf(classified.jobs) };
  }
  if (classified.kind === "flake" && classified.job.runId !== null) {
    if (dryRun) return recordState(from, "queued", classified.evidence);
    return { action: "rerun", evidence: classified.evidence, runId: classified.job.runId, job: classified.job };
  }
  if (dryRun) {
    return { ...recordState(from, "queued", classified.evidence), failingJobs: failingOf(failedJobs(classified)) };
  }
  return {
    action: "fix",
    evidence: classified.evidence,
    headSha: facts.headSha,
    jobs: facts.jobs,
    openPr: facts.openPr,
  };
}

function failedJobs(classified: Classified): JobFact[] {
  return classified.kind === "flake" ? [classified.job] : classified.jobs;
}

function recordState(from: string, to: RepoState, evidence: string): Extract<Classification, { action: "record" }> {
  return { action: "record", from, to, evidence };
}

function failingOf(jobs: readonly JobFact[]): FailingJob[] {
  return jobs.map((job) => ({ name: job.name, conclusion: job.conclusion, logUrl: job.logUrl }));
}

/** A pull request URL's trailing number; 0 when the URL has none. */
export function pullNumber(url: string): number {
  const number = Number(url.split("/").at(-1));
  return Number.isInteger(number) ? number : 0;
}
