import type { Capability, JobName, SiteStage, StageName, StageStatus, StepOutcome, Tier } from "./types";

/**
 * How many pages per site the Monday `weekly` job audits. Oldest sitemap lastmod goes first, so successive weeks
 * rotate through the site; the record says "sampled N of M". There is no unlimited default: an unbounded run on a
 * 435-page site never finished and had to be killed.
 */
export const WEEKLY_PAGE_LIMIT = 10;

/** What the Monday check does for one site. Pure: the tier is the only input. */
export interface WeeklyPolicy {
  filing: boolean;
  /** Personal-tier sites are canaries in intent, but the policy fixes every tier (as the source does). */
  fix: boolean;
  /** Apply (back up, change, verify) is never scheduled until a site opts in. */
  apply: boolean;
  /** Pages the audit may run per site; always set, never unlimited. */
  pageLimit: number;
}

export function weeklyPolicy(_tier: Tier): WeeklyPolicy {
  return { filing: true, fix: true, apply: false, pageLimit: WEEKLY_PAGE_LIMIT };
}

/** The hourly job measures reachability only. */
export const UPTIME_CAPABILITIES: readonly Capability[] = ["uptime"];

/** The daily job measures what changes on its own between weeks: security and reachability. */
export const DAILY_CAPABILITIES: readonly Capability[] = ["security", "uptime"];

/** The reminder asks Zach to run the skill for this site. */
export const REMINDER_SITE = "isjac";

export function reminderMessage(readyReport: string | undefined): string {
  const ask = `Weekly webmaster: say 'Please run /webmaster ${REMINDER_SITE}'`;
  return readyReport === undefined ? ask : `${ask} (report ready: ${readyReport})`;
}

const SNAPSHOT_SUFFIX = ".json";

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Snapshot names replace ':' with '-', so a run's start time compares as a file name. */
function asSnapshotName(iso: string): string {
  return `${iso.replaceAll(":", "-")}${SNAPSHOT_SUFFIX}`;
}

/**
 * The newest saved report written at or after the job began; undefined when the run saved none
 * (an older snapshot would describe a different run and must not feed notify-decision).
 */
export function freshSnapshot(paths: readonly string[], jobStartedAt: Date): string | undefined {
  const floor = asSnapshotName(jobStartedAt.toISOString());
  const named = paths
    .filter((path) => baseName(path).endsWith(SNAPSHOT_SUFFIX))
    .sort((a, b) => baseName(a).localeCompare(baseName(b)));
  const newest = named.at(-1);
  return newest !== undefined && baseName(newest).localeCompare(floor) >= 0 ? newest : undefined;
}

/** A step outcome as a stage; `not wired` is never ok. */
export function stageOf(stage: StageName, outcome: StepOutcome): SiteStage {
  if (outcome.status === "not wired") {
    return { stage, status: "not-wired", detail: "port not wired; run is incomplete" };
  }
  return { stage, status: outcome.status === "done" ? "ok" : "failed", detail: outcome.detail };
}

const CLEAN: ReadonlySet<StageStatus> = new Set(["ok", "not-requested"]);

export function siteStatus(stages: readonly SiteStage[]): "ok" | "incomplete" | "refused" {
  if (stages.some((stage) => stage.status === "refused")) return "refused";
  return stages.every((stage) => CLEAN.has(stage.status)) ? "ok" : "incomplete";
}

/** A run that covered no site cannot be called complete; neither can one with any unclean site. */
export function runStatus(
  job: JobName,
  outcomes: readonly { readonly status: string }[],
  ranStepOk: boolean,
): "complete" | "incomplete" {
  if (job === "weekly-reminder") return ranStepOk ? "complete" : "incomplete";
  // Sites skipped by `only` do not make a run incomplete, but a run that ran no site is not complete.
  const ran = outcomes.filter((outcome) => outcome.status !== "skipped");
  return ran.length > 0 && ranStepOk && ran.every((outcome) => outcome.status === "ok") ? "complete" : "incomplete";
}
