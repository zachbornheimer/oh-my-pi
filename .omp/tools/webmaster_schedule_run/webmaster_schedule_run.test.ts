import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEEKLY_PAGE_LIMIT, freshSnapshot, runStatus, stageOf, weeklyPolicy } from "./decide";
import {
  BLOCKED,
  digestNotWired,
  directorySnapshots,
  fileRunState,
  livePorts,
  osascriptNotifier,
  profileSites,
  reportReminder,
  sitesDirectory,
  stateDirectory,
} from "./live";
import { type ExclusiveFiles, fileSiteLock, localExclusive, localProcess, lockHolderPid, memoryExclusive, type ProcessPort } from "./lock";
import { normalizeOnly, selectOnly } from "./only";
import { readMaintainResult, readNotifyDecision, runJob } from "./run";
import { DESCRIPTION, makeTool } from "./tool";
import type {
  ApplyPort,
  DigestPort,
  JobName,
  MaintainInput,
  MaintainResult,
  NotifyDecision,
  RunRecord,
  SchedulePorts,
  SiteRef,
} from "./types";
import { loadZod } from "./zod_for_tests";

const NOW = new Date("2026-10-19T07:00:00.000Z");
const STATE = "/state";
const FRESH = `${STATE}/zbm/2026-10-19T07-00-05.000Z.json`;
const STALE = `${STATE}/zbm/2026-10-12T07-00-05.000Z.json`;
const SILENT: NotifyDecision = { notify: false, reason: "healthy" };

// --- fakes ---------------------------------------------------------------------------------------

interface Calls {
  diagnose: Array<{ site: string; capabilities: readonly string[] }>;
  maintain: MaintainInput[];
  decided: Array<{ site: string; reportPath: string | undefined }>;
  sent: string[];
  digest: string[];
  apply: string[];
  saved: RunRecord[];
}

interface Overrides {
  sites?: readonly SiteRef[];
  sitesFail?: boolean;
  diagnoseFail?: readonly string[];
  maintain?: (input: MaintainInput) => Promise<MaintainResult>;
  snapshots?: Record<string, readonly string[]>;
  decision?: (site: string) => NotifyDecision;
  sendFails?: boolean;
  digest?: DigestPort;
  apply?: ApplyPort;
  locks?: ExclusiveFiles;
  readyReport?: string;
  readyFails?: boolean;
}

function maintainResult(status: MaintainResult["status"], why?: string, coverage: string | null = null): MaintainResult {
  return { status, stoppedBecause: why ?? null, auditCoverage: coverage };
}

function harness(over: Overrides = {}) {
  const calls: Calls = { diagnose: [], maintain: [], decided: [], sent: [], digest: [], apply: [], saved: [] };
  const exclusive = over.locks ?? memoryExclusive();
  const ports: SchedulePorts = {
    sites: {
      list: () =>
        over.sitesFail
          ? Promise.reject(new Error("sites dir unreadable"))
          : Promise.resolve(over.sites ?? [{ name: "zbm", tier: "personal" }]),
    },
    diagnose: (site, capabilities) => {
      calls.diagnose.push({ site, capabilities });
      return over.diagnoseFail?.includes(site)
        ? Promise.reject(new Error("probe crashed"))
        : Promise.resolve({ savedPath: `${STATE}/${site}/2026-10-19T07-00-01.000Z.json` });
    },
    maintain: (input) => {
      calls.maintain.push(input);
      return (over.maintain ?? (() => Promise.resolve(maintainResult("complete"))))(input);
    },
    snapshots: { list: (site) => Promise.resolve(over.snapshots?.[site] ?? [FRESH]) },
    notifyDecision: (site, reportPath) => {
      calls.decided.push({ site, reportPath });
      return Promise.resolve(over.decision?.(site) ?? SILENT);
    },
    notifier: {
      send: (message) => {
        calls.sent.push(message);
        return over.sendFails ? Promise.reject(new Error("osascript missing")) : Promise.resolve();
      },
    },
    digest: over.digest ?? ((input) => {
      calls.digest.push(input.site);
      return Promise.resolve({ status: "done", detail: "rendered" });
    }),
    apply: over.apply ?? ((input) => {
      calls.apply.push(input.site);
      return Promise.resolve({ status: "done", detail: "applied" });
    }),
    reminder: {
      readyReport: () => (over.readyFails ? Promise.reject(new Error("stat failed")) : Promise.resolve(over.readyReport)),
    },
    state: {
      save: (record) => {
        calls.saved.push(structuredClone(record));
        return Promise.resolve();
      },
    },
    lockFor: (job: JobName) => fileSiteLock(exclusive, STATE, `test ${job}`, `schedule-${job}`),
    now: () => NOW,
  };
  return { ports, calls, exclusive };
}

const TWO: SiteRef[] = [{ name: "zbm", tier: "personal" }, { name: "isjac", tier: "client" }];

// --- policy (decide.ts) ---------------------------------------------------------------------------

describe("policy", () => {
  it("defaults to a bounded weekly batch of 10 and fixes and files every tier, never applies", () => {
    expect(WEEKLY_PAGE_LIMIT).toBe(10);
    for (const tier of ["client", "business", "personal"] as const) {
      expect(weeklyPolicy(tier)).toEqual({ filing: true, fix: true, apply: false, pageLimit: 10 });
    }
  });

  it("freshSnapshot takes the newest report written at or after the start, never an older run's", () => {
    expect(freshSnapshot([STALE, FRESH], NOW)).toBe(FRESH);
    expect(freshSnapshot([STALE], NOW)).toBeUndefined();
    expect(freshSnapshot([`${STATE}/zbm/notes.txt`, STALE], NOW)).toBeUndefined();
    expect(freshSnapshot([`${STATE}/zbm/2026-10-19T07-00-00.000Z.json`], NOW)).toBe(`${STATE}/zbm/2026-10-19T07-00-00.000Z.json`);
    expect(freshSnapshot([], NOW)).toBeUndefined();
  });

  it("stageOf never calls a not-wired port ok", () => {
    expect(stageOf("digest", { status: "not wired" })).toEqual({
      stage: "digest",
      status: "not-wired",
      detail: "port not wired; run is incomplete",
    });
    expect(stageOf("digest", { status: "done", detail: "x" }).status).toBe("ok");
    expect(stageOf("apply", { status: "failed", detail: "y" })).toEqual({ stage: "apply", status: "failed", detail: "y" });
  });

  it("runStatus: a run that ran no site is not complete; skipped sites do not make it incomplete", () => {
    expect(runStatus("uptime", [], true)).toBe("incomplete");
    expect(runStatus("uptime", [{ status: "skipped" }], true)).toBe("incomplete");
    expect(runStatus("uptime", [{ status: "ok" }, { status: "skipped" }], true)).toBe("complete");
    expect(runStatus("uptime", [{ status: "ok" }], false)).toBe("incomplete");
    expect(runStatus("weekly-reminder", [], true)).toBe("complete");
    expect(runStatus("weekly-reminder", [], false)).toBe("incomplete");
  });
});

// --- only -------------------------------------------------------------------------------------

describe("only", () => {
  const SITES: SiteRef[] = [{ name: "alpha", tier: "client" }, { name: "beta", tier: "client" }, { name: "gamma", tier: "client" }];

  it("selectOnly: every site when absent; named, skipped and unknown in profile order; case-sensitive", () => {
    expect(selectOnly(SITES, undefined)).toEqual({ selected: SITES, skipped: [], unknown: [] });
    const split = selectOnly(SITES, ["gamma", "nope", "alpha", "nope"]);
    expect(split.selected.map((s) => s.name)).toEqual(["alpha", "gamma"]);
    expect(split.skipped.map((s) => s.name)).toEqual(["beta"]);
    expect(split.unknown).toEqual(["nope"]);
    expect(selectOnly(SITES, ["Alpha"]).unknown).toEqual(["Alpha"]);
  });

  it("normalizeOnly refuses an empty list or a blank name, and trims and dedupes", () => {
    expect(() => normalizeOnly([])).toThrow("at least one");
    for (const bad of [[""], ["  "], ["a", ""], ["a", " \t"]]) expect(() => normalizeOnly(bad)).toThrow("blank");
    expect(() => normalizeOnly([1 as unknown as string])).toThrow("strings");
    expect(normalizeOnly([" bpp ", "bpp", "zbm"])).toEqual(["bpp", "zbm"]);
  });

  it("runs named sites, records the rest as skipped, and completes", async () => {
    const { ports, calls } = harness({ sites: SITES });
    const record = await runJob("uptime", ports, ["beta"]);
    expect(calls.diagnose.map((c) => c.site)).toEqual(["beta"]);
    expect(record.sites.map((s) => [s.site, s.status])).toEqual([["alpha", "skipped"], ["beta", "ok"], ["gamma", "skipped"]]);
    expect(record.notes).toContain("skipped (not in only): alpha, gamma");
    expect(record.status).toBe("complete");
    expect(calls.saved.at(-1)).toEqual(record);
  });

  it("FIXED: a name with stray whitespace selects its site (the source validated it trimmed, then matched it raw)", async () => {
    const { ports, calls } = harness({ sites: SITES });
    const record = await runJob("uptime", ports, [" beta "]);
    expect(calls.diagnose.map((c) => c.site)).toEqual(["beta"]);
    expect(record.status).toBe("complete");
  });

  it("without only, every site runs and nothing is skipped", async () => {
    const { ports, calls } = harness({ sites: SITES });
    const record = await runJob("uptime", ports);
    expect(calls.diagnose.map((c) => c.site)).toEqual(["alpha", "beta", "gamma"]);
    expect(record.sites.every((s) => s.status === "ok")).toBe(true);
  });

  it("an unknown name makes the run incomplete with a note, though named sites ran", async () => {
    const { ports, calls } = harness({ sites: SITES });
    const record = await runJob("uptime", ports, ["alpha", "typo"]);
    expect(calls.diagnose.map((c) => c.site)).toEqual(["alpha"]);
    expect(record.status).toBe("incomplete");
    expect(record.notes).toContain("only names no site profile: typo");
  });

  it("only unknown names: nothing runs, every site is skipped, incomplete", async () => {
    const { ports, calls } = harness({ sites: SITES });
    const record = await runJob("uptime", ports, ["typo"]);
    expect(calls.diagnose).toEqual([]);
    expect(record.sites.map((s) => s.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(record.status).toBe("incomplete");
  });

  it("rejects an empty array before saving any record or touching a site", async () => {
    const { ports, calls } = harness({ sites: SITES });
    await expect(runJob("uptime", ports, [])).rejects.toThrow();
    expect(calls.diagnose).toEqual([]);
    expect(calls.saved).toEqual([]);
  });

  it("says so when only is given to the reminder, which has no sites", async () => {
    const { ports } = harness();
    const record = await runJob("weekly-reminder", ports, ["alpha"]);
    expect(record.notes).toContain("only has no effect on weekly-reminder");
  });
});

// --- daily and uptime ---------------------------------------------------------------------------

describe("daily job", () => {
  it("diagnoses [security, uptime] for every site, never maintains, and decides whether to notify", async () => {
    const { ports, calls } = harness({ sites: TWO });
    const record = await runJob("daily", ports);
    expect(calls.diagnose).toEqual([
      { site: "zbm", capabilities: ["security", "uptime"] },
      { site: "isjac", capabilities: ["security", "uptime"] },
    ]);
    expect(calls.maintain).toEqual([]);
    expect(record.job).toBe("daily");
    expect(record.status).toBe("complete");
    expect(calls.decided.map((one) => one.site)).toEqual(["zbm", "isjac"]);
  });

  it("keeps a site whose probe failed as incomplete, not silent", async () => {
    const { ports } = harness({ sites: TWO, diagnoseFail: ["isjac"] });
    const record = await runJob("daily", ports);
    expect(record.status).toBe("incomplete");
    expect(record.sites.map((site) => [site.site, site.status])).toEqual([["zbm", "ok"], ["isjac", "incomplete"]]);
  });
});

describe("uptime job", () => {
  it("diagnoses only [uptime] for every site and stays quiet when nothing is new", async () => {
    const { ports, calls } = harness({ sites: TWO });
    const record = await runJob("uptime", ports);
    expect(calls.diagnose).toEqual([
      { site: "zbm", capabilities: ["uptime"] },
      { site: "isjac", capabilities: ["uptime"] },
    ]);
    expect(calls.maintain).toEqual([]);
    expect(calls.sent).toEqual([]);
    expect(record.status).toBe("complete");
    expect(calls.decided[0]?.reportPath).toBe(`${STATE}/zbm/2026-10-19T07-00-01.000Z.json`);
    expect(record.sites[0]?.reportPath).toBe(`${STATE}/zbm/2026-10-19T07-00-01.000Z.json`);
  });

  it("sends the notification the decision asks for", async () => {
    const { ports, calls } = harness({ decision: () => ({ notify: true, message: "zbm: 1 new critical finding" }) });
    const record = await runJob("uptime", ports);
    expect(calls.sent).toEqual(["zbm: 1 new critical finding"]);
    expect(record.sites[0]?.stages.at(-1)?.detail).toContain("notified");
  });

  it("a failed probe still reaches the decision (no report) and the run is incomplete", async () => {
    const { ports, calls } = harness({ sites: TWO, diagnoseFail: ["zbm"] });
    const record = await runJob("uptime", ports);
    expect(calls.decided[0]).toEqual({ site: "zbm", reportPath: undefined });
    expect(calls.diagnose.map((c) => c.site)).toEqual(["zbm", "isjac"]);
    expect(record.status).toBe("incomplete");
    expect(record.sites.map((s) => s.status)).toEqual(["incomplete", "ok"]);
  });

  it("a notification that cannot be sent is a failed stage, not a silent success", async () => {
    const { ports } = harness({ decision: () => ({ notify: true, message: "m" }), sendFails: true });
    const record = await runJob("uptime", ports);
    expect(record.status).toBe("incomplete");
    expect(record.sites[0]?.stages.at(-1)?.detail).toContain("osascript missing");
  });

  it("a malformed decision or diagnose answer is a failed stage", async () => {
    const { ports } = harness();
    const bad = await runJob("uptime", {
      ...ports,
      notifyDecision: () => Promise.resolve({ notify: "yes" } as unknown as NotifyDecision),
      diagnose: () => Promise.resolve({} as unknown as { savedPath: string }),
    });
    expect(bad.status).toBe("incomplete");
    expect(bad.sites[0]?.stages.map((s) => s.status)).toEqual(["failed", "failed"]);
  });

  it("no profiles, or an unlistable sites directory, is incomplete with the reason", async () => {
    const none = await runJob("uptime", harness({ sites: [] }).ports);
    expect([none.status, none.notes]).toEqual(["incomplete", ["no site profiles found"]]);
    const broken = await runJob("uptime", harness({ sitesFail: true }).ports);
    expect([broken.status, broken.notes[0]]).toEqual(["incomplete", "could not list sites: sites dir unreadable"]);
  });
});

// --- weekly -------------------------------------------------------------------------------------

describe("weekly job", () => {
  it("files and fixes for every tier, with a bounded page limit", async () => {
    const { ports, calls } = harness({
      sites: [{ name: "zbm", tier: "personal" }, { name: "isjac", tier: "client" }, { name: "zysys", tier: "business" }],
      snapshots: {
        zbm: [FRESH],
        isjac: [`${STATE}/isjac/2026-10-19T07-01-00.000Z.json`],
        zysys: [`${STATE}/zysys/2026-10-19T07-02-00.000Z.json`],
      },
    });
    await runJob("weekly", ports);
    expect(calls.maintain).toEqual([
      { site: "zbm", filing: true, fix: true, pageLimit: 10 },
      { site: "isjac", filing: true, fix: true, pageLimit: 10 },
      { site: "zysys", filing: true, fix: true, pageLimit: 10 },
    ]);
  });

  it("reads the saved report for the notify decision and passes it to the digest", async () => {
    const { ports, calls } = harness({ snapshots: { zbm: [STALE, FRESH] } });
    const record = await runJob("weekly", ports);
    expect(calls.decided).toEqual([{ site: "zbm", reportPath: FRESH }]);
    expect(calls.digest).toEqual(["zbm"]);
    expect(calls.apply).toEqual([]);
    expect(record.status).toBe("complete");
    expect(record.sites[0]?.stages.map((s) => [s.stage, s.status])).toEqual([
      ["maintain", "ok"],
      ["report", "ok"],
      ["notify-decision", "ok"],
      ["digest", "ok"],
      ["apply", "not-requested"],
    ]);
  });

  it("never feeds a report from an older run into the decision", async () => {
    const { ports, calls } = harness({ snapshots: { zbm: [STALE] } });
    const record = await runJob("weekly", ports);
    expect(calls.decided).toEqual([{ site: "zbm", reportPath: undefined }]);
    expect(calls.digest).toEqual([]);
    expect(record.status).toBe("incomplete");
    expect(record.sites[0]?.stages.find((s) => s.stage === "digest")?.status).toBe("skipped");
  });

  it("a digest port that is not wired makes the run INCOMPLETE and says so", async () => {
    const { ports } = harness({ digest: digestNotWired });
    const record = await runJob("weekly", ports);
    expect(record.status).toBe("incomplete");
    const digest = record.sites[0]?.stages.find((s) => s.stage === "digest");
    expect(digest).toMatchObject({ status: "not-wired" });
    expect(digest?.detail).toContain("incomplete");
  });

  it("a digest that throws or fails is a failed stage", async () => {
    const thrown = await runJob("weekly", harness({ digest: () => Promise.reject(new Error("render crashed")) }).ports);
    expect(thrown.sites[0]?.stages.find((s) => s.stage === "digest")).toMatchObject({ status: "failed", detail: "render crashed" });
    const failed = await runJob("weekly", harness({ digest: () => Promise.resolve({ status: "failed", detail: "no template" }) }).ports);
    expect(failed.status).toBe("incomplete");
  });

  it("a maintain run that ended incomplete or threw is a failed stage, and the rest still runs", async () => {
    const incomplete = harness({ maintain: () => Promise.resolve(maintainResult("incomplete", "audit failed")) });
    const record = await runJob("weekly", incomplete.ports);
    expect(record.sites[0]?.stages[0]).toMatchObject({ stage: "maintain", status: "failed", detail: "audit failed" });
    expect(incomplete.calls.decided).toHaveLength(1);

    const thrown = await runJob("weekly", harness({ maintain: () => Promise.reject(new Error("workflow siteMaintain ended failed")) }).ports);
    expect(thrown.status).toBe("incomplete");
  });

  it("a maintain result with an unknown status is a failed stage", async () => {
    const { ports } = harness({ maintain: () => Promise.resolve({ status: "weird" } as unknown as MaintainResult) });
    const record = await runJob("weekly", ports);
    expect(record.sites[0]?.stages[0]).toMatchObject({ stage: "maintain", status: "failed" });
    expect(record.sites[0]?.stages[0]?.detail).toContain("unknown status");
  });

  it("a maintain run refused by its own lock refuses the site and stops", async () => {
    const { ports, calls } = harness({ maintain: () => Promise.resolve(maintainResult("refused", "another maintain run holds the lock")) });
    const record = await runJob("weekly", ports);
    expect(record.sites[0]?.status).toBe("refused");
    expect(calls.decided).toEqual([]);
    expect(record.status).toBe("incomplete");
  });

  it("a profile that could not be read is not maintained", async () => {
    const { ports, calls } = harness({ sites: [{ name: "broken", tier: null, problem: "profile unreadable: bad yaml" }] });
    const record = await runJob("weekly", ports);
    expect(calls.maintain).toEqual([]);
    expect(record.sites[0]?.stages[0]?.detail).toBe("profile unreadable: bad yaml");
    expect(record.status).toBe("incomplete");
  });

  it("puts the sampled N of M text on the site outcome and the saved record", async () => {
    const { ports, calls } = harness({ maintain: () => Promise.resolve(maintainResult("complete", undefined, "sampled 10 of 435")) });
    const record = await runJob("weekly", ports, ["zbm"]);
    expect(record.sites[0]?.coverage).toBe("sampled 10 of 435");
    expect(calls.saved.at(-1)?.sites[0]?.coverage).toBe("sampled 10 of 435");
    expect(record.status).toBe("complete");
  });

  it("omits coverage when maintain ran no audit, and when maintain threw; keeps it when maintain ended incomplete", async () => {
    expect((await runJob("weekly", harness().ports)).sites[0]).not.toHaveProperty("coverage");
    const threw = await runJob("weekly", harness({ maintain: () => { throw new Error("audit crashed"); } }).ports);
    expect(threw.sites[0]).not.toHaveProperty("coverage");
    expect(threw.status).toBe("incomplete");
    const partial = await runJob("weekly", harness({ maintain: () => Promise.resolve(maintainResult("incomplete", "filing blocked", "sampled 10 of 435")) }).ports);
    expect(partial.sites[0]?.status).toBe("incomplete");
    expect(partial.sites[0]?.coverage).toBe("sampled 10 of 435");
  });

  it("the apply port is not called by the default policy", async () => {
    const { ports, calls } = harness({ apply: () => Promise.reject(new Error("must not run")) });
    expect((await runJob("weekly", ports)).status).toBe("complete");
    expect(calls.apply).toEqual([]);
  });
});

// --- overlap, lock and run state ------------------------------------------------------------------

describe("overlap and run state", () => {
  it("refuses a site whose lock for this job is held, and runs the others", async () => {
    const locks = memoryExclusive();
    await locks.create(`${STATE}/schedule-weekly-zbm.lock`, "other run");
    const { ports, calls } = harness({ locks, sites: TWO });
    const record = await runJob("weekly", ports);
    expect(calls.maintain.map((i) => i.site)).toEqual(["isjac"]);
    expect(record.sites.map((s) => [s.site, s.status])).toEqual([["zbm", "refused"], ["isjac", "ok"]]);
    expect(record.sites[0]?.stages[0]?.detail).toContain("schedule-weekly-zbm.lock");
    expect(record.status).toBe("incomplete");
  });

  it("holds the lock while a site runs and releases it after, even on failure", async () => {
    const locks = memoryExclusive();
    const { ports } = harness({ locks, maintain: () => Promise.reject(new Error("boom")) });
    await runJob("weekly", ports);
    expect(await locks.create(`${STATE}/schedule-weekly-zbm.lock`, "x")).toBe(true);
  });

  it("a second overlapping run of the same job is refused while the first is in flight", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const locks = memoryExclusive();
    const first = harness({ locks, maintain: async () => (entered.resolve(), await gate.promise, maintainResult("complete")) });
    const running = runJob("weekly", first.ports);
    await entered.promise;
    const second = harness({ locks });
    const refused = await runJob("weekly", second.ports);
    expect(refused.sites[0]?.status).toBe("refused");
    expect(second.calls.maintain).toEqual([]);
    gate.resolve();
    expect((await running).status).toBe("complete");
  });

  it("jobs lock separately: an hourly run is not blocked by a Monday run", async () => {
    const locks = memoryExclusive();
    await locks.create(`${STATE}/schedule-weekly-zbm.lock`, "monday");
    expect((await runJob("uptime", harness({ locks }).ports)).status).toBe("complete");
  });

  it("saves a running record first and the finished record last", async () => {
    const { ports, calls } = harness();
    const finished = await runJob("uptime", ports);
    expect(calls.saved.map((r) => r.status)).toEqual(["running", "complete"]);
    expect(calls.saved[0]).toMatchObject({ finishedAt: null, startedAt: NOW.toISOString() });
    expect(calls.saved[1]).toEqual(finished);
  });

  it("a lock that cannot be acquired is an incomplete site with a failed lock stage", async () => {
    const { ports } = harness();
    const record = await runJob("uptime", { ...ports, lockFor: () => ({ acquire: () => Promise.reject(new Error("disk full")) }) });
    expect(record.sites[0]).toMatchObject({ status: "incomplete", stages: [{ stage: "lock", status: "failed", detail: "disk full" }] });
  });

  it("FIXED: a lock that cannot be released is a failed lock stage, not a crash that leaves the record running", async () => {
    const { ports, calls } = harness({ sites: TWO });
    const record = await runJob("uptime", {
      ...ports,
      lockFor: () => ({ acquire: () => Promise.resolve({ held: false, release: () => Promise.reject(new Error("EPERM unlink")) }) }),
    });
    expect(record.status).toBe("incomplete");
    expect(record.sites.map((s) => s.status)).toEqual(["incomplete", "incomplete"]);
    expect(record.sites[0]?.stages.at(-1)).toEqual({ stage: "lock", status: "failed", detail: "release failed: EPERM unlink" });
    expect(record.sites[0]?.stages.slice(0, 2).map((s) => s.status)).toEqual(["ok", "ok"]);
    expect(calls.saved.map((r) => r.status)).toEqual(["running", "incomplete"]);
  });
});

describe("stale lock reclaim", () => {
  const processes = (pid: number, alive: readonly number[]): ProcessPort => ({ pid, isAlive: (candidate) => alive.includes(candidate) });
  const PATH = "/state/maintain-zbm.lock";

  it("records the holder pid in the lock file", async () => {
    const files = memoryExclusive();
    await fileSiteLock(files, "/state", "webmaster", "maintain", processes(4242, [])).acquire("zbm");
    expect(lockHolderPid((await files.read(PATH)) ?? "")).toBe(4242);
  });

  it("reclaims a lock whose pid is dead, and releases cleanly afterwards", async () => {
    const files = memoryExclusive();
    await fileSiteLock(files, "/state", "webmaster", "maintain", processes(111, [])).acquire("zbm");
    const got = await fileSiteLock(files, "/state", "webmaster", "maintain", processes(222, [222])).acquire("zbm");
    expect(got.held).toBe(false);
    expect(lockHolderPid((await files.read(PATH)) ?? "")).toBe(222);
    if (!got.held) await got.release();
    expect(await files.read(PATH)).toBeUndefined();
  });

  it("refuses a lock whose pid is still alive", async () => {
    const files = memoryExclusive();
    await fileSiteLock(files, "/state", "webmaster", "maintain", processes(111, [])).acquire("zbm");
    const next = fileSiteLock(files, "/state", "webmaster", "maintain", processes(222, [111, 222]));
    expect(await next.acquire("zbm")).toEqual({ held: true, holder: PATH });
    expect(lockHolderPid((await files.read(PATH)) ?? "")).toBe(111);
  });

  it("refuses a lock with no recorded pid or a garbled pid line (cannot prove it stale)", async () => {
    const files = memoryExclusive();
    await files.create(PATH, "webmaster\n");
    const lock = fileSiteLock(files, "/state", "webmaster", "maintain", processes(222, []));
    expect(await lock.acquire("zbm")).toEqual({ held: true, holder: PATH });
    expect(await files.read(PATH)).toBe("webmaster\n");
    const garbled = memoryExclusive();
    await garbled.create(PATH, "webmaster\npid=abc\n");
    expect((await fileSiteLock(garbled, "/state", "webmaster", "maintain", processes(222, [])).acquire("zbm")).held).toBe(true);
  });

  it("does not reclaim without a process port", async () => {
    const files = memoryExclusive();
    await files.create(PATH, "webmaster\npid=111\n");
    expect((await fileSiteLock(files, "/state", "webmaster", "maintain").acquire("zbm")).held).toBe(true);
  });

  it("does not take over a lock another run re-created between the check and the removal", async () => {
    const memory = memoryExclusive();
    await memory.create(PATH, "webmaster\npid=111\n");
    let reads = 0;
    const racing = {
      ...memory,
      read: async (path: string) => {
        reads += 1;
        if (reads === 2) {
          await memory.remove(path);
          await memory.create(path, "webmaster\npid=333\n");
        }
        return memory.read(path);
      },
    };
    const lock = fileSiteLock(racing, "/state", "webmaster", "maintain", processes(222, [222, 333]));
    expect((await lock.acquire("zbm")).held).toBe(true);
    expect(lockHolderPid((await memory.read(PATH)) ?? "")).toBe(333);
  });

  it("two simultaneous acquirers of a dead lock: exactly one wins", async () => {
    const files = memoryExclusive();
    await files.create(PATH, "webmaster\npid=111\n");
    const alive = [222, 333];
    const a = fileSiteLock(files, "/state", "webmaster", "maintain", processes(222, alive));
    const b = fileSiteLock(files, "/state", "webmaster", "maintain", processes(333, alive));
    const [first, second] = await Promise.all([a.acquire("zbm"), b.acquire("zbm")]);
    expect([first.held, second.held].filter((held) => !held)).toHaveLength(1);
  });

  it("FIXED: refuses a site name that would name a path outside the lock directory", async () => {
    const lock = fileSiteLock(memoryExclusive(), "/state", "h", "schedule-uptime");
    for (const bad of ["../x", "a/b", "", ".hidden", "a b"]) await expect(lock.acquire(bad)).rejects.toThrow("not a plain site name");
  });
});

// --- real files ---------------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-run-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("exclusive file locks on disk", () => {
  it("creates with wx, refuses a live pid, reclaims a dead pid, and release is idempotent", async () => {
    const path = join(dir, "schedule", "schedule-uptime-zbm.lock");
    expect(await localExclusive.create(path, "a\n")).toBe(true);
    expect(await localExclusive.create(path, "b\n")).toBe(false);
    expect(await localExclusive.read(path)).toBe("a\n");
    await localExclusive.remove(path);
    await localExclusive.remove(path);
    expect(await localExclusive.read(path)).toBeUndefined();

    const lockFile = join(dir, "schedule", "schedule-uptime-zbm.lock");
    const dead = 2_147_483_000; // far above any real pid
    expect(localProcess.isAlive(dead)).toBe(false);
    expect(localProcess.isAlive(process.pid)).toBe(true);
    writeFileSync(lockFile, `old\npid=${dead}\n`);
    const lock = fileSiteLock(localExclusive, join(dir, "schedule"), "t", "schedule-uptime", localProcess);
    const got = await lock.acquire("zbm");
    expect(got.held).toBe(false);
    expect(lockHolderPid(readFileSync(lockFile, "utf8"))).toBe(process.pid);
    expect((await lock.acquire("zbm")).held).toBe(true);
    if (!got.held) await got.release();
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe("live ports", () => {
  it("directories: env first, then the documented defaults", () => {
    expect(sitesDirectory({ WEBMASTER_SITES_DIR: "/s" }, "/h")).toBe("/s");
    expect(sitesDirectory({}, "/h")).toBe("/h/Developer/Zysys/webmaster/sites");
    expect(stateDirectory({ WEBMASTER_STATE_DIR: "/st" }, "/h")).toBe("/st");
    expect(stateDirectory({ XDG_STATE_HOME: "/x" }, "/h")).toBe("/x/webmaster");
    expect(stateDirectory({}, "/h")).toBe("/h/.local/state/webmaster");
  });

  it("sites: names and tiers sorted; an unreadable profile lists with tier null and the problem; a missing directory lists none", async () => {
    writeFileSync(join(dir, "zbm.yaml"), "name: zbm\ntier: personal\nurl: https://zbm.example\n");
    writeFileSync(join(dir, "isjac.yaml"), "name: isjac\ntier: client\n");
    writeFileSync(join(dir, "bad.yaml"), "not: a profile\n");
    writeFileSync(join(dir, "worse.yaml"), "tier: [unclosed\n");
    writeFileSync(join(dir, "Upper.yaml"), "tier: client\n");
    writeFileSync(join(dir, "notes.txt"), "tier: client\n");
    const listed = await profileSites(dir).list();
    expect(listed.map((s) => [s.name, s.tier])).toEqual([["bad", null], ["isjac", "client"], ["worse", null], ["zbm", "personal"]]);
    expect(listed[0]?.problem).toContain("profile unreadable");
    expect(listed[2]?.problem).toContain("profile unreadable");
    expect(await profileSites(join(dir, "nope")).list()).toEqual([]);
  });

  it("snapshots: lists <state>/<site>/*.json as full paths; none for a site without a directory; refuses a path-like site", async () => {
    mkdirSync(join(dir, "zbm"));
    writeFileSync(join(dir, "zbm", "2026-10-19T07-00-05.000Z.json"), "{}");
    writeFileSync(join(dir, "zbm", "readme.txt"), "");
    expect(await directorySnapshots(dir).list("zbm")).toEqual([join(dir, "zbm", "2026-10-19T07-00-05.000Z.json")]);
    expect(await directorySnapshots(dir).list("other")).toEqual([]);
    await expect(directorySnapshots(dir).list("../zbm")).rejects.toThrow("not a profile name");
  });

  it("reminder: points at <state>/reports/isjac.html only when it exists", async () => {
    const port = reportReminder(dir);
    expect(await port.readyReport()).toBeUndefined();
    mkdirSync(join(dir, "reports"));
    writeFileSync(join(dir, "reports", "isjac.html"), "<html></html>");
    expect(await port.readyReport()).toBe(join(dir, "reports", "isjac.html"));
  });

  it("state: replaces <job>.last.json at every save and appends only finished runs to <job>.runs.jsonl", async () => {
    const state = fileRunState(dir);
    const running: RunRecord = { job: "weekly", startedAt: NOW.toISOString(), finishedAt: null, status: "running", sites: [], notes: [] };
    await state.save(running);
    const last = join(dir, "schedule", "weekly.last.json");
    expect(JSON.parse(readFileSync(last, "utf8"))).toEqual(running);
    expect(existsSync(join(dir, "schedule", "weekly.runs.jsonl"))).toBe(false);
    const done: RunRecord = { ...running, finishedAt: NOW.toISOString(), status: "complete" };
    await state.save(done);
    await state.save({ ...done, notes: ["again"] });
    expect(JSON.parse(readFileSync(last, "utf8")).notes).toEqual(["again"]);
    const lines = readFileSync(join(dir, "schedule", "weekly.runs.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).notes)).toEqual([[], ["again"]]);
    expect(readdirNames(join(dir, "schedule")).sort()).toEqual(["weekly.last.json", "weekly.runs.jsonl"]);
  });
});

function readdirNames(path: string): string[] {
  return [...new Bun.Glob("*").scanSync({ cwd: path, dot: true })];
}

describe("notifier", () => {
  it("runs osascript with an argument array and passes the message as an argument, never inside the script text", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const notifier = osascriptNotifier(async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    }, "darwin");
    await notifier.send('say "hi" & `rm -rf /`');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("osascript");
    expect(calls[0]?.args.at(-1)).toBe('say "hi" & `rm -rf /`');
    expect(calls[0]?.args.slice(0, -1).join(" ")).not.toContain("rm -rf");
  });

  it("rejects a non-darwin platform explicitly, and a failing osascript", async () => {
    const never = async () => {
      throw new Error("must not run");
    };
    await expect(osascriptNotifier(never, "linux").send("m")).rejects.toThrow("only supported on macOS");
    const failing = osascriptNotifier(async () => ({ stdout: "", stderr: "not authorized", code: 1, killed: false }), "darwin");
    await expect(failing.send("m")).rejects.toThrow("osascript exited 1: not authorized");
  });
});

// --- the tool ------------------------------------------------------------------------------------

const zod = (await loadZod()) as never;
const unusedExec = async () => {
  throw new Error("exec must not run");
};
const piWith = (exec: unknown = unusedExec) => ({ zod, exec }) as never;

function osascriptSpy() {
  const sent: string[] = [];
  const exec = async (_command: string, args: string[]) => {
    sent.push(args.at(-1) ?? "");
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  return { sent, exec };
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

describe("tool", () => {
  it("has the name, a 80-250 word description and no read approval (it writes records and notifies)", () => {
    const tool = makeTool(piWith());
    expect(tool.name).toBe("webmaster_schedule_run");
    expect(tool).not.toHaveProperty("approval");
    const words = DESCRIPTION.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("BLOCKED");
  });

  it("validates its parameters with omp's zod: valid, null only, invalid job, empty only", () => {
    const { parameters } = makeTool(piWith());
    expect(parameters.safeParse({ job: "uptime" }).success).toBe(true);
    expect(parameters.safeParse({ job: "weekly", only: ["bpp"] }).success).toBe(true);
    expect(parameters.safeParse({ job: "daily", only: null }).success).toBe(true);
    expect(parameters.safeParse({ job: "yearly" }).success).toBe(false);
    expect(parameters.safeParse({ job: "uptime", only: [] }).success).toBe(false);
    expect(parameters.safeParse({ job: "uptime", only: [""] }).success).toBe(false);
    expect(parameters.safeParse({}).success).toBe(false);
  });

  it("execute throws on invalid input before running anything, including a blank name zod's schema lets through", async () => {
    const { ports, calls } = harness();
    const tool = makeTool(piWith(), { ports });
    await expect(tool.execute("id", { job: "yearly" } as never, undefined, undefined)).rejects.toThrow("invalid input");
    await expect(tool.execute("id", { job: "uptime", only: [] }, undefined, undefined)).rejects.toThrow("invalid input");
    await expect(tool.execute("id", { job: "uptime", only: ["  "] }, undefined, undefined)).rejects.toThrow("blank");
    expect(calls.saved).toEqual([]);
  });

  it("returns the record as JSON plus a summary line, details equal to the record", async () => {
    const { ports, calls } = harness({ sites: TWO });
    const tool = makeTool(piWith(), { ports });
    const result = await tool.execute("id", { job: "uptime", only: ["zbm"] }, undefined, undefined);
    const record = JSON.parse(textOf(result).slice(0, textOf(result).lastIndexOf("\n"))) as RunRecord;
    expect(record).toEqual(result.details);
    expect(record).toEqual(calls.saved.at(-1) as RunRecord);
    expect(record.sites.map((s) => [s.site, s.status])).toEqual([["zbm", "ok"], ["isjac", "skipped"]]);
    expect(textOf(result).split("\n").at(-1)).toBe("uptime: complete; 1 site(s) run, 0 not ok, 1 skipped.");
  });

  it("with live ports, weekly-reminder runs fully: one macOS notification, state files in the state directory", async () => {
    const { sent, exec } = osascriptSpy();
    const tool = makeTool(piWith(exec), { env: { WEBMASTER_STATE_DIR: dir, WEBMASTER_SITES_DIR: join(dir, "sites") }, platform: "darwin" });
    const result = await tool.execute("id", { job: "weekly-reminder" }, undefined, undefined);
    expect(result.details).toMatchObject({ job: "weekly-reminder", status: "complete", sites: [] });
    expect(sent).toEqual(["Weekly webmaster: say 'Please run /webmaster isjac'"]);
    expect(JSON.parse(readFileSync(join(dir, "schedule", "weekly-reminder.last.json"), "utf8")).status).toBe("complete");
    expect(readFileSync(join(dir, "schedule", "weekly-reminder.runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    mkdirSync(join(dir, "reports"));
    writeFileSync(join(dir, "reports", "isjac.html"), "x");
    await tool.execute("id", { job: "weekly-reminder" }, undefined, undefined);
    expect(sent[1]).toBe(`Weekly webmaster: say 'Please run /webmaster isjac' (report ready: ${join(dir, "reports", "isjac.html")})`);
  });

  it("with live ports on another platform, weekly-reminder is incomplete with the explicit error", async () => {
    const tool = makeTool(piWith(), { env: { WEBMASTER_STATE_DIR: dir }, platform: "linux" });
    const result = await tool.execute("id", { job: "weekly-reminder" }, undefined, undefined);
    expect(result.details.status).toBe("incomplete");
    expect(result.details.notes[0]).toContain("only supported on macOS");
  });

  it("with live ports, uptime/daily end incomplete: diagnose and notify-decision are BLOCKED, and nothing is sent", async () => {
    writeFileSync(join(dir, "zbm.yaml"), "tier: personal\n");
    const { sent, exec } = osascriptSpy();
    const tool = makeTool(piWith(exec), { env: { WEBMASTER_STATE_DIR: join(dir, "state"), WEBMASTER_SITES_DIR: dir }, platform: "darwin" });
    for (const job of ["uptime", "daily"] as const) {
      const record = (await tool.execute("id", { job }, undefined, undefined)).details;
      expect(record.status).toBe("incomplete");
      expect(record.sites[0]?.stages).toEqual([
        { stage: "diagnose", status: "failed", detail: BLOCKED.diagnose },
        { stage: "notify-decision", status: "failed", detail: BLOCKED.notifyDecision },
      ]);
    }
    expect(sent).toEqual([]);
    expect(existsSync(join(dir, "state", "schedule", "schedule-uptime-zbm.lock"))).toBe(false);
    expect(readFileSync(join(dir, "state", "schedule", "uptime.runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("with live ports, weekly records maintain BLOCKED, no report, and the digest not wired", async () => {
    writeFileSync(join(dir, "zbm.yaml"), "tier: personal\n");
    const tool = makeTool(piWith(), { env: { WEBMASTER_STATE_DIR: join(dir, "state"), WEBMASTER_SITES_DIR: dir }, platform: "darwin" });
    const record = (await tool.execute("id", { job: "weekly", only: ["zbm"] }, undefined, undefined)).details;
    expect(record.status).toBe("incomplete");
    expect(record.sites[0]?.stages.map((s) => [s.stage, s.status])).toEqual([
      ["maintain", "failed"],
      ["report", "failed"],
      ["notify-decision", "failed"],
      ["digest", "skipped"],
      ["apply", "not-requested"],
    ]);
    expect(record.sites[0]?.stages[0]?.detail).toStartWith("BLOCKED:");
    // A snapshot from this run lets the digest stage reach the real default port: not wired.
    const stateZbm = join(dir, "state", "zbm");
    mkdirSync(stateZbm, { recursive: true });
    writeFileSync(join(stateZbm, "9999-01-01T00-00-00.000Z.json"), "{}");
    const again = (await tool.execute("id", { job: "weekly", only: ["zbm"] }, undefined, undefined)).details;
    expect(again.sites[0]?.stages.find((s) => s.stage === "digest")).toMatchObject({ status: "not-wired" });
    expect(again.sites[0]?.reportPath).toBe(join(stateZbm, "9999-01-01T00-00-00.000Z.json"));
  });

  it("deps.ports overrides individual live ports and keeps the others live", async () => {
    const { sent, exec } = osascriptSpy();
    const { ports } = harness({ sites: [{ name: "zbm", tier: "personal" }] });
    const tool = makeTool(piWith(exec), {
      env: { WEBMASTER_STATE_DIR: dir },
      platform: "darwin",
      ports: { sites: ports.sites, diagnose: ports.diagnose, notifyDecision: () => Promise.resolve({ notify: true, message: "alert" }) },
    });
    const record = (await tool.execute("id", { job: "uptime" }, undefined, undefined)).details;
    expect(record.status).toBe("complete");
    expect(sent).toEqual(["alert"]);
    expect(existsSync(join(dir, "schedule", "uptime.last.json"))).toBe(true);
  });

  it("sends heartbeats through onUpdate while the run is working and stops them after", async () => {
    const { ports } = harness();
    const gate = Promise.withResolvers<void>();
    const slow: SchedulePorts = { ...ports, diagnose: async (site) => (await gate.promise, { savedPath: `${STATE}/${site}/r.json` }) };
    const updates: string[] = [];
    const beat = Promise.withResolvers<void>();
    const tool = makeTool(piWith(), { ports: slow, heartbeatMs: 5 });
    const running = tool.execute("id", { job: "uptime" }, (u) => (updates.push(u.content[0]?.text ?? ""), beat.resolve()), undefined);
    await beat.promise;
    gate.resolve();
    await running;
    const during = updates.length;
    expect(updates[0]).toContain("running uptime");
    // Real timer on purpose: proving the interval is cleared needs the platform clock to pass several periods.
    await Bun.sleep(30);
    expect(updates.length).toBe(during);
  });

  it("an abort between sites stops the run, saves the record incomplete (never left running) and throws", async () => {
    const controller = new AbortController();
    const { ports, calls } = harness({ sites: [...TWO, { name: "zysys", tier: "business" }] });
    const aborting: SchedulePorts = {
      ...ports,
      diagnose: (site, capabilities) => {
        if (site === "isjac") controller.abort(new Error("stop it"));
        return ports.diagnose(site, capabilities);
      },
    };
    const tool = makeTool(piWith(), { ports: aborting });
    await expect(tool.execute("id", { job: "uptime" }, undefined, undefined, controller.signal)).rejects.toThrow("stop it");
    expect(calls.diagnose.map((c) => c.site)).toEqual(["zbm", "isjac"]);
    const last = calls.saved.at(-1);
    expect(last?.status).toBe("incomplete");
    expect(last?.finishedAt).not.toBeNull();
    expect(last?.notes).toContain("aborted before these sites ran: zysys");
    expect(last?.notes).toContain("run aborted");
  });

  it("an already-aborted signal throws before any record is saved", async () => {
    const { ports, calls } = harness();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(runJob("uptime", ports, undefined, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(calls.saved).toEqual([]);
  });
});

describe("readers", () => {
  it("readMaintainResult keeps the three fields the run reads", () => {
    expect(readMaintainResult({ status: "complete", auditCoverage: "audited all 3 pages", other: 1 })).toEqual({
      status: "complete",
      stoppedBecause: null,
      auditCoverage: "audited all 3 pages",
    });
    expect(() => readMaintainResult(null)).toThrow("not an object");
    expect(() => readMaintainResult({ status: "complete", auditCoverage: 3 })).toThrow("auditCoverage");
  });

  it("readNotifyDecision needs a reason when silent and a message when notifying", () => {
    expect(readNotifyDecision({ notify: false, reason: "baseline" })).toEqual({ notify: false, reason: "baseline" });
    expect(readNotifyDecision({ notify: true, message: "m", quiet: false })).toEqual({ notify: true, message: "m" });
    expect(() => readNotifyDecision({ notify: false })).toThrow("no reason");
    expect(() => readNotifyDecision({ notify: true, message: "" })).toThrow("no message");
    expect(() => readNotifyDecision({})).toThrow("notify true or false");
  });

  it("livePorts wires the BLOCKED answers: three throw, digest and apply say not wired", async () => {
    const ports = livePorts({ exec: unusedExec, env: { WEBMASTER_STATE_DIR: "/nowhere" }, home: "/h" });
    await expect(ports.diagnose("zbm", ["uptime"])).rejects.toThrow(/^BLOCKED:/);
    await expect(ports.maintain({ site: "zbm", filing: true, fix: true, pageLimit: 10 })).rejects.toThrow(/^BLOCKED:/);
    await expect(ports.notifyDecision("zbm", undefined)).rejects.toThrow(/^BLOCKED:/);
    expect(await ports.digest({ site: "zbm", reportPath: undefined })).toEqual({ status: "not wired" });
    expect(await ports.apply({ site: "zbm", reportPath: undefined })).toEqual({ status: "not wired" });
  });
});
