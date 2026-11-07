import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Prepared,
  preparedOf,
  relayOf,
  type RelayAnswer,
  settledOf,
  type Supersession,
  supersessionOf,
  type TicketPorts,
  validationOf,
  type Validation,
  workTicket,
} from "./chain.js";
import { fileLock } from "./file_lock.js";
import factory from "./index.js";
import type { Exec } from "./omp_delegate.js";
import {
  acquireWithin,
  type AttemptLedger,
  DEFAULTS,
  type Deps,
  fileAttemptLedger,
  liveTicketPorts,
  optimizeTooling,
  settingsOf,
} from "./run.js";
import { zodStub } from "./zod_stub.js";

const ready: Prepared = { ready_for_work: true, status: "Ready" };
const notSuperseded: Supersession = { verdict: "not_superseded", superseded_by: [], evidence: "none" };
const superseded: Supersession = {
  verdict: "superseded",
  superseded_by: [{ id: "ZYS-2", filed_at: "2026-01-01", why: "covers it" }],
  evidence: "ZYS-2 does it",
};
const current: Validation = { verdict: "current", reasons: [], status: "Todo", status_type: "unstarted", open_pull_requests: [] };
const relayed: RelayAnswer = { outcome: "work_completed", linearStatus: "Done", pullRequests: ["https://github.com/o/r/pull/1"], closedPullRequests: [] };

function ports(over: Partial<TicketPorts> = {}): TicketPorts & { calls: string[] } {
  const calls: string[] = [];
  const base: TicketPorts = {
    prepare: async () => (calls.push("prepare"), ready),
    findSuperseding: async () => (calls.push("find"), notSuperseded),
    validate: async () => (calls.push("validate"), current),
    closeSuperseded: async () => (calls.push("close"), { status: "Canceled", closedPullRequests: ["https://github.com/o/r/pull/9"] }),
    relay: async () => (calls.push("relay"), relayed),
  };
  return Object.assign({ ...base, ...over }, { calls });
}

describe("workTicket", () => {
  it("implements a current, ready ticket through the relay", async () => {
    const p = ports();
    const run = await workTicket("ZYS-1", p, { apply: true });
    expect(run.outcome).toBe("implemented");
    expect(run.relay?.pullRequests).toEqual(["https://github.com/o/r/pull/1"]);
    expect(run.linearStatus).toBe("Done");
    expect(p.calls).toEqual(["prepare", "find", "validate", "relay"]);
  });
  it("marks a relay that did not complete as relayed", async () => {
    const run = await workTicket("ZYS-1", ports({ relay: async () => ({ ...relayed, outcome: "blocked" }) }), { apply: true });
    expect(run.outcome).toBe("relayed");
  });
  it("apply:false stops after validation", async () => {
    const p = ports();
    expect((await workTicket("ZYS-1", p, { apply: false })).outcome).toBe("validated");
    expect(p.calls).not.toContain("relay");
  });
  it("a ticket that is not ready is not relayed", async () => {
    const p = ports({ prepare: async () => ({ ready_for_work: false, status: "Backlog", reason: "needs info" }) });
    const run = await workTicket("ZYS-1", p, { apply: true });
    expect(run).toMatchObject({ outcome: "not_ready", detail: "needs info" });
    expect(p.calls).not.toContain("relay");
  });
  it("not_current without supersession changes nothing", async () => {
    const p = ports({ validate: async () => ({ ...current, verdict: "not_current", reasons: ["already delivered"] }) });
    expect(await workTicket("ZYS-1", p, { apply: true })).toMatchObject({ outcome: "not_current", detail: "already delivered" });
    expect(p.calls).not.toContain("close");
  });
  it("closes a superseded ticket and records the closed pull requests", async () => {
    const p = ports({
      findSuperseding: async () => superseded,
      validate: async () => ({ ...current, verdict: "not_current", reasons: ["superseded"], open_pull_requests: [{ url: "u", title: null }] }),
    });
    const run = await workTicket("ZYS-1", p, { apply: true });
    expect(run).toMatchObject({ outcome: "superseded", linearStatus: "Canceled", closedPullRequests: ["https://github.com/o/r/pull/9"] });
  });
  it("writes nothing for a superseded ticket that is already closed with no open pull request", async () => {
    const p = ports({
      findSuperseding: async () => superseded,
      validate: async () => ({ ...current, verdict: "not_current", reasons: ["done"], status_type: "canceled" }),
    });
    expect((await workTicket("ZYS-1", p, { apply: true })).outcome).toBe("superseded");
    expect(p.calls).not.toContain("close");
  });
  it("unverified stops the chain", async () => {
    const p = ports({ validate: async () => ({ ...current, verdict: "unverified", reasons: ["linear down"] }) });
    expect(await workTicket("ZYS-1", p, { apply: true })).toMatchObject({ outcome: "unverified", detail: "linear down" });
  });
  it("a throwing step fails the ticket and names the step", async () => {
    const run = await workTicket("ZYS-1", ports({ findSuperseding: async () => Promise.reject(new Error("boom")) }), { apply: true });
    expect(run).toMatchObject({ outcome: "failed", detail: "find_superseding_tickets: boom" });
    const closing = await workTicket(
      "ZYS-1",
      ports({
        findSuperseding: async () => superseded,
        validate: async () => ({ ...current, verdict: "not_current", reasons: [] }),
        closeSuperseded: async () => Promise.reject(new Error("write refused")),
      }),
      { apply: true },
    );
    expect(closing.detail).toBe("close superseded ticket: write refused");
  });
});

describe("validators", () => {
  it("accept the tools' shapes and reject wrong ones", () => {
    expect(preparedOf({ ready_for_work: true, status: "Ready", reason: "x" })).toEqual({ ready_for_work: true, status: "Ready", reason: "x" });
    expect(() => preparedOf({ ready_for_work: "yes", status: "x" })).toThrow(/ready_for_work/);
    expect(supersessionOf({ verdict: "unverified", superseded_by: [], evidence: "e" }).verdict).toBe("unverified");
    expect(() => supersessionOf({ verdict: "maybe", superseded_by: [], evidence: "e" })).toThrow(/verdict/);
    expect(validationOf({ verdict: "current", reasons: [], status: null, open_pull_requests: [{ url: "u", title: null }] }).status_type).toBeNull();
    expect(() => validationOf({ verdict: "current", reasons: [1], status: null, open_pull_requests: [] })).toThrow(/reasons/);
    expect(settledOf({ status: "Done", closedPullRequests: [] }).status).toBe("Done");
    expect(() => relayOf({ pullRequests: [] })).toThrow(/closedPullRequests/);
  });
});

describe("settings", () => {
  it("defaults and bounds", () => {
    expect(settingsOf({})).toEqual(DEFAULTS);
    expect(() => settingsOf({ limit: 0 })).toThrow(/limit/);
    expect(() => settingsOf({ retry_after_hours: -1 })).toThrow(/retry_after_hours/);
    expect(() => settingsOf({ linear_teams: [""] })).toThrow(/linear_teams/);
  });
});

describe("ledger and lock", () => {
  it("records takes and reports the ones inside the window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opt-"));
    try {
      const ledger = fileAttemptLedger(join(dir, "sub", "attempts.json"));
      expect((await ledger.recent(1000, 500)).size).toBe(0);
      await ledger.take("ZYS-1", 900);
      await ledger.take("ZYS-2", 100);
      expect([...(await ledger.recent(1000, 500))]).toEqual(["ZYS-1"]);
      await writeFile(join(dir, "bad.json"), "[1]");
      await expect(fileAttemptLedger(join(dir, "bad.json")).recent(1, 1)).rejects.toThrow(/map/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("holds, refuses a second holder, reclaims a dead holder, releases only its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opt-"));
    try {
      const path = join(dir, "lock");
      let alive = true;
      const lock = fileLock(path, { isAlive: () => alive });
      expect((await lock.acquire({ runId: "a", ticket: "t" })).held).toBe(true);
      expect(await lock.acquire({ runId: "b", ticket: "t" })).toMatchObject({ held: false, holder: { runId: "a" } });
      await lock.release("b");
      expect(JSON.parse(await readFile(path, "utf8")).runId).toBe("a");
      alive = false;
      expect((await lock.acquire({ runId: "b", ticket: "t" })).held).toBe(true);
      await lock.release("b");
      await expect(readFile(path, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("acquireWithin polls until the deadline and gives up", async () => {
    let clock = 0;
    let tries = 0;
    const sleeps: number[] = [];
    const got = await acquireWithin(async () => ({ held: ++tries === 3 }), {
      waitMs: 1000,
      pollMs: 100,
      sleep: async (ms) => void ((clock += ms), sleeps.push(ms)),
      now: () => clock,
    });
    expect(got).toBe(true);
    expect(sleeps).toEqual([100, 100]);
    const never = await acquireWithin(async () => ({ held: false }), { waitMs: 250, pollMs: 100, sleep: async (ms) => void (clock += ms), now: () => clock });
    expect(never).toBe(false);
  });
});

function deps(over: Partial<Deps> = {}): Deps & { lines: string[]; taken: string[]; released: string[] } {
  const lines: string[] = [];
  const taken: string[] = [];
  const released: string[] = [];
  const ledger: AttemptLedger = { recent: async () => new Set(["ZYS-1"]), take: async (t) => void taken.push(t) };
  return Object.assign(
    {
      eligible: async () => ["ZYS-1", "ZYS-2", "ZYS-3"],
      ports: ports(),
      attempts: ledger,
      lock: { acquire: async () => ({ held: true }), release: async (id: string) => void released.push(id) },
      appendLine: async (_p: string, t: string) => void lines.push(t),
      logPath: "log",
      now: () => 10_000_000,
      sleep: async () => {},
    },
    over,
    { lines, taken, released },
  );
}

describe("optimizeTooling", () => {
  it("skips recently taken tickets, honors limit, records before working, releases the lock", async () => {
    const d = deps();
    const out = await optimizeTooling(settingsOf({ limit: 1 }), d);
    expect(out).toMatchObject({ status: "worked", eligible: 3, recently_taken: ["ZYS-1"] });
    expect(out.runs.map((r) => r.ticket)).toEqual(["ZYS-2"]);
    expect(d.taken).toEqual(["ZYS-2"]);
    expect(d.released).toHaveLength(1);
    expect(out.next).toBe("ZYS-2: implemented");
  });
  it("answers empty with the reason", async () => {
    const none = await optimizeTooling(settingsOf({}), deps({ eligible: async () => [] }));
    expect(none).toMatchObject({ status: "empty", next: "no ticket is in a workable status" });
    const all = await optimizeTooling(settingsOf({}), deps({ eligible: async () => ["ZYS-1"] }));
    expect(all.next).toContain("taken inside the retry window");
  });
  it("answers busy and logs the skip when the lock is never obtained", async () => {
    const d = deps({ lock: { acquire: async () => ({ held: false }), release: async () => {} }, lockWaitMs: 0 });
    const out = await optimizeTooling(settingsOf({}), d);
    expect(out.status).toBe("busy");
    expect(d.lines[0]).toContain("skipped, another run holds the lock");
  });
  it("releases the lock when reading tickets fails", async () => {
    const d = deps({ eligible: async () => Promise.reject(new Error("no list tool")) });
    await expect(optimizeTooling(settingsOf({}), d)).rejects.toThrow(/no list tool/);
    expect(d.released).toHaveLength(1);
  });
  it("one ticket's failure does not stop the next", async () => {
    const p = ports({ prepare: async (t) => (t === "ZYS-2" ? Promise.reject(new Error("x")) : ready) });
    const out = await optimizeTooling(settingsOf({ limit: 2 }), deps({ ports: p }));
    expect(out.runs.map((r) => r.outcome)).toEqual(["failed", "implemented"]);
  });
});

describe("live ports", () => {
  it("each stage asks omp to call the native tool of that name and validates the reply", async () => {
    const prompts: string[] = [];
    const replies: Record<string, string> = {
      list_eligible_tickets: '{"tickets":["ZYS-5"]}',
      prepare_ticket: '{"ready_for_work":true,"status":"Ready"}',
      relay: '{"pullRequests":[],"closedPullRequests":[],"outcome":"work_completed"}',
    };
    const exec: Exec = async (_c, args) => {
      const prompt = await readFile(args[1]!.slice(1), "utf8");
      prompts.push(prompt);
      const tool = /`([a-z_]+)`/.exec(prompt)![1]!;
      return { stdout: replies[tool] ?? '{"error":"tool not available"}', stderr: "", code: 0, killed: false };
    };
    const live = liveTicketPorts(exec);
    expect(await live.eligible({ teams: ["ZYS"], project: undefined, limit: 200 })).toEqual(["ZYS-5"]);
    expect((await live.ports.prepare("ZYS-5")).ready_for_work).toBe(true);
    expect((await live.ports.relay("ZYS-5")).outcome).toBe("work_completed");
    await expect(live.ports.findSuperseding("ZYS-5")).rejects.toThrow(/find_superseding_tickets: tool not available/);
    expect(prompts[0]).toContain('"teams":["ZYS"]');
  });
});

describe("tool", () => {
  it("loads with a stub zod; description is within 250 words", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
    const tool = (await factory({ zod: zodStub, exec, cwd: "/" } as unknown as Parameters<typeof factory>[0])) as unknown as {
      name: string;
      description: string;
    };
    expect(tool.name).toBe("optimize_tooling");
    expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(250);
  });
});
