import {
  DAILY_CAPABILITIES,
  freshSnapshot,
  reminderMessage,
  runStatus,
  siteStatus,
  stageOf,
  UPTIME_CAPABILITIES,
  weeklyPolicy,
} from "./decide";
import { normalizeOnly, selectOnly } from "./only";
import type {
  Capability,
  JobName,
  MaintainInput,
  MaintainResult,
  NotifyDecision,
  RunRecord,
  SchedulePorts,
  SiteOutcome,
  SiteRef,
  SiteStage,
  StageName,
} from "./types";

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const SITE_NAME = /^[a-z0-9-]+$/;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

function failed(stage: StageName, reason: string): SiteStage {
  return { stage, status: "failed", detail: reason };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The maintain request the weekly policy makes; invalid input is a failed maintain stage, as the source's parse was. */
export function maintainInputOf(input: MaintainInput): MaintainInput {
  if (!SITE_NAME.test(input.site)) throw new Error(`maintain input invalid: site ${JSON.stringify(input.site)} is not a profile name`);
  if (!Number.isInteger(input.pageLimit) || input.pageLimit < 1) throw new Error("maintain input invalid: pageLimit must be a positive integer");
  return { site: input.site, filing: input.filing, fix: input.fix, pageLimit: input.pageLimit };
}

/** Reads the fields the run needs from a maintain result; anything else is a failed maintain stage. */
export function readMaintainResult(raw: unknown): MaintainResult {
  if (!isObject(raw)) throw new Error("maintain result is not an object");
  const { status, stoppedBecause, auditCoverage } = raw;
  if (status !== "complete" && status !== "incomplete" && status !== "refused") {
    throw new Error(`maintain result has an unknown status ${JSON.stringify(status)}`);
  }
  if (stoppedBecause !== undefined && stoppedBecause !== null && typeof stoppedBecause !== "string") {
    throw new Error("maintain result stoppedBecause must be a string or null");
  }
  if (auditCoverage !== undefined && auditCoverage !== null && typeof auditCoverage !== "string") {
    throw new Error("maintain result auditCoverage must be a string or null");
  }
  return { status, stoppedBecause: stoppedBecause ?? null, auditCoverage: auditCoverage ?? null };
}

/** Reads the fields the run needs from a notify decision. */
export function readNotifyDecision(raw: unknown): NotifyDecision {
  if (!isObject(raw)) throw new Error("notify decision is not an object");
  if (raw["notify"] === false) {
    if (typeof raw["reason"] !== "string") throw new Error("silent notify decision has no reason");
    return { notify: false, reason: raw["reason"] };
  }
  if (raw["notify"] === true) {
    if (typeof raw["message"] !== "string" || raw["message"] === "") throw new Error("notify decision has no message");
    return { notify: true, message: raw["message"] };
  }
  throw new Error("notify decision must say notify true or false");
}

/** Decide whether to tell Zach, then tell him; one stage whatever happened. */
async function notifyStage(ports: SchedulePorts, site: string, reportPath: string | undefined): Promise<SiteStage> {
  const decision = await attempt(async () => readNotifyDecision(await ports.notifyDecision(site, reportPath)));
  if (!decision.ok) return failed("notify-decision", decision.reason);
  const verdict = decision.value;
  if (!verdict.notify) return { stage: "notify-decision", status: "ok", detail: `silent: ${verdict.reason}` };
  const sent = await attempt(() => ports.notifier.send(verdict.message));
  return sent.ok
    ? { stage: "notify-decision", status: "ok", detail: `notified: ${verdict.message}` }
    : failed("notify-decision", `decided to notify but sending failed: ${sent.reason}`);
}

/** Hourly reachability, or the daily security sweep: diagnose the job's capabilities, then notify. */
async function diagnoseStages(
  ports: SchedulePorts,
  site: SiteRef,
  capabilities: readonly Capability[],
): Promise<{ stages: SiteStage[]; reportPath: string | undefined }> {
  const diagnosed = await attempt(async () => {
    const done = await ports.diagnose(site.name, capabilities);
    if (typeof done?.savedPath !== "string" || done.savedPath === "") throw new Error("diagnose returned no savedPath");
    return done;
  });
  const reportPath = diagnosed.ok ? diagnosed.value.savedPath : undefined;
  const stages: SiteStage[] = [
    diagnosed.ok ? { stage: "diagnose", status: "ok", detail: diagnosed.value.savedPath } : failed("diagnose", diagnosed.reason),
    await notifyStage(ports, site.name, reportPath),
  ];
  return { stages, reportPath };
}

/** Monday: maintain per policy, find the saved report, notify decision, digest, optional apply. */
async function weeklyStages(
  ports: SchedulePorts,
  site: SiteRef,
  startedAt: Date,
): Promise<{ stages: SiteStage[]; reportPath: string | undefined; coverage?: string }> {
  if (site.tier === null) {
    return { stages: [failed("maintain", site.problem ?? "profile has no tier")], reportPath: undefined };
  }
  const policy = weeklyPolicy(site.tier);
  const stages: SiteStage[] = [];

  const maintained = await attempt(async () =>
    readMaintainResult(
      await ports.maintain(
        maintainInputOf({ site: site.name, filing: policy.filing, fix: policy.fix, pageLimit: policy.pageLimit }),
      ),
    )
  );
  if (!maintained.ok) stages.push(failed("maintain", maintained.reason));
  else if (maintained.value.status === "refused") {
    return {
      stages: [{
        stage: "maintain",
        status: "refused",
        detail: maintained.value.stoppedBecause ?? "another maintain run holds this site",
      }],
      reportPath: undefined,
    };
  } else if (maintained.value.status === "incomplete") {
    stages.push(failed("maintain", maintained.value.stoppedBecause ?? "maintain ended incomplete"));
  } else stages.push({ stage: "maintain", status: "ok" });

  const snapshots = await attempt(() => ports.snapshots.list(site.name));
  const reportPath = snapshots.ok ? freshSnapshot(snapshots.value, startedAt) : undefined;
  stages.push(
    reportPath !== undefined
      ? { stage: "report", status: "ok", detail: reportPath }
      : failed("report", snapshots.ok ? "this run saved no report" : snapshots.reason),
  );

  stages.push(await notifyStage(ports, site.name, reportPath));

  if (reportPath === undefined) {
    stages.push({ stage: "digest", status: "skipped", detail: "no saved report to render" });
  } else {
    const digest = await attempt(() => ports.digest({ site: site.name, reportPath }));
    stages.push(digest.ok ? stageOf("digest", digest.value) : failed("digest", digest.reason));
  }

  if (!policy.apply) stages.push({ stage: "apply", status: "not-requested" });
  else if (reportPath === undefined) {
    stages.push({ stage: "apply", status: "skipped", detail: "no saved report to apply from" });
  } else {
    const applied = await attempt(() => ports.apply({ site: site.name, reportPath }));
    stages.push(applied.ok ? stageOf("apply", applied.value) : failed("apply", applied.reason));
  }
  const coverage = maintained.ok ? maintained.value.auditCoverage : null;
  return { stages, reportPath, ...(coverage === null ? {} : { coverage }) };
}

/** One site under its own lock, so a run that overlaps a still-running one is refused, not doubled. */
async function runSite(
  job: Exclude<JobName, "weekly-reminder">,
  ports: SchedulePorts,
  site: SiteRef,
  startedAt: Date,
): Promise<SiteOutcome> {
  const lock = await attempt(() => ports.lockFor(job).acquire(site.name));
  if (!lock.ok) {
    return { site: site.name, status: "incomplete", stages: [failed("lock", lock.reason)], reportPath: null };
  }
  if (lock.value.held) {
    return {
      site: site.name,
      status: "refused",
      stages: [{ stage: "lock", status: "refused", detail: `another ${job} run holds ${lock.value.holder}` }],
      reportPath: null,
    };
  }
  const held = lock.value;
  let done: { stages: SiteStage[]; reportPath: string | undefined; coverage?: string | undefined };
  try {
    done = job === "weekly"
      ? await weeklyStages(ports, site, startedAt)
      : { ...(await diagnoseStages(ports, site, job === "daily" ? DAILY_CAPABILITIES : UPTIME_CAPABILITIES)) };
  } catch (error) {
    await attempt(() => held.release());
    throw error;
  }
  // A lock that cannot be released must not abort the run or hide the stages already recorded: it is a failed stage.
  const released = await attempt(() => held.release());
  const stages = released.ok ? done.stages : [...done.stages, failed("lock", `release failed: ${released.reason}`)];
  return {
    site: site.name,
    status: siteStatus(stages),
    stages,
    reportPath: done.reportPath ?? null,
    ...(done.coverage === undefined ? {} : { coverage: done.coverage }),
  };
}

async function reminderRun(ports: SchedulePorts): Promise<{ ok: boolean; notes: string[] }> {
  const ready = await attempt(() => ports.reminder.readyReport());
  const notes: string[] = [];
  if (!ready.ok) notes.push(`report lookup failed, reminder sent without a report link: ${ready.reason}`);
  const message = reminderMessage(ready.ok ? ready.value : undefined);
  const sent = await attempt(() => ports.notifier.send(message));
  notes.push(sent.ok ? `notified: ${message}` : `reminder not sent: ${sent.reason}`);
  return { ok: sent.ok, notes };
}

export interface RunJobOptions {
  /** Aborting stops before the next site; the record is saved `incomplete` with a note, then the abort is thrown. */
  signal?: AbortSignal;
}

/**
 * One scheduled job, start to finish. The run record is saved when it starts and when it ends, so a record still
 * `running` means the process died. A site that cannot be run, a port that is not wired and an overlapping run all
 * make the run `incomplete`; nothing is skipped silently.
 */
export async function runJob(
  job: JobName,
  ports: SchedulePorts,
  only?: readonly string[],
  options: RunJobOptions = {},
): Promise<RunRecord> {
  const wanted = only === undefined ? undefined : normalizeOnly(only);
  const { signal } = options;
  signal?.throwIfAborted();
  const startedAt = ports.now();
  const base = { job, startedAt: startedAt.toISOString() };
  await ports.state.save({ ...base, finishedAt: null, status: "running", sites: [], notes: [] });

  const notes: string[] = [];
  const sites: SiteOutcome[] = [];
  let stepOk = true;
  if (job === "weekly-reminder") {
    if (signal?.aborted !== true) {
      const sent = await reminderRun(ports);
      stepOk = sent.ok;
      notes.push(...sent.notes);
    }
    if (wanted !== undefined) notes.push("only has no effect on weekly-reminder");
  } else {
    const listed = await attempt(() => ports.sites.list());
    if (!listed.ok) notes.push(`could not list sites: ${listed.reason}`);
    else if (listed.value.length === 0) notes.push("no site profiles found");
    else {
      const { skipped, unknown } = selectOnly(listed.value, wanted);
      const notRun: string[] = [];
      for (const site of listed.value) {
        if (skipped.includes(site)) {
          sites.push({ site: site.name, status: "skipped", stages: [], reportPath: null });
        } else if (signal?.aborted === true) notRun.push(site.name);
        else sites.push(await runSite(job, ports, site, startedAt));
      }
      if (notRun.length > 0) {
        stepOk = false;
        notes.push(`aborted before these sites ran: ${notRun.join(", ")}`);
      }
      if (skipped.length > 0) notes.push(`skipped (not in only): ${skipped.map((site) => site.name).join(", ")}`);
      if (unknown.length > 0) {
        stepOk = false;
        notes.push(`only names no site profile: ${unknown.join(", ")}`);
      }
    }
  }
  if (signal?.aborted === true) {
    stepOk = false;
    notes.push("run aborted");
  }

  const finished: RunRecord = {
    ...base,
    finishedAt: ports.now().toISOString(),
    status: runStatus(job, sites, stepOk),
    sites,
    notes,
  };
  await ports.state.save(finished);
  signal?.throwIfAborted();
  return finished;
}
