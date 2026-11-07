/**
 * Plain types of one scheduled webmaster run. Port of `webmaster-site/src/mastra/schedule-ports.ts`: the record
 * shape is the source's exactly; the Mastra `MaintainInput`/`MaintainResult`/`NotifyDecision` types are replaced by
 * the fields the run actually reads.
 */

export const JOB_NAMES = ["uptime", "daily", "weekly", "weekly-reminder"] as const;
/** The LaunchAgent jobs: hourly reachability, the daily security sweep, the Monday cycle and the Monday reminder. */
export type JobName = (typeof JOB_NAMES)[number];

export const STAGE_STATUSES = ["ok", "failed", "refused", "not-wired", "skipped", "not-requested"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export type StageName = "lock" | "diagnose" | "maintain" | "report" | "notify-decision" | "digest" | "apply";

export interface SiteStage {
  stage: StageName;
  status: StageStatus;
  detail?: string;
}

export interface SiteOutcome {
  site: string;
  /**
   * ok: every stage ran or was not requested. refused: another run of this job holds the site.
   * skipped: the run was limited to other sites (`only`); no stage ran.
   */
  status: "ok" | "incomplete" | "refused" | "skipped";
  stages: SiteStage[];
  reportPath: string | null;
  /** Page coverage of the site audit, "sampled N of M" or "audited all M pages"; weekly only. */
  coverage?: string;
}

/** The persisted record of one job run: written when it starts and again when it ends. */
export interface RunRecord {
  job: JobName;
  startedAt: string;
  finishedAt: string | null;
  /** running: the first write; a record that stays running means the process died. */
  status: "running" | "complete" | "incomplete";
  sites: SiteOutcome[];
  /** Run-level facts: notifications sent, why a run is incomplete. */
  notes: string[];
}

export type Tier = "client" | "business" | "personal";
export const TIERS: readonly Tier[] = ["client", "business", "personal"];

/** One profile; `tier` is null and `problem` set when the profile could not be read. */
export interface SiteRef {
  name: string;
  tier: Tier | null;
  problem?: string;
}

/** The capabilities a scheduled diagnose measures. */
export type Capability = "uptime" | "security";

/** The `webmaster sites` command: every profile the scheduled jobs iterate. */
export interface SitesPort {
  list(): Promise<readonly SiteRef[]>;
}

/** One profiled diagnose of the named capabilities; the report is saved to history. */
export type DiagnoseCapabilities = (
  site: string,
  capabilities: readonly Capability[],
) => Promise<{ readonly savedPath: string }>;

/** What the weekly policy asks of the maintain step for one site. */
export interface MaintainInput {
  site: string;
  filing: boolean;
  fix: boolean;
  pageLimit: number;
}

/** The fields of a maintain run that the schedule reads. */
export interface MaintainResult {
  status: "complete" | "incomplete" | "refused";
  stoppedBecause: string | null;
  /** The page audit's own text: "sampled N of M" or "audited all M pages"; null when no audit ran. */
  auditCoverage: string | null;
}

export type MaintainSite = (input: MaintainInput) => Promise<MaintainResult>;

/** Saved report snapshots of a site (full paths, `<iso>.json`), from the history store. */
export interface SnapshotPort {
  list(site: string): Promise<readonly string[]>;
}

export type SilentReason = "healthy" | "no-new-critical" | "baseline" | "cooldown";

/** The fields of a notify decision that the schedule reads. */
export type NotifyDecision =
  | { readonly notify: false; readonly reason: string }
  | { readonly notify: true; readonly message: string };

/** The notify-decision step: reads the saved report at this path, or none when no report exists. */
export type NotifyDecisionStep = (site: string, reportPath: string | undefined) => Promise<NotifyDecision>;

export interface NotifierPort {
  send(message: string): Promise<void>;
}

export interface ReportStepInput {
  readonly site: string;
  readonly reportPath: string | undefined;
}

/** `not wired` is an answer, not a skip: the run it belongs to ends incomplete. */
export type StepOutcome =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "not wired" }
  | { readonly status: "failed"; readonly detail: string };

export type DigestPort = (input: ReportStepInput) => Promise<StepOutcome>;
export type ApplyPort = (input: ReportStepInput) => Promise<StepOutcome>;

export interface RunStatePort {
  save(record: RunRecord): Promise<void>;
}

/** Where the weekly reminder can point: the rendered report, when the digest workflow made one. */
export interface ReminderPort {
  readyReport(): Promise<string | undefined>;
}

export type SiteLock =
  | { readonly held: false; release(): Promise<void> }
  | { readonly held: true; readonly holder: string };

/** One run per site at a time. */
export interface SiteLockPort {
  acquire(site: string): Promise<SiteLock>;
}

export interface SchedulePorts {
  readonly sites: SitesPort;
  readonly diagnose: DiagnoseCapabilities;
  readonly maintain: MaintainSite;
  readonly snapshots: SnapshotPort;
  readonly notifyDecision: NotifyDecisionStep;
  readonly notifier: NotifierPort;
  readonly digest: DigestPort;
  readonly apply: ApplyPort;
  readonly reminder: ReminderPort;
  readonly state: RunStatePort;
  /** One lock per job and site (lock files `schedule-<job>-<site>.lock`). */
  readonly lockFor: (job: JobName) => SiteLockPort;
  readonly now: () => Date;
}
