import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import factory from "./index.js";
import { type AtaskRun, chooseGroupAtask, groupCapableRunAtask, type RunAtask } from "./atask.js";
import { runAtaskGroup } from "./loop.js";
import { workerCommand } from "./lifecycle.js";
import {
  cliGroupAtask,
  type CompletedMember,
  type GhPort,
  type GitPort,
  type GroupAtaskPort,
  type GroupClaim,
  type GroupInspection,
  liveLandingPorts,
  type ProgramRun,
  type TaskSnapshot,
  type WtPort,
} from "./ports.js";
import { renderReport } from "./render.js";
import {
  activeRunOf,
  createRunDir,
  describeRun,
  type Liveness,
  observe,
  readRecord,
  type RunRecord,
  runDirOf,
  writeRecord,
} from "./runs.js";
import { runGroupRun } from "./runner.js";
import { pollRun, startGroupRun, stopRun } from "./start.js";
import { type GroupInput, type GroupRunRequest, resolveGroupInput } from "./types.js";
import type { Clock } from "./util.js";
import { diskWorkerPort, pidAlive, type WorkerPort, type WorkerSpawnRequest, type WorkerSpawnStatus } from "./worker.js";

/* ------------------------------------------------------------------ fakes */

/** A clock that never waits in real time; each sleep moves `time` and tells the scenario it happened. */
class ScriptedClock implements Clock {
  time = 0;
  sleeps = 0;
  onSleep: (count: number) => void = () => {};
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
    if (this.sleeps >= 200) throw new Error("loop did not terminate: the scenario script is wrong");
    this.sleeps += 1;
    this.onSleep(this.sleeps);
  }
}

const claimed = (id: string): GroupClaim => ({
  kind: "claimed",
  claim: {
    id,
    title: `Task ${id}`,
    token: `tok-${id}`,
    workspace: `/ws/${id}`,
    branch: `atask/${id}`,
    target_branch: "main",
  },
});
const notReady: GroupClaim = { kind: "not_ready", proofsPending: false };
const proofsPending: GroupClaim = { kind: "not_ready", proofsPending: true };
const done: GroupClaim = { kind: "done" };

const idOf = (workspace: string): string => workspace.split("/").pop() as string;

/** The scripted claim answers repeat the last one, and every call lands in the shared event log. */
class FakeAtask implements GroupAtaskPort {
  readonly statuses = new Map<string, string>();
  readonly verifies: string[] = [];
  readonly groupVerifies: string[] = [];
  readonly renews: string[] = [];
  claimCalls = 0;
  readonly gateFailures = new Map<string, number>();
  groupVerifyError: Error | undefined;
  leaseInMs: number | undefined;
  leaseTtlMs: number | undefined;
  readonly leases = new Map<string, number>();
  readonly released: { token: string; failed: boolean; note: string }[] = [];
  /** Tasks claimed and not yet released: atask never hands one out a second time. */
  private readonly held = new Set<string>();

  constructor(
    private readonly claims: readonly (GroupClaim | Error)[],
    private readonly clock: ScriptedClock,
    private readonly log: string[],
  ) {}

  async inspect(): Promise<GroupInspection> {
    throw new Error("inspect is not part of the loop");
  }

  async claimGroup(): Promise<GroupClaim> {
    const next = this.claims[Math.min(this.claimCalls, this.claims.length - 1)] as GroupClaim | Error;
    if (next instanceof Error) {
      this.claimCalls += 1;
      throw next;
    }
    if (next.kind === "claimed" && this.held.has(next.claim.id)) {
      this.log.push("claim:not_ready");
      return notReady;
    }
    this.claimCalls += 1;
    this.log.push(`claim:${next.kind === "claimed" ? next.claim.id : next.kind}`);
    if (next.kind === "claimed") {
      this.held.add(next.claim.id);
      if (this.leaseTtlMs !== undefined) this.leases.set(next.claim.token, this.clock.now() + this.leaseTtlMs);
    }
    return next;
  }

  async show(id: string): Promise<TaskSnapshot> {
    const leased = this.leases.get(`tok-${id}`);
    const expires = leased ?? (this.leaseInMs === undefined ? undefined : this.clock.now() + this.leaseInMs);
    return {
      id,
      status: this.statuses.get(id) ?? "claimed",
      title: `Task ${id}`,
      ...(expires === undefined ? {} : { attempt: { lease_expires_ms: expires, lease_active: true } }),
    };
  }

  async renew(token: string): Promise<void> {
    this.renews.push(token);
    if (this.leaseTtlMs !== undefined) this.leases.set(token, this.clock.now() + this.leaseTtlMs);
  }

  async verifyComplete(workspace: string): Promise<void> {
    this.verifies.push(workspace);
    const remaining = this.gateFailures.get(workspace) ?? 0;
    if (remaining > 0) {
      this.gateFailures.set(workspace, remaining - 1);
      throw new Error("check proof failed");
    }
    this.statuses.set(idOf(workspace), "complete");
  }

  async verifyGroup(group: string): Promise<void> {
    this.groupVerifies.push(group);
    this.log.push("verify-group");
    if (this.groupVerifyError !== undefined) throw this.groupVerifyError;
  }

  async release(token: string, failed: boolean, note: string): Promise<void> {
    this.released.push({ token, failed, note });
    this.held.delete(token.replace(/^tok-/, ""));
    this.leases.delete(token);
    this.log.push(`release:${token.replace(/^tok-/, "")}`);
  }

  async completedMembers(): Promise<CompletedMember[]> {
    return [...this.statuses]
      .filter(([, status]) => status === "complete")
      .map(([id]) => ({
        id,
        title: `Task ${id}`,
        workspace: `/ws/${id}`,
        branch: `atask/${id}`,
        target_branch: "main",
        snapshot: { id, status: "complete", title: `Task ${id}` },
      }));
  }
}

class FakeWorker implements WorkerPort {
  readonly starts: WorkerSpawnRequest[] = [];
  readonly startFails = new Set<string>();
  readonly statusFails = new Set<string>();
  readonly stops: string[] = [];
  /** What `find` answers for any task, as the disk port's run directories do. */
  findResult: string | undefined = undefined;
  private readonly exited = new Set<string>();

  async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
    if (request.taskId !== undefined && this.startFails.has(request.taskId)) throw new Error("no pane to start in");
    this.starts.push(request);
    return { job_id: `job-${this.starts.length}` };
  }

  exit(taskId: string): void {
    this.starts.forEach((request, at) => {
      if (request.taskId === taskId) this.exited.add(`job-${at + 1}`);
    });
  }

  exitJob(jobId: string): void {
    this.exited.add(jobId);
  }

  async status(jobId: string): Promise<WorkerSpawnStatus> {
    if (this.statusFails.has(jobId)) throw new Error("worker status is unreadable");
    return this.exited.has(jobId) ? { state: "exited", exit_code: 0 } : { state: "running" };
  }

  stop(jobId: string): "killed" | "unknown" {
    this.stops.push(jobId);
    return "killed";
  }

  async find(): Promise<string | undefined> {
    return this.findResult;
  }
}

/** Serial by construction: a second merge starting before the first ends fails the run. */
class FakeWt implements WtPort {
  readonly merges: { workspace: string; target?: string }[] = [];
  private inFlight = 0;
  constructor(private readonly log: string[]) {}
  async merge(workspace: string, target?: string): Promise<string> {
    if (++this.inFlight > 1) throw new Error("two merges overlapped");
    this.log.push(`merge:${idOf(workspace)}`);
    await Promise.resolve();
    this.merges.push({ workspace, target });
    this.inFlight -= 1;
    return "merged";
  }
}

class FakeGit implements GitPort {
  async push(): Promise<string> {
    return "pushed";
  }
  async contains(): Promise<boolean> {
    return false;
  }
  async abortRebase(): Promise<undefined> {
    return undefined;
  }
}

class FakeGh implements GhPort {
  readonly creates: string[] = [];
  async createPullRequest(_workspace: string, request: { branch: string }): Promise<string> {
    this.creates.push(request.branch);
    return `https://github.com/o/r/pull/${this.creates.length}`;
  }
}

const input = (overrides: Record<string, unknown> = {}): GroupInput =>
  resolveGroupInput({ group: "g", ...overrides } as never);

function world(claims: readonly (GroupClaim | Error)[]) {
  const log: string[] = [];
  const clock = new ScriptedClock();
  const atask = new FakeAtask(claims, clock, log);
  const worker = new FakeWorker();
  const wt = new FakeWt(log);
  const gh = new FakeGh();
  const lines: string[] = [];
  const deps = {
    atask,
    worker,
    wt,
    git: new FakeGit(),
    gh,
    clock,
    pollMs: 1,
    workspaceExists: async (_path: string) => true,
    workerConfig: null,
    log: (line: string) => lines.push(line),
  };
  /** Marks the task's worker ended and, when `verified`, the task complete (the worker ran its own gate). */
  const finish = (id: string, verified = true): void => {
    worker.exit(id);
    if (verified) atask.statuses.set(id, "complete");
  };
  return { log, lines, clock, atask, worker, wt, gh, deps, finish };
}

/* --------------------------------------------------------------- the loop */

describe("input", () => {
  it("applies the defaults and refuses what the schema's types cannot express", () => {
    expect(resolveGroupInput({ group: " at-1 " })).toEqual({
      group: "at-1",
      max_workers: 4,
      onComplete: "merge",
      add_dirs: [],
      worker_timeout_s: 3600,
    });
    expect(resolveGroupInput({ group: "g", max_workers: null, onComplete: null, add_dirs: null }).max_workers).toBe(4);
    expect(() => resolveGroupInput({})).toThrow("group is required");
    expect(() => resolveGroupInput({ group: "  " })).toThrow("group is required");
    expect(() => resolveGroupInput({ group: "g", max_workers: 0 })).toThrow("max_workers");
    expect(() => resolveGroupInput({ group: "g", worker_timeout_s: 1.5 })).toThrow("worker_timeout_s");
    expect(() => resolveGroupInput({ group: "g", onComplete: "pr-auto" })).toThrow("onComplete");
    expect(() => resolveGroupInput({ group: "g", add_dirs: [""] })).toThrow("add_dirs");
  });
});

describe("complete_atask_group loop", () => {
  it("fills free slots with workers up to max_workers before any of them finishes", async () => {
    const w = world([claimed("a"), claimed("b"), claimed("c"), done]);
    let seen: { starts: number; claims: number } | undefined;
    w.clock.onSleep = () => {
      seen ??= { starts: w.worker.starts.length, claims: w.atask.claimCalls };
      w.finish("a");
      w.finish("b");
      w.finish("c");
    };
    const result = await runAtaskGroup(input({ max_workers: 2 }), w.deps);
    expect(seen).toEqual({ starts: 2, claims: 2 });
    expect(w.worker.starts.map((start) => [start.taskId, start.cwd])).toEqual([
      ["a", "/ws/a"],
      ["b", "/ws/b"],
      ["c", "/ws/c"],
    ]);
    expect(w.worker.starts[0]?.command).toContain("omp --auto-approve --model @task");
    expect(w.worker.starts[0]?.timeoutSeconds).toBe(3660);
    expect(result.status).toBe("settled");
  });

  it("passes add_dirs to every worker, quoted, and the overlay only when one is given", async () => {
    const w = world([claimed("a"), notReady, done]);
    w.clock.onSleep = () => w.finish("a");
    await runAtaskGroup(input({ add_dirs: ["/a b"] }), { ...w.deps, workerConfig: "/cfg/pin model.yml" });
    expect(w.worker.starts[0]?.command).toContain("--config '/cfg/pin model.yml' --add-dir '/a b' -p ");
    expect(workerCommand({ id: "a", add_dirs: [] }, null)).not.toContain("--config");
  });

  it("gates a worker that exits without a verified task, releases it as failed, and re-claims it for a fresh worker", async () => {
    const w = world([claimed("a"), notReady, claimed("a"), notReady, done]);
    w.atask.gateFailures.set("/ws/a", 1);
    w.clock.onSleep = () => w.finish("a", false);
    const result = await runAtaskGroup(input(), w.deps);
    expect(w.atask.verifies).toEqual(["/ws/a", "/ws/a"]);
    expect(w.atask.released.map(({ token, failed }) => ({ token, failed }))).toEqual([
      { token: "tok-a", failed: true },
    ]);
    expect(w.log.indexOf("release:a")).toBeLessThan(w.log.lastIndexOf("claim:a"));
    expect(w.worker.starts.map((start) => start.taskId)).toEqual(["a", "a"]);
    expect(result).toMatchObject({ status: "settled", members: [{ id: "a", state: "merged" }] });
  });

  it("does not gate a task atask already shows complete when its worker exits", async () => {
    const w = world([claimed("a"), notReady, done]);
    w.clock.onSleep = () => w.finish("a");
    await runAtaskGroup(input(), w.deps);
    expect(w.atask.verifies).toEqual([]);
  });

  it("renews the lease of a running member that is near expiry", async () => {
    const w = world([claimed("a"), notReady, notReady, done]);
    w.atask.leaseInMs = 60_000;
    w.clock.onSleep = (count) => {
      if (count === 2) w.finish("a");
    };
    await runAtaskGroup(input(), w.deps);
    expect(w.atask.renews).toEqual(["tok-a"]);
  });

  it("renews every live claim's 30 minute lease while another member's 20 minute gate runs", async () => {
    const minute = 60_000;
    const w = world([claimed("a"), claimed("b"), ...Array(7).fill(notReady), done]);
    w.atask.leaseTtlMs = 30 * minute;
    const { promise: gateOver, resolve: endGate } = Promise.withResolvers<void>();
    const verify = w.atask.verifyComplete.bind(w.atask);
    w.atask.verifyComplete = async (workspace) => {
      if (idOf(workspace) === "a") await gateOver; // a loop that stops polling never ends this gate
      return verify(workspace);
    };
    const expired: string[] = [];
    w.clock.onSleep = (count) => {
      for (const [token, expiry] of w.atask.leases) {
        const live = w.atask.statuses.get(token.replace(/^tok-/, "")) !== "complete";
        if (live && expiry <= w.clock.now() && !expired.includes(token)) expired.push(token);
      }
      if (count === 1) w.finish("a", false); // 5 min in: a's worker exits and its gate starts
      if (count === 5) endGate(); // 25 min in: the gate ends
      if (count === 7) w.finish("b");
    };
    const result = await runAtaskGroup(input(), { ...w.deps, pollMs: 5 * minute });
    expect(expired).toEqual([]);
    expect(w.atask.renews).toContain("tok-b");
    expect(w.atask.released).toEqual([]);
    expect(result).toMatchObject({ status: "settled", members: [{ id: "a" }, { id: "b" }] });
  }, 2_000);

  it("keeps renewing other members' leases while one member's gate is still running", async () => {
    const w = world([claimed("a"), claimed("b"), notReady, notReady, done]);
    w.atask.leaseInMs = 60_000;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const verify = w.atask.verifyComplete.bind(w.atask);
    w.atask.verifyComplete = async (workspace) => {
      await held; // a's gate cannot end until b's lease has been renewed
      return verify(workspace);
    };
    const renew = w.atask.renew.bind(w.atask);
    w.atask.renew = async (token) => {
      await renew(token);
      if (token === "tok-b") release();
    };
    w.clock.onSleep = (count) => {
      if (count === 1) w.finish("a", false);
      else w.finish("b");
    };
    const result = await runAtaskGroup(input(), w.deps);
    expect(result.members.map((member) => member.id)).toEqual(["a", "b"]);
    expect(w.atask.renews).toContain("tok-b");
  });

  it("runs the group's own proofs once when atask says they are pending, then lands after DONE", async () => {
    const w = world([claimed("a"), notReady, proofsPending, done]);
    w.clock.onSleep = () => w.finish("a");
    const result = await runAtaskGroup(input(), w.deps);
    expect(w.atask.groupVerifies).toEqual(["g"]);
    expect(w.log).toEqual(["claim:a", "claim:not_ready", "claim:not_ready", "verify-group", "claim:done", "merge:a"]);
    expect(result.status).toBe("settled");
  });

  it("fails the run, without landing, when the same pending state comes back after the proofs failed", async () => {
    const w = world([claimed("a"), notReady, proofsPending]);
    w.atask.groupVerifyError = new Error("integration check failed");
    w.clock.onSleep = () => w.finish("a");
    const result = await runAtaskGroup(input(), w.deps);
    expect(w.atask.groupVerifies).toEqual(["g"]);
    expect(w.wt.merges).toEqual([]);
    expect(result).toMatchObject({ status: "failed", members: [{ id: "a", state: "complete" }] });
    expect(result.status === "failed" && result.error).toContain("integration check failed");
  });

  it("lands one member at a time in completion order, and only after atask answers DONE", async () => {
    const w = world([claimed("a"), claimed("b"), notReady, notReady, done]);
    w.clock.onSleep = (count) => w.finish(count === 1 ? "b" : "a");
    const result = await runAtaskGroup(input({ onComplete: "merge" }), w.deps);
    expect(w.log).toEqual([
      "claim:a",
      "claim:b",
      "claim:not_ready",
      "claim:not_ready",
      "claim:done",
      "merge:b",
      "merge:a",
    ]);
    expect(w.wt.merges).toEqual([
      { workspace: "/ws/b", target: "main" },
      { workspace: "/ws/a", target: "main" },
    ]);
    expect(result).toMatchObject({ status: "settled", members: [{ id: "b" }, { id: "a" }] });
  });

  it("opens one pull request per member for onComplete pr, and leaves worktrees for nil", async () => {
    const pr = world([claimed("a"), notReady, done]);
    pr.clock.onSleep = () => pr.finish("a");
    const prResult = await runAtaskGroup(input({ onComplete: "pr" }), pr.deps);
    expect(pr.gh.creates).toEqual(["atask/a"]);
    expect(prResult).toMatchObject({ members: [{ state: "pull_request", url: "https://github.com/o/r/pull/1" }] });

    const left = world([claimed("a"), notReady, done]);
    left.clock.onSleep = () => left.finish("a");
    const leftResult = await runAtaskGroup(input({ onComplete: "nil" }), left.deps);
    expect(left.wt.merges).toEqual([]);
    expect(leftResult).toMatchObject({ members: [{ state: "left" }] });
  });

  it("answers stalled with atask's reasons, lands nothing, and stops the finished member's worker", async () => {
    const w = world([claimed("a"), notReady, { kind: "stalled", reasons: ["at-2 requires at-9 outside group g"] }]);
    w.clock.onSleep = () => w.finish("a");
    const result = await runAtaskGroup(input(), w.deps);
    expect(result).toEqual({
      status: "stalled",
      group: "g",
      members: [{ id: "a", title: "Task a", state: "complete" }],
      reasons: ["at-2 requires at-9 outside group g"],
    });
    expect(w.wt.merges).toEqual([]);
    expect(w.worker.stops).toEqual(["job-1"]);
  });

  it("answers failed on an unexpected atask error, stops the workers it started and releases their claims", async () => {
    const w = world([claimed("a"), new Error("atask is not runnable")]);
    const result = await runAtaskGroup(input(), w.deps);
    expect(result).toMatchObject({ status: "failed", error: "atask is not runnable" });
    expect(w.worker.stops).toEqual(["job-1"]);
    expect(w.atask.released.map(({ token, failed }) => ({ token, failed }))).toEqual([
      { token: "tok-a", failed: false },
    ]);
    expect(w.wt.merges).toEqual([]);
  });

  it("releases the claim and the other running members when a worker cannot start", async () => {
    const w = world([claimed("a"), claimed("b")]);
    w.worker.startFails.add("b");
    const result = await runAtaskGroup(input(), w.deps);
    expect(result).toMatchObject({ status: "failed", error: "no pane to start in" });
    expect(w.worker.stops).toEqual(["job-1"]);
    expect(
      w.atask.released.map(({ token, failed }) => ({ token, failed })).sort((x, y) => x.token.localeCompare(y.token)),
    ).toEqual([{ token: "tok-a", failed: false }, { token: "tok-b", failed: false }]);
  });

  it("reports the members that landed when landing itself throws midway", async () => {
    const w = world([claimed("a"), claimed("b"), notReady, done]);
    w.clock.onSleep = () => {
      w.finish("a");
      w.finish("b");
    };
    w.worker.statusFails.add("job-2");
    const result = await runAtaskGroup(input(), w.deps);
    expect(result).toMatchObject({ status: "failed", error: "worker status is unreadable" });
    expect(result.members.map((member) => [member.id, member.state])).toEqual([["a", "merged"], ["b", "complete"]]);
    expect(w.worker.stops).toEqual(["job-1", "job-2"]);
  });

  it("lands members an earlier run completed, with the ones this run completed, in completion order", async () => {
    const w = world([claimed("c"), notReady, done]);
    w.atask.statuses.set("old", "complete");
    w.clock.onSleep = () => w.finish("c");
    const result = await runAtaskGroup(input(), w.deps);
    expect(w.wt.merges.map((merge) => merge.workspace)).toEqual(["/ws/old", "/ws/c"]);
    expect(result).toMatchObject({
      status: "settled",
      members: [{ id: "old", state: "merged" }, { id: "c", state: "merged" }],
    });
  });

  it("names a landing that failed without hiding the members that landed", async () => {
    const w = world([claimed("a"), claimed("b"), notReady, done]);
    w.clock.onSleep = () => {
      w.finish("a");
      w.finish("b");
    };
    const failing = new FakeWt(w.log);
    const original = failing.merge.bind(failing);
    failing.merge = async (workspace, target) => {
      if (idOf(workspace) === "a") throw new Error("rebase conflict");
      return original(workspace, target);
    };
    const result = await runAtaskGroup(input(), { ...w.deps, wt: failing });
    expect(result.status).toBe("settled");
    expect(result.members.map((member) => [member.id, member.state])).toEqual([
      ["a", "landing_failed"],
      ["b", "merged"],
    ]);
  });

  it("adopts the live recorded worker of a re-claimed member instead of spawning a second", async () => {
    const w = world([claimed("a"), done]);
    w.worker.findResult = "proc:/logs/atask-a-x";
    w.clock.onSleep = (count) => {
      if (count === 1) w.atask.statuses.set("a", "complete"); // the adopted worker finished its task
    };
    const result = await runAtaskGroup(input(), w.deps);
    expect(w.worker.starts).toEqual([]);
    expect(result).toMatchObject({ status: "settled", members: [{ id: "a", state: "merged" }] });
    expect(w.wt.merges).toEqual([{ workspace: "/ws/a", target: "main" }]);
    expect(w.lines.some((line) => line.includes("adopted the live worker"))).toBe(true);
  });

  it("spawns a fresh worker for a re-claimed member whose recorded worker is dead", async () => {
    const w = world([claimed("a"), done]);
    w.worker.findResult = "proc:/logs/atask-a-x";
    w.worker.exitJob("proc:/logs/atask-a-x");
    w.clock.onSleep = (count) => {
      if (count === 1) {
        w.worker.exitJob("job-1");
        w.atask.statuses.set("a", "complete");
      }
    };
    const result = await runAtaskGroup(input(), w.deps);
    expect(w.worker.starts.map((start) => start.taskId)).toEqual(["a"]);
    expect(result).toMatchObject({ status: "settled", members: [{ id: "a", state: "merged" }] });
  });

  it("stops without claiming another member once the signal aborts, releasing what it holds", async () => {
    const w = world([claimed("a"), claimed("b"), claimed("c"), notReady]);
    const stop = new AbortController();
    w.clock.onSleep = () => stop.abort(new Error("the run was stopped by request"));
    const result = await runAtaskGroup(input({ max_workers: 2 }), { ...w.deps, signal: stop.signal });
    expect(result).toMatchObject({ status: "failed", error: "the run was stopped by request" });
    expect(w.atask.claimCalls).toBe(2);
    expect(w.worker.stops).toEqual(["job-1", "job-2"]);
    expect(w.atask.released.map(({ token }) => token).sort()).toEqual(["tok-a", "tok-b"]);
  });

  it("logs the notable steps of the run", async () => {
    const w = world([claimed("a"), notReady, done]);
    w.clock.onSleep = () => w.finish("a");
    await runAtaskGroup(input(), w.deps);
    expect(w.lines).toEqual([
      "claimed a",
      "a: started worker job-1 in /ws/a",
      "a: complete",
      "atask answered DONE: landing 1 member(s) with onComplete merge",
      "a: landing merged",
    ]);
  });
});

/* ------------------------------------------------------- the report text */

describe("renderReport", () => {
  it("names a settled group's members and each landing", () => {
    expect(renderReport({
      status: "settled",
      group: "g",
      members: [
        { id: "a", title: "A", state: "merged" },
        { id: "b", title: "B", state: "pull_request", url: "https://x/1" },
        { id: "c", title: "C", state: "landing_failed", error: "rebase\nconflict" },
        { id: "d", title: "D", state: "left" },
      ],
    })).toEqual({
      subject: "group g settled: 3 of 4 members landed, 1 landing failed",
      body: [
        "- a A: merged",
        "- b B: pull request opened https://x/1",
        "- c C: verified, landing failed: rebase conflict",
        "- d D: complete, left in its worktree",
      ].join("\n"),
    });
  });

  it("names a stall's reasons and a failure's cause, clipped", () => {
    const stalled = renderReport({
      status: "stalled",
      group: "g",
      members: [{ id: "a", title: "A", state: "complete" }],
      reasons: ["at-2 requires at-9 outside group g"],
    });
    expect(stalled.subject).toBe("group g stalled: at-2 requires at-9 outside group g");
    expect(stalled.body).toBe("- a A: complete, not landed\nStalled:\n- at-2 requires at-9 outside group g");
    const failed = renderReport({
      status: "failed",
      group: "g",
      members: [{ id: "a", title: "A", state: "gate_failed", error: "x".repeat(400) }],
      error: "y".repeat(500),
    });
    expect(failed.subject.length).toBeLessThanOrEqual("group g failed: ".length + 120);
    expect(failed.body).toContain(`gate failed: ${"x".repeat(300)}...`);
  });
});

/* ------------------------------------------------ the atask CLI contract */

/** A scripted atask binary: each argv answers with the envelope its key names. */
function scriptedAtask(answers: Record<string, { stdout: unknown; code?: number }>, calls: string[]): RunAtask {
  return async (argv): Promise<AtaskRun> => {
    const key = argv.join(" ");
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unscripted atask call: ${key}`);
    return { code: answer.code ?? 0, stdout: JSON.stringify(answer.stdout), stderr: "" };
  };
}

describe("cliGroupAtask contract", () => {
  const failure = (code: string, details?: unknown) => ({
    code: 1,
    stdout: { ok: false, error: { code, message: `${code} message`, ...(details === undefined ? {} : { details }) } },
  });

  it("claims with --group and reads the claimed member's worktree, token and target", async () => {
    const calls: string[] = [];
    const atask = cliGroupAtask(scriptedAtask({
      "--json claim --group at-g": {
        stdout: {
          ok: true,
          target_branch: "main",
          result: { token: "tok", workspace: "/ws/at-1", branch: "atask/at-1", task: { id: "at-1", title: "Parse" } },
        },
      },
    }, calls));
    expect(await atask.claimGroup("at-g")).toEqual({
      kind: "claimed",
      claim: {
        id: "at-1",
        title: "Parse",
        token: "tok",
        workspace: "/ws/at-1",
        branch: "atask/at-1",
        target_branch: "main",
      },
    });
    expect(calls).toEqual(["--json claim --group at-g"]);
  });

  it("refuses a claim envelope that names no task or no worktree", async () => {
    const answer = (result: unknown) =>
      cliGroupAtask(scriptedAtask({ "--json claim --group g": { stdout: { ok: true, result } } }, []));
    await expect(answer({ token: "t", workspace: "/w", branch: "b" }).claimGroup("g")).rejects.toMatchObject({
      code: "OUTPUT",
    });
    await expect(answer({ token: "", workspace: "/w", branch: "b", task: { id: "x" } }).claimGroup("g")).rejects
      .toMatchObject({ code: "OUTPUT" });
  });

  it("maps NOT_READY, DONE and STALLED answers and rethrows anything else", async () => {
    const answers = (kind: string, details?: unknown) =>
      cliGroupAtask(scriptedAtask({ "--json claim --group g": failure(kind, details) }, []));
    expect(await answers("NOT_READY", { group: "g", group_proofs_pending: true, active: 0 }).claimGroup("g")).toEqual({
      kind: "not_ready",
      proofsPending: true,
    });
    expect(await answers("NOT_READY", { group: "g", group_proofs_pending: false, active: 2 }).claimGroup("g")).toEqual({
      kind: "not_ready",
      proofsPending: false,
    });
    expect(await answers("DONE").claimGroup("g")).toEqual({ kind: "done" });
    expect(await answers("STALLED", { reasons: ["at-2 requires at-9 outside group g"] }).claimGroup("g")).toEqual({
      kind: "stalled",
      reasons: ["at-2 requires at-9 outside group g"],
    });
    expect(await answers("STALLED").claimGroup("g")).toEqual({ kind: "stalled", reasons: ["STALLED message"] });
    await expect(answers("INVALID_INPUT").claimGroup("g")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("runs the group's own proofs with verify complete on the group id", async () => {
    const calls: string[] = [];
    const atask = cliGroupAtask(scriptedAtask({
      "--json verify complete g": { stdout: { ok: true, result: {} } },
    }, calls));
    await atask.verifyGroup("g");
    expect(calls).toEqual(["--json verify complete g"]);
  });

  it("inspects the whole subtree: nested groups count, and a draft names the checks it lacks", async () => {
    const atask = cliGroupAtask(scriptedAtask({
      "--json show g --full": {
        stdout: {
          ok: true,
          result: {
            id: "g",
            kind: "group",
            title: "Group",
            children: [
              { id: "t1", title: "One", status: "ready" },
              { id: "sub", title: "Sub", status: "group" },
              { id: "t3", title: "Three", status: "draft" },
              { id: "t5", title: "Five", status: "archived" },
            ],
          },
        },
      },
      "--json show sub --full": {
        stdout: {
          ok: true,
          result: { id: "sub", kind: "group", title: "Sub", children: [{ id: "t2", title: "Two", status: "blocked" }] },
        },
      },
      "--json show t3": {
        stdout: {
          ok: true,
          result: { id: "t3", kind: "task", title: "Three", status: "draft", proof: null, regression: null },
        },
      },
    }, []));
    expect(await atask.inspect("g")).toEqual({
      kind: "group",
      id: "g",
      title: "Group",
      members: 3,
      drafts: [{ id: "t3", title: "Three", missing: ["proof", "regression"] }],
    });
  });

  it("counts task checks as a proof when naming what a draft lacks", async () => {
    const atask = cliGroupAtask(scriptedAtask({
      "--json show g --full": {
        stdout: { ok: true, result: { id: "g", kind: "group", children: [{ id: "t", status: "draft" }] } },
      },
      "--json show t": {
        stdout: {
          ok: true,
          result: { id: "t", kind: "task", status: "draft", task_checks: [{}], regression: { cmd: "x" } },
        },
      },
    }, []));
    expect(await atask.inspect("g")).toMatchObject({ drafts: [{ id: "t", title: "t", missing: [] }] });
  });

  it("reports an id that is a task, not a group", async () => {
    const atask = cliGroupAtask(scriptedAtask({
      "--json show t --full": {
        stdout: { ok: true, result: { id: "t", kind: "task", title: "One", status: "ready" } },
      },
    }, []));
    expect(await atask.inspect("t")).toEqual({ kind: "not_group", id: "t", title: "One", actual: "task" });
  });

  it("releases a claim by token, recording a failed attempt only when asked", async () => {
    const calls: string[] = [];
    const atask = cliGroupAtask(scriptedAtask({
      "--json claim release --failed --note gate tok-1": { stdout: { ok: true, result: {} } },
      "--json claim release --note stopped tok-2": { stdout: { ok: true, result: {} } },
    }, calls));
    await atask.release("tok-1", true, "gate");
    await atask.release("tok-2", false, "stopped");
    expect(calls).toEqual([
      "--json claim release --failed --note gate tok-1",
      "--json claim release --note stopped tok-2",
    ]);
  });

  it("reads one task's state with its lease, and renews a claim by token", async () => {
    const calls: string[] = [];
    const atask = cliGroupAtask(scriptedAtask({
      "--json show t": {
        stdout: {
          ok: true,
          result: {
            id: "t",
            status: "claimed",
            title: "One",
            attempt: { workspace: "/w", branch: "b", token: "tok", lease_expires_at: "2026-01-01T00:00:00Z", lease_active: true },
          },
        },
      },
      "--json claim renew tok": { stdout: { ok: true, result: {} } },
    }, calls));
    expect(await atask.show("t")).toMatchObject({
      id: "t",
      status: "claimed",
      attempt: { workspace: "/w", token: "tok", lease_expires_ms: Date.parse("2026-01-01T00:00:00Z"), lease_active: true },
    });
    await atask.renew("tok");
    expect(calls).toEqual(["--json show t", "--json claim renew tok"]);
  });

  it("runs the completion gate in the task worktree", async () => {
    const seen: { argv: string; cwd?: string }[] = [];
    const run: RunAtask = async (argv, options) => {
      seen.push({ argv: argv.join(" "), cwd: options?.cwd });
      return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" };
    };
    await cliGroupAtask(run).verifyComplete("/ws/t");
    expect(seen).toEqual([{ argv: "--json verify complete", cwd: "/ws/t" }]);
  });

  it("rebuilds the complete members of the subtree from show --full, in completion order, with the project's target", async () => {
    const calls: string[] = [];
    const complete = (id: string, title: string, completed_at: string) => ({
      stdout: {
        ok: true,
        result: {
          id,
          kind: "task",
          title,
          status: "complete",
          project: "p",
          completed_at,
          attempt: { workspace: `/ws/${id}`, branch: `atask/${id}` },
        },
      },
    });
    const atask = cliGroupAtask(scriptedAtask({
      "--json show g --full": {
        stdout: {
          ok: true,
          result: {
            id: "g",
            kind: "group",
            children: [
              { id: "t2", title: "Two", status: "complete" },
              { id: "sub", title: "Sub", status: "group" },
              { id: "t3", title: "Three", status: "ready" },
              { id: "t4", title: "Four", status: "archived" },
            ],
          },
        },
      },
      "--json show sub --full": {
        stdout: {
          ok: true,
          result: { id: "sub", kind: "group", children: [{ id: "t1", title: "One", status: "complete" }] },
        },
      },
      "--json show t2": complete("t2", "Two", "2026-10-26T10:05:00.000Z"),
      "--json show t1": complete("t1", "One", "2026-10-26T10:01:00.000Z"),
      "--json --project p project": { stdout: { ok: true, result: { target_branch: "main" } } },
    }, calls));
    const members = await atask.completedMembers("g");
    expect(members.map(({ id, title, workspace, branch, target_branch }) => ({
      id,
      title,
      workspace,
      branch,
      target_branch,
    }))).toEqual([
      { id: "t1", title: "One", workspace: "/ws/t1", branch: "atask/t1", target_branch: "main" },
      { id: "t2", title: "Two", workspace: "/ws/t2", branch: "atask/t2", target_branch: "main" },
    ]);
    expect(members[0]?.snapshot).toMatchObject({ id: "t1", status: "complete", title: "One" });
    expect(calls.filter((call) => call.endsWith("project"))).toHaveLength(1);
  });

  it("fails rather than landing a completed member that names no worktree", async () => {
    const atask = cliGroupAtask(scriptedAtask({
      "--json show g --full": {
        stdout: { ok: true, result: { id: "g", kind: "group", children: [{ id: "t", status: "complete" }] } },
      },
      "--json show t": { stdout: { ok: true, result: { id: "t", kind: "task", status: "complete" } } },
    }, []));
    await expect(atask.completedMembers("g")).rejects.toMatchObject({ code: "OUTPUT" });
  });

  it("refuses an answer that is not JSON, or an atask that is not runnable", async () => {
    const notJson: RunAtask = async () => ({ code: 0, stdout: "oops", stderr: "boom" });
    await expect(cliGroupAtask(notJson).show("t")).rejects.toMatchObject({ code: "OUTPUT" });
    const missing: RunAtask = async () => ({ code: 1, stdout: "", stderr: "", spawnError: "ENOENT" });
    await expect(cliGroupAtask(missing).show("t")).rejects.toMatchObject({ code: "SPAWN" });
  });
});

describe("the landing programs", () => {
  const scripted = (answers: Record<string, ProgramRun>, calls: string[]) =>
    async (binary: string, argv: readonly string[], options: { cwd?: string }): Promise<ProgramRun> => {
      const key = `${binary} ${argv.join(" ")}`;
      calls.push(`${key} @ ${options.cwd}`);
      const answer = answers[key];
      if (answer === undefined) throw new Error(`unscripted program: ${key}`);
      return answer;
    };

  it("merges with the exact wt argv, naming the target and keeping commits and worktree", async () => {
    const calls: string[] = [];
    const { wt } = liveLandingPorts(scripted({
      "wt -y merge main --no-squash --no-remove": { code: 0, stdout: "merged\n", stderr: "" },
    }, calls) as never);
    expect(await wt.merge("/ws/a", "main")).toBe("merged");
    expect(calls).toEqual(["wt -y merge main --no-squash --no-remove @ /ws/a"]);
  });

  it("names a failed program and what it printed", async () => {
    const { wt } = liveLandingPorts(scripted({
      "wt -y merge --no-squash --no-remove": { code: 3, stdout: "", stderr: "conflict in x.ts" },
    }, []) as never);
    await expect(wt.merge("/ws/a")).rejects.toThrow("wt merge exited 3: conflict in x.ts");
  });

  it("decides containment from git merge-base's exit code alone", async () => {
    const answers = (code: number) => ({
      "git merge-base --is-ancestor br main": { code, stdout: "", stderr: code > 1 ? "bad" : "" },
    });
    expect(await liveLandingPorts(scripted(answers(0), []) as never).git.contains("/c", "main", "br")).toBe(true);
    expect(await liveLandingPorts(scripted(answers(1), []) as never).git.contains("/c", "main", "br")).toBe(false);
    await expect(liveLandingPorts(scripted(answers(128), []) as never).git.contains("/c", "main", "br")).rejects
      .toThrow("git merge-base exited 128");
  });

  it("opens a pull request with gh from the worktree and answers its url", async () => {
    const calls: string[] = [];
    const { gh } = liveLandingPorts(scripted({
      "gh pr create --head br --title T --body B": { code: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" },
    }, calls) as never);
    expect(await gh.createPullRequest("/ws", { branch: "br", title: "T", body: "B" })).toBe("https://github.com/o/r/pull/9");
  });
});

/* ---------------------------------------------- the atask build on PATH */

describe("which atask build serves a group run", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "group-atask-path-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** An `atask` script that names its build in every answer and lists `claim --group` only when it supports it. */
  const buildScript = (name: string, group: boolean): string =>
    `#!/bin/sh\ncase "$*" in\n`
    + `  "--json help claim") echo '{"ok":true,"result":{"flags":[${group ? '{"name":"group"},' : ""}{"name":"x"}]}}' ;;\n`
    + `  *) echo '{"ok":true,"result":{"build":"${name}"}}' ;;\nesac\n`;

  async function pathOf(...dirs: readonly (readonly [string, string | undefined])[]): Promise<string> {
    for (const [name, script] of dirs) {
      await mkdir(join(root, name), { recursive: true });
      if (script !== undefined) await writeFile(join(root, name, "atask"), script, { mode: 0o755 });
    }
    return dirs.map(([name]) => join(root, name)).join(delimiter);
  }

  it("takes the first build in PATH order that claims by group, skipping older ones before it", () => {
    expect(chooseGroupAtask([
      { path: "/old/atask", claimsByGroup: false },
      { path: "/new/atask", claimsByGroup: true },
      { path: "/newer/atask", claimsByGroup: true },
    ])).toEqual({ kind: "found", path: "/new/atask" });
  });

  it("names every build it found when none claims by group, and says so when there is none", () => {
    const choice = chooseGroupAtask([
      { path: "/a/atask", claimsByGroup: false },
      { path: "/b/atask", claimsByGroup: false },
    ]);
    expect(choice.kind === "missing" ? choice.reason : "").toContain("/a/atask, /b/atask");
    expect(chooseGroupAtask([])).toEqual({ kind: "missing", reason: "no atask executable is on PATH" });
  });

  it("runs every call on the build that supports --group when an older one comes first", async () => {
    const path = await pathOf(["stale", buildScript("stale", false)], ["current", buildScript("current", true)]);
    const run = groupCapableRunAtask(() => path);
    const answer = await run(["--json", "show", "g"]);
    expect(JSON.parse(answer.stdout).result.build).toBe("current");
  });

  it("fails every call naming the builds found when none supports --group", async () => {
    const path = await pathOf(["stale", buildScript("stale", false)]);
    const answer = await groupCapableRunAtask(() => path)(["--json", "show", "g"]);
    expect(answer.spawnError).toContain("no atask on PATH supports `claim --group`");
    expect(answer.spawnError).toContain(join(root, "stale", "atask"));
  });

  it("fails saying so when no atask is on PATH", async () => {
    const path = await pathOf(["empty", undefined]);
    const answer = await groupCapableRunAtask(() => path)(["--json", "show", "g"]);
    expect(answer.spawnError).toContain("no atask executable is on PATH");
  });
});

/* ------------------------------------------------------------ the workers */

describe("the on-disk worker port", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "group-workers-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const settled = async (port: WorkerPort, jobId: string, ms = 8_000): Promise<WorkerSpawnStatus> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const status = await port.status(jobId);
      if (status.state !== "running" || Date.now() > deadline) return status;
      await Bun.sleep(40);
    }
  };

  const process_ = () => diskWorkerPort({ root, launcher: "process" });

  it("runs the command in its directory, records the exit code and keeps the output", async () => {
    const port = process_();
    const { job_id } = await port.start({ command: "pwd; echo hello; exit 3", cwd: root, taskId: "at-1", timeoutSeconds: 60 });
    expect(job_id.startsWith("proc:")).toBe(true);
    const status = await settled(port, job_id);
    expect(status.state).toBe("exited");
    expect(status.exit_code).toBe(3);
    expect(status.output_tail).toContain("hello");
    expect(status.output_tail).toContain(root.replace(/^\/private/, ""));
  });

  it("reports a worker that outlives its budget as timed out, with its whole process group gone", async () => {
    const port = process_();
    const { job_id } = await port.start({ command: "sleep 30", cwd: root, taskId: "at-2", timeoutSeconds: 1 });
    expect((await port.status(job_id)).state).toBe("running");
    const status = await settled(port, job_id);
    expect(status.state).toBe("timed_out");
    const pid = Number.parseInt(await readFile(join(job_id.slice("proc:".length), "pid"), "utf8"), 10);
    const deadline = Date.now() + 4_000;
    while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(40);
    expect(pidAlive(pid)).toBe(false);
  }, 15_000);

  it("stops a running worker and says it was killed", async () => {
    const port = process_();
    const { job_id } = await port.start({ command: "sleep 30", cwd: root, taskId: "at-3", timeoutSeconds: 60 });
    expect((await port.status(job_id)).state).toBe("running");
    expect(port.stop(job_id)).toBe("killed");
    expect((await settled(port, job_id)).state).toBe("killed");
    expect(port.stop("proc:/nowhere")).toBe("unknown");
    expect(port.stop("nonsense")).toBe("unknown");
  });

  it("finds a task's newest run by task id, across port instances, and nothing for another task", async () => {
    const first = await process_().start({ command: "true", cwd: root, taskId: "at-9", timeoutSeconds: 60 });
    await Bun.sleep(20);
    const second = await process_().start({ command: "true", cwd: root, taskId: "at-9", timeoutSeconds: 60 });
    expect(await process_().find?.("at-9")).toBe(second.job_id);
    expect(first.job_id).not.toBe(second.job_id);
    expect(await process_().find?.("at-8")).toBeUndefined();
    expect((await process_().status("proc:/nowhere")).state).toBe("unknown");
  });

  it("refuses to start in a directory that does not exist", async () => {
    await expect(process_().start({ command: "true", cwd: join(root, "missing"), taskId: "t", timeoutSeconds: 5 }))
      .rejects.toThrow("working directory does not exist");
  });

  it("runs in a herdr pane split off the caller's pane when herdr and a pane are available", async () => {
    const calls: string[][] = [];
    let paneAlive = true;
    const port = diskWorkerPort({
      root,
      herdr: async () => "/fake/herdr",
      paneId: () => "p1",
      call: async (_binary, args) => {
        calls.push([...args]);
        if (args[0] === "pane" && args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "p2" } } });
        if (args[0] === "pane" && args[1] === "get" && !paneAlive) throw new Error("no such pane");
        return "";
      },
    });
    const { job_id } = await port.start({ command: "echo hi", cwd: root, taskId: "at-5", timeoutSeconds: 60 });
    expect(job_id.startsWith("herdr:")).toBe(true);
    const dir = job_id.slice("herdr:".length);
    expect(calls[0]).toEqual(["pane", "split", "p1", "--direction", "down", "--no-focus", "--cwd", root]);
    expect(calls[1]?.slice(0, 3)).toEqual(["pane", "run", "p2"]);
    expect(calls[1]?.[3]).toContain(join(dir, "run.sh"));
    expect(calls[1]?.[3]).toContain("pane close 'p2'");
    expect(await readFile(join(dir, "run.sh"), "utf8")).toContain("tail -n +1 -f");
    expect(await readFile(join(dir, "pane"), "utf8")).toBe("p2");
    expect((await port.status(job_id)).state).toBe("running"); // no exit file, no pid, the pane is alive
    paneAlive = false;
    expect((await port.status(job_id)).state).toBe("killed");
    await writeFile(join(dir, "exit"), "0\n");
    expect((await port.status(job_id)).state).toBe("exited");
    expect(port.stop(job_id)).toBe("killed");
    await Bun.sleep(30);
    expect(calls.some((call) => call.join(" ") === "pane close p2")).toBe(true);
    expect(await port.find?.("at-5")).toBe(job_id);
  });

  it("uses a detached process when herdr has no pane to split", async () => {
    const calls: string[][] = [];
    const port = diskWorkerPort({
      root,
      herdr: async () => "/fake/herdr",
      paneId: () => undefined,
      call: async (_b, args) => {
        calls.push([...args]);
        return "";
      },
    });
    const { job_id } = await port.start({ command: "true", cwd: root, taskId: "at-6", timeoutSeconds: 60 });
    expect(job_id.startsWith("proc:")).toBe(true);
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------- the run records */

describe("run records", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "group-runs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const request = (id: string, group = "g"): GroupRunRequest => ({ ...input({ group }), run_id: id });
  const record = (patch: Partial<RunRecord> = {}): RunRecord => ({
    run_id: "gr-1",
    group: "g",
    state: "running",
    pid: 4242,
    started_at: 1_000,
    heartbeat_at: 1_000,
    ...patch,
  });
  const liveness = (now: number, alive: boolean): Liveness => ({ now: () => now, alive: () => alive });

  it("calls a running record lost when its runner is gone or its heartbeat stopped, and leaves the others alone", () => {
    expect(observe(record(), liveness(5_000, true)).state).toBe("running");
    expect(observe(record(), liveness(5_000, false)).state).toBe("lost");
    expect(observe(record(), liveness(1_000 + 2 * 60_000 + 1, true)).state).toBe("lost");
    expect(observe(record({ state: "settled" }), liveness(1e9, false)).state).toBe("settled");
    expect(observe(record({ state: "starting", pid: undefined }), liveness(10_000, false)).state).toBe("starting");
    expect(observe(record({ state: "starting", pid: undefined }), liveness(1_000 + 31_000, false)).state).toBe("lost");
  });

  it("finds the live run of a group and skips finished, lost and other groups' runs", async () => {
    const stamp = async (id: string, group: string, patch: Partial<RunRecord>) => {
      const dir = await createRunDir(root, request(id, group));
      await writeRecord(dir, record({ run_id: id, group, ...patch }));
    };
    await stamp("gr-old", "g", { state: "settled" });
    await stamp("gr-other", "h", {});
    await stamp("gr-live", "g", {});
    expect((await activeRunOf(root, "g", liveness(5_000, true)))?.run_id).toBe("gr-live");
    expect(await activeRunOf(root, "g", liveness(5_000, false))).toBeUndefined();
    expect(await activeRunOf(root, "nobody", liveness(5_000, true))).toBeUndefined();
    expect(await activeRunOf(join(root, "none"), "g")).toBeUndefined();
  });

  it("describes a lost run with the way to continue, and a settled run with its report", () => {
    const lost = describeRun(observe(record(), liveness(5_000, false)), "tail line", liveness(5_000, false));
    expect(lost).toContain("run gr-1 for group g: lost");
    expect(lost).toContain("call complete_atask_group with the group again");
    expect(lost).toContain("tail line");
    const settled = describeRun(record({ state: "settled", subject: "group g settled: 1 of 1 members landed", report: "- a A: merged" }), "", liveness(5_000, true));
    expect(settled).toContain("group g settled: 1 of 1 members landed\n- a A: merged");
  });

  it("polls a run by id, refuses an unknown or malformed id, and signals a live runner on stop", async () => {
    const dir = await createRunDir(root, request("gr-1"));
    await writeRecord(dir, record({ heartbeat_at: 4_000 }));
    const polled = await pollRun("gr-1", { stateRoot: root, liveness: liveness(5_000, true) });
    expect(polled.record.state).toBe("running");
    expect(polled.text).toContain("heartbeat 1s ago");
    await expect(pollRun("gr-404", { stateRoot: root })).rejects.toThrow("no run gr-404");
    await expect(pollRun("../etc", { stateRoot: root })).rejects.toThrow("not a run id");

    const killed: number[] = [];
    const stopped = await stopRun("gr-1", { stateRoot: root, liveness: liveness(5_000, true), kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([4242]);
    expect(stopped.stopRequested).toBe(true);

    await writeRecord(dir, record({ state: "failed" }));
    const again = await stopRun("gr-1", { stateRoot: root, liveness: liveness(5_000, true), kill: (pid) => killed.push(pid) });
    expect(again.stopRequested).toBe(false);
    expect(killed).toEqual([4242]);
  });
});

/* ------------------------------------------------------------ the runner */

describe("the detached runner", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "group-runner-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function prepare(id = "gr-1"): Promise<string> {
    const dir = await createRunDir(root, { ...input(), run_id: id });
    await writeRecord(dir, { run_id: id, group: "g", state: "starting", started_at: Date.now(), heartbeat_at: Date.now() });
    return dir;
  }

  it("records running with a heartbeat, then the final answer once, with the report file", async () => {
    const dir = await prepare();
    const midway: RunRecord[] = [];
    const final = await runGroupRun(dir, {
      heartbeatMs: 15,
      pid: 777,
      runLoop: async (req, deps) => {
        deps?.log?.("custom line");
        // wait for the heartbeat itself, not a guessed duration
        const first = (await readRecord(dir))!;
        for (let tries = 0; tries < 500; tries++) {
          const seen = (await readRecord(dir))!;
          if (seen.heartbeat_at > first.heartbeat_at) break;
          await Bun.sleep(5);
        }
        midway.push((await readRecord(dir))!);
        return { status: "settled", group: req.group, members: [{ id: "a", title: "A", state: "merged" }] };
      },
    });
    expect(midway[0]).toMatchObject({ state: "running", pid: 777 });
    expect(midway[0]!.heartbeat_at).toBeGreaterThan(midway[0]!.started_at);
    expect(final.state).toBe("settled");
    expect(final.subject).toBe("group g settled: 1 of 1 members landed");
    expect(await readRecord(dir)).toMatchObject({ state: "settled", report: "- a A: merged", pid: 777 });
    expect(await readFile(join(dir, "report.txt"), "utf8")).toBe("group g settled: 1 of 1 members landed\n- a A: merged\n");
    const log = await readFile(join(dir, "runner.log"), "utf8");
    expect(log).toContain("started for group g");
    expect(log).toContain("custom line");
    // Real timer behaviour on purpose: three heartbeat periods must pass to show none lands after the final record.
    await Bun.sleep(50);
    expect((await readRecord(dir))?.state).toBe("settled");
  });

  it("records failed when the loop breaks its own contract, once", async () => {
    const dir = await prepare();
    const final = await runGroupRun(dir, {
      runLoop: async () => {
        throw new Error("the loop broke its own contract");
      },
    });
    expect(final.state).toBe("failed");
    expect(final.subject).toBe("group g failed: the loop broke its own contract");
  });

  it("stops the real loop when asked: no further claim, held claims released, recorded as failed", async () => {
    const dir = await prepare();
    const w = world([claimed("a"), claimed("b"), notReady]);
    const stop = new AbortController();
    const { clock: _clock, ...deps } = w.deps;
    setTimeout(() => stop.abort(), 40);
    const final = await runGroupRun(dir, { stop: stop.signal, loop: { ...deps, pollMs: 5 } });
    expect(final.state).toBe("failed");
    expect(final.subject).toContain("the run was stopped by request");
    expect(w.atask.released.map(({ token }) => token).sort()).toEqual(["tok-a", "tok-b"]);
    expect(w.worker.stops).toEqual(["job-1", "job-2"]);
  });

  it("stops the loop when its budget runs out", async () => {
    const dir = await prepare();
    const w = world([notReady]);
    const { clock: _clock, ...deps } = w.deps;
    const final = await runGroupRun(dir, { budgetS: 0.05, loop: { ...deps, pollMs: 5 } });
    expect(final.state).toBe("failed");
    expect(final.subject).toContain("budget");
  });
});

/* ------------------------------------------------------------- the start */

describe("starting a run", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "group-start-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const group: GroupInspection = { kind: "group", id: "g", title: "Group", members: 3, drafts: [] };
  const never = async () => {
    throw new Error("the runner must not start");
  };

  it("refuses an id that is not a group and starts nothing", async () => {
    const output = await startGroupRun(input(), {
      stateRoot: root,
      atask: { inspect: async () => ({ kind: "not_group", id: "g", title: "One", actual: "task" }) },
      spawnRunner: never,
    });
    expect(output).toMatchObject({ status: "refused" });
    expect(output.status === "refused" && output.error).toContain("not a group");
  });

  it("refuses a subtree with drafts, naming each draft and the checks it lacks", async () => {
    const output = await startGroupRun(input(), {
      stateRoot: root,
      atask: {
        inspect: async () => ({
          ...group,
          drafts: [
            { id: "at-1", title: "Parse", missing: ["proof"] },
            { id: "at-2", title: "Render", missing: ["proof", "regression"] },
          ],
        }),
      },
      spawnRunner: never,
    });
    expect(output.status).toBe("refused");
    if (output.status !== "refused") return;
    expect(output.error).toContain("at-1 Parse (missing proof)");
    expect(output.error).toContain("at-2 Render (missing proof and regression)");
    expect(output.drafts?.map((draft) => draft.id)).toEqual(["at-1", "at-2"]);
  });

  it("refuses a group with no members, and an atask that cannot answer", async () => {
    const empty = await startGroupRun(input(), {
      stateRoot: root,
      atask: { inspect: async () => ({ ...group, members: 0 }) },
      spawnRunner: never,
    });
    expect(empty.status === "refused" && empty.error).toContain("no members");
    const broken = await startGroupRun(input(), {
      stateRoot: root,
      atask: {
        inspect: async () => {
          throw new Error("atask is not runnable");
        },
      },
      spawnRunner: never,
    });
    expect(broken.status === "refused" && broken.error).toBe("atask is not runnable");
  });

  /** A runner stand-in that does what the real one does first: records running with its pid. */
  const comesUp = (spawned: string[]) => async (dir: string) => {
    spawned.push(dir);
    const request = JSON.parse(await readFile(join(dir, "request.json"), "utf8")) as GroupRunRequest;
    await writeRecord(dir, {
      run_id: request.run_id,
      group: request.group,
      state: "running",
      pid: process.pid,
      started_at: Date.now(),
      heartbeat_at: Date.now(),
    });
    return { pid: process.pid };
  };

  it("returns started with a run id once the runner is up and hands it the whole request", async () => {
    const spawned: string[] = [];
    const output = await startGroupRun(input({ max_workers: 2, onComplete: "nil", add_dirs: ["/d"] }), {
      stateRoot: root,
      atask: { inspect: async () => group },
      newRunId: () => "gr-1",
      spawnRunner: comesUp(spawned),
    });
    expect(output).toEqual({ status: "started", group: "g", run_id: "gr-1", run_dir: runDirOf(root, "gr-1") });
    expect(JSON.parse(await readFile(join(runDirOf(root, "gr-1"), "request.json"), "utf8"))).toEqual({
      group: "g",
      max_workers: 2,
      onComplete: "nil",
      add_dirs: ["/d"],
      worker_timeout_s: 3600,
      run_id: "gr-1",
    });
  });

  it("returns the live run of the group instead of starting a second", async () => {
    const spawned: string[] = [];
    const deps = { stateRoot: root, atask: { inspect: async () => group }, spawnRunner: comesUp(spawned) };
    const first = await startGroupRun(input(), { ...deps, newRunId: () => "gr-1" });
    const second = await startGroupRun(input(), { ...deps, newRunId: () => "gr-2" });
    expect(first.status).toBe("started");
    expect(second).toMatchObject({ status: "running", run_id: "gr-1" });
    expect(spawned).toHaveLength(1);
  });

  it("starts a new run when the group's previous runner is gone (recovery)", async () => {
    const spawned: string[] = [];
    const dir = await createRunDir(root, { ...input(), run_id: "gr-dead" });
    await writeRecord(dir, { run_id: "gr-dead", group: "g", state: "running", pid: 2_147_483_000, started_at: 1, heartbeat_at: 1 });
    const output = await startGroupRun(input(), {
      stateRoot: root,
      atask: { inspect: async () => group },
      newRunId: () => "gr-new",
      spawnRunner: comesUp(spawned),
    });
    expect(output).toMatchObject({ status: "started", run_id: "gr-new" });
    expect((await pollRun("gr-dead", { stateRoot: root })).record.state).toBe("lost");
  });

  it("reports a runner that dies on its way up as a failed start, with its log", async () => {
    const output = await startGroupRun(input(), {
      stateRoot: root,
      atask: { inspect: async () => group },
      newRunId: () => "gr-1",
      liveness: { now: () => Date.now(), alive: () => false },
      spawnRunner: async (dir) => {
        await writeFile(join(dir, "runner.log"), "SyntaxError: nope\n");
        return { pid: 1 };
      },
    });
    expect(output.status).toBe("refused");
    expect(output.status === "refused" && output.error).toContain("it exited");
    expect(output.status === "refused" && output.error).toContain("SyntaxError: nope");
  });

  it("reports a runner that never records a heartbeat, and a runner that cannot be spawned", async () => {
    const killed: number[] = [];
    const silent = await startGroupRun(input(), {
      stateRoot: root,
      atask: { inspect: async () => group },
      newRunId: () => "gr-1",
      upTimeoutMs: 60,
      pollMs: 10,
      kill: (pid) => killed.push(pid),
      spawnRunner: async () => ({ pid: process.pid }),
    });
    expect(silent.status === "refused" && silent.error).toContain("no heartbeat within the start window");
    expect(killed).toEqual([process.pid]);
    // the failed start is recorded as failed, so it does not block the next start of the group
    expect((await pollRun("gr-1", { stateRoot: root })).record).toMatchObject({ state: "failed" });
    expect(await activeRunOf(root, "g")).toBeUndefined();
    const unspawnable = await startGroupRun(input(), {
      stateRoot: root,
      atask: { inspect: async () => group },
      newRunId: () => "gr-2",
      spawnRunner: async () => {
        throw new Error("bun is not on PATH");
      },
    });
    expect(unspawnable.status === "refused" && unspawnable.error).toContain("the runner could not start: bun is not on PATH");
    expect(existsSync(runDirOf(root, "gr-2"))).toBe(false);
  });
});

/* ------------------------------------------- the tool, with a real runner */

/** A zod stand-in whose every method answers itself: enough for `factory` to build its parameter schema. */
const zodStub = (() => {
  const schema: unknown = new Proxy(function () {}, { get: () => schema, apply: () => schema });
  return new Proxy({}, { get: () => () => schema });
})();

type ToolResult = { content: { type: string; text: string }[]; details: Record<string, any> };
type Tool = { name: string; description: string; execute: (...args: any[]) => Promise<ToolResult> };

describe("the tool", () => {
  let root: string;
  let saved: { path: string | undefined; state: string | undefined };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "group-tool-"));
    saved = { path: process.env.PATH, state: process.env.COMPLETE_ATASK_GROUP_STATE_DIR };
    process.env.COMPLETE_ATASK_GROUP_STATE_DIR = join(root, "state");
  });
  afterEach(async () => {
    process.env.PATH = saved.path;
    if (saved.state === undefined) delete process.env.COMPLETE_ATASK_GROUP_STATE_DIR;
    else process.env.COMPLETE_ATASK_GROUP_STATE_DIR = saved.state;
    await rm(root, { recursive: true, force: true });
  });

  const tool = (): Tool => factory({ zod: zodStub, cwd: root } as never) as unknown as Tool;
  const call = (params: Record<string, unknown>, signal?: AbortSignal) =>
    tool().execute("id", params, undefined, undefined, signal);

  /** Puts a scripted `atask` first on PATH: group `g` holds one complete task; claiming the group answers DONE. */
  async function fakeAtask(): Promise<void> {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "atask"),
      `#!/bin/sh
case "$*" in
  "--json help claim") echo '{"ok":true,"result":{"flags":[{"name":"group"}]}}' ;;
  "--json show g --full") echo '{"ok":true,"result":{"id":"g","kind":"group","title":"G","children":[{"id":"t1","title":"One","status":"complete"}]}}' ;;
  "--json show t1") echo '{"ok":true,"result":{"id":"t1","kind":"task","title":"One","status":"complete","completed_at":"2026-01-01T00:00:00Z","attempt":{"workspace":"/ws/t1","branch":"atask/t1"}}}' ;;
  "--json show tk --full") echo '{"ok":true,"result":{"id":"tk","kind":"task","title":"Task","status":"ready"}}' ;;
  "--json claim --group g") echo '{"ok":false,"error":{"code":"DONE","message":"done"}}'; exit 1 ;;
  *) echo "{\\"ok\\":false,\\"error\\":{\\"code\\":\\"UNSCRIPTED\\",\\"message\\":\\"$*\\"}}"; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${saved.path}`;
  }

  it("is a discoverable tool named complete_atask_group, and its description keeps to the style and the six questions", () => {
    const t = tool();
    expect(t.name).toBe("complete_atask_group");
    expect((t as { loadMode?: string }).loadMode).toBeUndefined();
    const words = t.description.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(t.description).not.toContain("/Users/");
    for (const part of ["Use after filing", "group MUST be a group id", "start_atask_task", "Poll:", "atask claim --group", "wt merge", "Spends model quota", "NO completion message"]) {
      expect(t.description).toContain(part);
    }
  });

  it("refuses ambiguous or misplaced arguments", async () => {
    await expect(call({})).rejects.toThrow("exactly one of group");
    await expect(call({ group: "g", run_id: "gr-1" })).rejects.toThrow("exactly one of group");
    await expect(call({ run_id: "gr-1", max_workers: 2 })).rejects.toThrow("apply only when starting");
    await expect(call({ group: "g", stop: true })).rejects.toThrow("stop needs run_id");
    await expect(call({ group: "g", max_workers: 0 })).rejects.toThrow("max_workers");
    await expect(call({ run_id: "gr-404" })).rejects.toThrow("no run gr-404");
  });

  it("fails a start on a task id with the refusal's reason", async () => {
    await fakeAtask();
    await expect(call({ group: "tk" })).rejects.toThrow("tk is a task, not a group");
  });

  it("starts a real detached runner, which settles the group and leaves its report where a poll reads it", async () => {
    await fakeAtask();
    const started = await call({ group: "g", onComplete: "nil" });
    expect(started.details).toMatchObject({ action: "start", status: "started", group: "g" });
    const runId = started.details.run_id as string;
    expect(runId).toMatch(/^gr-[0-9a-f]{12}$/);
    expect(started.content[0]!.text).toContain(`Poll with {"run_id":"${runId}"}`);

    let polled = await call({ run_id: runId });
    const deadline = Date.now() + 20_000;
    while (polled.details.status === "running" && Date.now() < deadline) {
      await Bun.sleep(100);
      polled = await call({ run_id: runId });
    }
    expect(polled.details.status).toBe("settled");
    expect(polled.details.subject).toBe("group g settled: 1 of 1 members landed");
    expect(polled.details.members).toEqual([{ id: "t1", title: "One", state: "left" }]);
    expect(polled.content[0]!.text).toContain("- t1 One: complete, left in its worktree");
    const dir = runDirOf(join(root, "state"), runId);
    expect(await readFile(join(dir, "report.txt"), "utf8")).toContain("group g settled");
    const pid = (await readRecord(dir))?.pid as number;
    const gone = Date.now() + 5_000;
    while (pidAlive(pid) && Date.now() < gone) await Bun.sleep(50);
    expect(pidAlive(pid)).toBe(false);
  }, 40_000);

  it("polls a run whose runner vanished as lost, and signals a live runner on stop", async () => {
    const state = join(root, "state");
    const dir = await createRunDir(state, { ...input(), run_id: "gr-dead" });
    await writeRecord(dir, { run_id: "gr-dead", group: "g", state: "running", pid: 2_147_483_000, started_at: 1, heartbeat_at: Date.now() });
    const lost = await call({ run_id: "gr-dead" });
    expect(lost.details.status).toBe("lost");
    expect(lost.content[0]!.text).toContain("call complete_atask_group with the group again");

    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise<string | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    const liveDir = await createRunDir(state, { ...input({ group: "h" }), run_id: "gr-live" });
    await writeRecord(liveDir, { run_id: "gr-live", group: "h", state: "running", pid: child.pid, started_at: Date.now(), heartbeat_at: Date.now() });
    const stopped = await call({ run_id: "gr-live", stop: true });
    expect(stopped.details).toMatchObject({ action: "stop", stop_requested: true });
    expect(await exited).toBe("SIGTERM");
  });
});
