import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { AtaskError, ataskEnvelope, ataskRunnerIn, isSettledTaskStatus, type RunAtask, runAtask, runClaim } from "./atask_cli.js";
import { type Clock, systemClock } from "./clock.js";
import { EXIT_MARKER, type WorkerPort, type WorkerSpawnRequest, type WorkerSpawnStatus, workerScript } from "./worker.js";
import { diskWorkerPort, type HerdrCall, type WorkerEnvironment } from "./disk_worker.js";
import {
  defaultPrompt,
  startAtaskTask,
  UNSTORED_CLAIM_WAIT_MS,
  WORKER_BUDGET_S,
  WORKER_GRACE_S,
  workerCommand,
} from "./lifecycle.js";
import {
  type ClaimedTask,
  cliStartTaskAtask,
  type GhPort,
  type GitPort,
  liveLandingPorts,
  type RebaseConflict,
  snapshotFromShow,
  type StartTaskAtaskPort,
  type TaskSnapshot,
  wtMergeArgv,
  type WtPort,
} from "./ports.js";
import { pickProject, projectsFromList, resolveProject } from "./projects.js";
import { normalizeInput } from "./schemas.js";
import { answerText, createTool, DESCRIPTION } from "./tool.js";
import { messageOf, shQuote, tailOf } from "./text.js";
import type { RunProgram } from "./programs.js";

// ---- ported from mastra/test/capability/start_atask_task/start_atask_task.test.ts
function ported1(): void {

/** A clock that never waits in real time: each sleep moves `time` by the sleep. */
class ScriptedClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

/** Answers each show with its scripted result, repeating the last one, and records every call. */
class FakeAtask implements StartTaskAtaskPort {
  readonly claims: string[] = [];
  readonly assigned: (string | undefined)[] = [];
  readonly renews: string[] = [];
  readonly verifies: string[] = [];
  readonly projects: string[] = [];
  private showCall = 0;

  constructor(
    private readonly shown: readonly (TaskSnapshot | Error)[],
    private readonly claimed: ClaimedTask | Error = {
      token: "sess-token",
      workspace: "/ws/task",
      branch: "atask/at-1",
      target_branch: "main",
    },
    private readonly verifyError?: Error,
    private readonly projectTargetResult: string | undefined = "main",
  ) {}

  async show(_id: string): Promise<TaskSnapshot> {
    const next = this.shown[Math.min(this.showCall++, this.shown.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }

  async claim(id: string): Promise<ClaimedTask> {
    this.claims.push(id);
    if (this.claimed instanceof Error) throw this.claimed;
    return this.claimed;
  }

  async assign(project?: string): Promise<ClaimedTask & { readonly id: string }> {
    this.assigned.push(project);
    if (this.claimed instanceof Error) throw this.claimed;
    return { ...this.claimed, id: "at-assigned" };
  }

  async renew(token: string): Promise<void> {
    this.renews.push(token);
  }

  async verifyComplete(workspace: string): Promise<void> {
    this.verifies.push(workspace);
    if (this.verifyError !== undefined) throw this.verifyError;
  }

  async projectTarget(project: string): Promise<string | undefined> {
    this.projects.push(project);
    return this.projectTargetResult;
  }
}

class FakeWorker implements WorkerPort {
  readonly starts: WorkerSpawnRequest[] = [];
  readonly stops: string[] = [];
  private statusCall = 0;

  constructor(private readonly statuses: readonly WorkerSpawnStatus[] = [{ state: "running" }]) {}

  async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
    this.starts.push(request);
    return { job_id: "job-1" };
  }

  async status(_jobId: string): Promise<WorkerSpawnStatus> {
    return this.statuses[Math.min(this.statusCall++, this.statuses.length - 1)];
  }

  stop(jobId: string): "killed" | "unknown" {
    this.stops.push(jobId);
    return "killed";
  }
  findResult: string | undefined = undefined;

  async find(_taskId: string): Promise<string | undefined> {
    return this.findResult;
  }
}

class FakeWt implements WtPort {
  readonly merges: { workspace: string; target?: string }[] = [];
  constructor(private readonly error?: Error) {}
  async merge(workspace: string, target?: string): Promise<string> {
    this.merges.push({ workspace, target });
    if (this.error !== undefined) throw this.error;
    return `merged ${workspace}`;
  }
}

class FakeGit implements GitPort {
  readonly pushes: { workspace: string; branch: string }[] = [];
  readonly checks: { workspace: string; target: string; branch: string }[] = [];
  readonly aborts: string[] = [];
  /**
   * What `contains` answers (a boolean, or an error it throws), and what `abortRebase` finds: the
   * stopped rebase it aborts, none, or an error it throws.
   */
  constructor(
    private readonly containment: boolean | Error = false,
    private readonly rebase: RebaseConflict | Error | undefined = undefined,
  ) {}
  async push(workspace: string, branch: string): Promise<string> {
    this.pushes.push({ workspace, branch });
    return `pushed ${branch}`;
  }
  async contains(workspace: string, target: string, branch: string): Promise<boolean> {
    this.checks.push({ workspace, target, branch });
    if (this.containment instanceof Error) throw this.containment;
    return this.containment;
  }
  async abortRebase(workspace: string): Promise<RebaseConflict | undefined> {
    this.aborts.push(workspace);
    if (this.rebase instanceof Error) throw this.rebase;
    return this.rebase;
  }
}

class FakeGh implements GhPort {
  readonly creates: { workspace: string; branch: string }[] = [];
  readonly arms: string[] = [];
  async createPullRequest(
    workspace: string,
    request: { branch: string; title: string; body: string },
  ): Promise<string> {
    this.creates.push({ workspace, branch: request.branch });
    return "https://github.com/o/r/pull/9";
  }
  async armAutoMerge(_workspace: string, url: string): Promise<string> {
    this.arms.push(url);
    return `armed ${url}`;
  }
}

const snapshotAt = (status: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: "at-1",
  status,
  ...overrides,
});

const dependencies = (
  atask: FakeAtask,
  worker: FakeWorker,
  wt: FakeWt = new FakeWt(),
  git: FakeGit = new FakeGit(),
  gh: FakeGh = new FakeGh(),
) => ({
  atask,
  worker,
  wt,
  git,
  gh,
  clock: new ScriptedClock(),
  pollMs: 1,
  workspaceExists: async (_path: string) => true,
});

const input = (overrides: Record<string, unknown> = {}) =>
  normalizeInput({ id: "at-1", ...overrides });

describe("start_atask_task", () => {
  it("lets atask claim assign the task when no id is given, and does not pick one", async () => {
    const atask = new FakeAtask([snapshotAt("complete", { id: "at-assigned", verdict: "assigned" })]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);

    const output = await startAtaskTask(input({ id: undefined, project: "homelab" }), dependencies(atask, worker));

    expect(atask.assigned).toEqual(["homelab"]);
    expect(atask.claims).toEqual([]);
    expect(worker.starts[0]?.taskId).toBe("at-assigned");
    expect(worker.starts[0]?.cwd).toBe("/ws/task");
    expect(output.task_id).toBe("at-assigned");
    expect(output.status).toBe("settled");
  });
  it("starts a ready task in its worktree, settles on atask's own verification, and merges", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "2/2 required checks passed" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("settled");
    expect(output.verdict).toBe("2/2 required checks passed");
    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(output.workspace).toBe("/ws/task");
    expect(output.branch).toBe("atask/at-1");
    expect(atask.claims).toEqual(["at-1"]);
    expect(wt.merges).toEqual([{ workspace: "/ws/task", target: "main" }]);
    expect(worker.starts[0]?.cwd).toBe("/ws/task");
    expect(worker.stops).toEqual([]);
  });

  it("runs the completion gate itself when the session ends before atask settles", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("claimed"),
      snapshotAt("claimed"),
      snapshotAt("complete", { verdict: "ok" }),
    ]);
    const worker = new FakeWorker([{ state: "running" }, { state: "exited", exit_code: 0 }]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(atask.verifies).toEqual(["/ws/task"]);
    expect(atask.renews).toContain("sess-token");
    expect(output.status).toBe("settled");
    expect(output.completion?.outcome).toBe("merged");
  });

  it("answers failed and never lands when the gate does not pass", async () => {
    const atask = new FakeAtask(
      [snapshotAt("ready"), snapshotAt("claimed")],
      undefined,
      new Error("proof failed: exit 1"),
    );
    const worker = new FakeWorker([{ state: "running" }, { state: "exited", exit_code: 1, output_tail: "gave up" }]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("failed");
    expect(output.error).toContain("verify complete");
    expect(output.error).toContain("proof failed");
    expect(output.error).toContain("gave up");
    expect(wt.merges).toEqual([]);
    expect(output.completion).toBeUndefined();
  });

  it("attaches to a claimed task without starting a second worker", async () => {
    const atask = new FakeAtask([
      snapshotAt("claimed", {
        project: "ai-task",
        attempt: { workspace: "/ws/other", branch: "atask/at-2", lease_expires_ms: 9_000_000_000_000 },
      }),
      snapshotAt("complete"),
    ]);
    const worker = new FakeWorker([]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
    expect(output.status).toBe("settled");
    expect(output.workspace).toBe("/ws/other");
    expect(wt.merges).toEqual([{ workspace: "/ws/other", target: "main" }]);
    expect(atask.projects).toEqual(["ai-task"]);
    expect(output.job_id).toBeUndefined();
  });

  it("reattaches to a claimed task's existing worker and runs the gate when that worker has ended", async () => {
    const atask = new FakeAtask([
      snapshotAt("claimed", {
        attempt: { workspace: "/ws/task", branch: "atask/at-1", token: "lease-1" },
      }),
      snapshotAt("claimed", {
        attempt: { workspace: "/ws/task", branch: "atask/at-1", token: "lease-1" },
      }),
      snapshotAt("complete", { verdict: "verified" }),
    ]);
    const worker = new FakeWorker([{ state: "killed", output_tail: "pane closed" }]);
    worker.findResult = "herdr:/logs/atask-at-1";

    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(worker.starts).toEqual([]);
    expect(atask.verifies).toEqual(["/ws/task"]);
    expect(output.status).toBe("settled");
    expect(output.job_id).toBe("herdr:/logs/atask-at-1");
    expect(output.verdict).toBe("verified");
  });

  it("answers running when the budget ends, and keeps the session alive", async () => {
    const atask = new FakeAtask([snapshotAt("ready"), snapshotAt("claimed")]);
    const worker = new FakeWorker([{ state: "running" }]);
    const output = await startAtaskTask(input({ timeout_s: 3 }), dependencies(atask, worker));

    expect(output.status).toBe("running");
    expect(output.job_id).toBe("job-1");
    expect(atask.verifies).toEqual([]);
    expect(worker.stops).toEqual([]);
    expect(worker.starts[0]?.timeoutSeconds).toBe(WORKER_BUDGET_S + WORKER_GRACE_S);
  });

  it("gives a short caller wait the worker budget floor, not that wait plus grace", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "ok" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    await startAtaskTask(input({ timeout_s: 60 }), dependencies(atask, worker));

    expect(worker.starts).toHaveLength(1);
    expect(worker.starts[0]?.timeoutSeconds).toBe(WORKER_BUDGET_S + WORKER_GRACE_S);
  });

  it("uses the worker budget floor when the caller leaves both clocks at their defaults", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "ok" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const parsed = input();
    await startAtaskTask(parsed, dependencies(atask, worker));

    expect(parsed.timeout_s).toBe(1800);
    expect(parsed.worker_timeout_s).toBeUndefined();
    expect(worker.starts[0]?.timeoutSeconds).toBe(WORKER_BUDGET_S + WORKER_GRACE_S);
  });

  it("lets worker_timeout_s override the floor without shortening the caller wait", async () => {
    const atask = new FakeAtask([snapshotAt("ready"), snapshotAt("claimed")]);
    const worker = new FakeWorker([{ state: "running" }]);
    const output = await startAtaskTask(
      input({ timeout_s: 3, worker_timeout_s: 90 }),
      dependencies(atask, worker),
    );

    expect(output.status).toBe("running");
    expect(worker.starts[0]?.timeoutSeconds).toBe(90 + WORKER_GRACE_S);
  });

  it("does not restart or resize a running worker when attaching, even with a shorter worker budget", async () => {
    const atask = new FakeAtask([
      snapshotAt("claimed", { attempt: { workspace: "/ws/other", branch: "atask/at-2" } }),
    ]);
    const worker = new FakeWorker([{ state: "running" }]);
    worker.findResult = "herdr:/logs/atask-at-2";
    const output = await startAtaskTask(
      input({ timeout_s: 3, worker_timeout_s: 30 }),
      dependencies(atask, worker),
    );

    expect(output.status).toBe("running");
    expect(output.job_id).toBe("herdr:/logs/atask-at-2");
    expect(worker.starts).toEqual([]);
    expect(worker.stops).toEqual([]);
  });

  it("runs the completion gate instead of answering running when a blind attach runs out of budget", async () => {
    const atask = new FakeAtask(
      [snapshotAt("claimed", { attempt: { workspace: "/ws/other", branch: "atask/at-2" } })],
      undefined,
      new Error("proof failed: exit 1"),
    );
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input({ timeout_s: 3 }), dependencies(atask, worker));

    expect(output.status).not.toBe("running");
    expect(output.status).toBe("failed");
    expect(output.workspace).toBe("/ws/other");
    expect(output.error).toContain("verify complete");
    expect(atask.verifies).toEqual(["/ws/other"]);
    expect(worker.starts).toEqual([]);
  });

  it("reclaims an interrupted task in its existing worktree, starts a fresh worker, and lands like a ready one", async () => {
    const atask = new FakeAtask([
      snapshotAt("interrupted", { attempt: { workspace: "/ws/task", branch: "atask/at-1" } }),
      snapshotAt("complete", { verdict: "resumed ok" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(atask.claims).toEqual(["at-1"]);
    expect(worker.starts).toHaveLength(1);
    expect(worker.starts[0]?.cwd).toBe("/ws/task");
    expect(output.status).toBe("settled");
    expect(output.verdict).toBe("resumed ok");
    expect(output.workspace).toBe("/ws/task");
    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(wt.merges).toEqual([{ workspace: "/ws/task", target: "main" }]);
  });

  it("refuses an interrupted task whose reclaim atask rejects and starts nothing", async () => {
    const atask = new FakeAtask([snapshotAt("interrupted")], new Error("CONFLICT: lease still held"));
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(atask.claims).toEqual(["at-1"]);
    expect(output.status).toBe("refused");
    expect(output.error).toContain("CONFLICT: lease still held");
    expect(worker.starts).toEqual([]);
  });

  it("refuses a draft and names the missing checks", async () => {
    const atask = new FakeAtask([snapshotAt("draft")]);
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("draft");
    expect(output.error).toContain("atask update at-1");
    expect(worker.starts).toEqual([]);
  });

  it("settles an already-complete task and lands its recorded worktree", async () => {
    const atask = new FakeAtask([
      snapshotAt("complete", {
        project: "ai-task",
        verdict: "done",
        attempt: { workspace: "/ws/done", branch: "atask/at-1" },
      }),
    ]);
    const worker = new FakeWorker([]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("settled");
    expect(output.summary).toContain("already complete");
    expect(wt.merges).toEqual([{ workspace: "/ws/done", target: "main" }]);
    expect(atask.claims).toEqual([]);
  });

  it("reports a failed landing for a complete task that records no worktree", async () => {
    const atask = new FakeAtask([snapshotAt("complete", { verdict: "done" })]);
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(output.status).toBe("settled");
    expect(output.completion).toMatchObject({ on_complete: "merge", outcome: "failed" });
    expect(output.completion?.error).toContain("no worktree");
  });

  it("opens and arms a pull request for onComplete pr-auto", async () => {
    const atask = new FakeAtask([snapshotAt("ready"), snapshotAt("complete")]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt();
    const git = new FakeGit();
    const gh = new FakeGh();
    const output = await startAtaskTask(
      input({ onComplete: "pr-auto" }),
      dependencies(atask, worker, wt, git, gh),
    );

    expect(git.pushes).toEqual([{ workspace: "/ws/task", branch: "atask/at-1" }]);
    expect(gh.creates).toEqual([{ workspace: "/ws/task", branch: "atask/at-1" }]);
    expect(gh.arms).toEqual(["https://github.com/o/r/pull/9"]);
    expect(output.completion).toEqual({
      on_complete: "pr-auto",
      outcome: "pull_request",
      url: "https://github.com/o/r/pull/9",
    });
    expect(wt.merges).toEqual([]);
  });

  it("reports a landing failure without hiding the settled objective", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "done" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt(new Error("not fast-forwardable"));
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("settled");
    expect(output.verdict).toBe("done");
    expect(output.completion).toMatchObject({ on_complete: "merge", outcome: "failed" });
    expect(output.completion?.error).toContain("not fast-forwardable");
  });

  it("reports merged when wt exits nonzero but the target already contains the branch", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "done" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt(
      new Error(
        "wt merge exited 1: ✓ Merged to main (1 commit, 25 files)\ncannot change directory — shell integration installed but not active",
      ),
    );
    const git = new FakeGit(true);
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt, git));

    expect(output.status).toBe("settled");
    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(git.checks).toEqual([{ workspace: "/ws/task", target: "main", branch: "atask/at-1" }]);
  });

  it("keeps the wt failure when the containment check itself cannot answer", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "done" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt(new Error("shell integration not active"));
    const git = new FakeGit(new Error("git merge-base exited 128"));
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt, git));

    expect(output.completion).toMatchObject({ on_complete: "merge", outcome: "failed" });
    expect(output.completion?.error).toContain("shell integration not active");
  });

  it("aborts a rebase stopped on conflicts and names the conflicting files and the target commit", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "done" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt(new Error("wt merge exited 1: CONFLICT (content): Merge conflict in src/a.ts"));
    const conflict = { onto: "4f2c9e1d0b", files: ["src/a.ts", "README.md"] };
    const git = new FakeGit(false, conflict);
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt, git));

    expect(output.status).toBe("settled");
    expect(git.aborts).toEqual(["/ws/task"]);
    expect(output.completion).toMatchObject({ on_complete: "merge", outcome: "failed", conflict });
    expect(output.completion?.error).toContain("src/a.ts, README.md");
    expect(output.completion?.error).toContain("4f2c9e1d0b");
    expect(output.completion?.error).toContain("aborted");
  });

  it("reports a stuck rebase when the abort itself fails", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "done" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt(new Error("wt merge exited 1: CONFLICT"));
    const git = new FakeGit(false, new Error("git rebase --abort exited 128: fatal"));
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt, git));

    expect(output.completion).toMatchObject({ on_complete: "merge", outcome: "failed" });
    expect(output.completion?.conflict).toBeUndefined();
    expect(output.completion?.error).toContain("CONFLICT");
    expect(output.completion?.error).toContain("git rebase --abort exited 128");
  });

  it("never aborts anything when the branch landed despite wt's exit code", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("complete", { verdict: "done" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt(new Error("shell integration not active"));
    const git = new FakeGit(true, { onto: "abc", files: ["x"] });
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt, git));

    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(git.aborts).toEqual([]);
  });

  it("lands on the project's feature target branch when the claim names one", async () => {
    const atask = new FakeAtask(
      [snapshotAt("ready"), snapshotAt("complete", { verdict: "done" })],
      {
        token: "sess-token",
        workspace: "/ws/zyins",
        branch: "atask/at-3",
        target_branch: "feat/autonomous-ingestion",
      },
    );
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("settled");
    expect(wt.merges).toEqual([{ workspace: "/ws/zyins", target: "feat/autonomous-ingestion" }]);
    expect(atask.projects).toEqual([]);
  });

  it("reads an attach landing's target from the project when the project names a feature branch", async () => {
    const atask = new FakeAtask(
      [
        snapshotAt("claimed", { project: "zyins", attempt: { workspace: "/ws/zyins", branch: "atask/at-3" } }),
        snapshotAt("complete"),
      ],
      undefined,
      undefined,
      "feat/autonomous-ingestion",
    );
    const worker = new FakeWorker([]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("settled");
    expect(atask.projects).toEqual(["zyins"]);
    expect(wt.merges).toEqual([{ workspace: "/ws/zyins", target: "feat/autonomous-ingestion" }]);
  });

  it("builds the wt merge argv the atask landing contract names", () => {
    expect(wtMergeArgv("main")).toEqual(["-y", "merge", "main", "--no-squash", "--no-remove"]);
    expect(wtMergeArgv(undefined)).toEqual(["-y", "merge", "--no-squash", "--no-remove"]);
  });

  it("renews the claim lease when it nears expiry while waiting", async () => {
    const atask = new FakeAtask([
      snapshotAt("ready"),
      snapshotAt("claimed", { attempt: { lease_expires_ms: 100_000 } }),
      snapshotAt("complete"),
    ]);
    const worker = new FakeWorker([{ state: "running" }]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(atask.renews).toContain("sess-token");
    expect(output.status).toBe("settled");
  });

  it("stops a session still running once the task settles, before landing", async () => {
    const atask = new FakeAtask([snapshotAt("ready"), snapshotAt("complete")]);
    const worker = new FakeWorker([{ state: "running" }]);
    const wt = new FakeWt();
    const output = await startAtaskTask(input(), dependencies(atask, worker, wt));

    expect(output.status).toBe("settled");
    expect(worker.stops).toEqual(["job-1"]);
    expect(wt.merges).toEqual([{ workspace: "/ws/task", target: "main" }]);
  });

  it("refuses a status it can neither start nor attach to", async () => {
    const atask = new FakeAtask([snapshotAt("blocked")]);
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("blocked");
  });

  it("refuses when atask itself fails to show the task", async () => {
    const atask = new FakeAtask([new Error("atask CLI is not runnable: spawn ENOENT")]);
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("spawn ENOENT");
  });

  it("refuses a claim atask rejects and starts nothing", async () => {
    const atask = new FakeAtask([snapshotAt("ready")], new Error("CONFLICT: held by another session"));
    const worker = new FakeWorker([]);
    const output = await startAtaskTask(input(), dependencies(atask, worker));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("CONFLICT");
    expect(worker.starts).toEqual([]);
  });

  it("quotes the prompt, the config overlay and the extra workspace dirs for the worker shell", () => {
    const parsed = normalizeInput({
      id: "at-9",
      prompt: "don't stop",
      add_dirs: ["~/.agents", "/abs/dir with space"],
    });
    expect(parsed.add_dirs).toEqual([`${homedir()}/.agents`, "/abs/dir with space"]);
    expect(workerCommand({ ...parsed, id: "at-9" }, "/home/u/pin-model.yml")).toBe(
      "omp --auto-approve --model @task --config '/home/u/pin-model.yml'"
        + ` --add-dir '${homedir()}/.agents' --add-dir '/abs/dir with space' -p 'don'\\''t stop'`,
    );
  });

  it("omits --config when no overlay is given", () => {
    expect(workerCommand({ ...input(), id: "at-1" })).not.toContain("--config");
  });

  it("tells the default prompt to finish only through atask verification", () => {
    const command = workerCommand({ ...input(), id: "at-1" });
    expect(command).toContain("atask context at-1");
    expect(command).toContain("atask verify complete");
    expect(command).toContain("wt step commit");
    expect(defaultPrompt("at-1")).toContain("at-1");
  });

  it("fills defaults, and refuses values the lifecycle cannot act on", () => {
    expect(normalizeInput({ id: "at-1" })).toMatchObject({
      id: "at-1",
      onComplete: "merge",
      add_dirs: [],
      timeout_s: 1800,
    });
    expect(normalizeInput({ id: null, project: null, onComplete: null, add_dirs: null, timeout_s: null })).toEqual({
      onComplete: "merge",
      add_dirs: [],
      timeout_s: 1800,
    });
    expect(() => normalizeInput({ id: "--json" })).toThrow("not an atask id");
    expect(() => normalizeInput({ id: "" })).toThrow("not an atask id");
    expect(() => normalizeInput({ id: "at-1", onComplete: "squash" })).toThrow("onComplete");
    expect(() => normalizeInput({ id: "at-1", timeout_s: 0 })).toThrow("timeout_s");
    expect(() => normalizeInput({ id: "at-1", worker_timeout_s: 1.5 })).toThrow("worker_timeout_s");
  });
});

}
ported1();

// ---- ported from mastra/test/capability/start_atask_task/land_after_merge.test.ts
function ported2(): void {

/**
 * The landing of a task whose worktree is gone — wt removes worktree and branch once a merge
 * lands, so a call that lands such a task again finds neither. These tests pin the two answers
 * that shape keeps honest: the landing reads whether the work already reached the target from a
 * checkout that survives (atask's recorded completed revision, from the directory the task was
 * created in), and a worktree that is gone is named as the cause, never a spawn error that reads
 * like a missing binary.
 */

class ScriptedClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

class FakeAtask implements StartTaskAtaskPort {
  constructor(
    private readonly shown: TaskSnapshot,
    private readonly projectTargetResult: string | undefined = "main",
  ) {}
  async show(_id: string): Promise<TaskSnapshot> {
    return this.shown;
  }
  async claim(_id: string): Promise<never> {
    throw new Error("a settled task is never claimed");
  }
  async assign(_project?: string): Promise<never> {
    throw new Error("a named task is never assigned");
  }
  async renew(_token: string): Promise<void> {}
  async verifyComplete(_workspace: string): Promise<void> {}
  async projectTarget(_project: string): Promise<string | undefined> {
    return this.projectTargetResult;
  }
}

class FakeWorker implements WorkerPort {
  readonly starts: WorkerSpawnRequest[] = [];
  async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
    this.starts.push(request);
    return { job_id: "job-1" };
  }
  async status(_jobId: string): Promise<WorkerSpawnStatus> {
    return { state: "exited", exit_code: 0 };
  }
  stop(_jobId: string): "killed" | "unknown" {
    return "killed";
  }
  async find(_taskId: string): Promise<string | undefined> {
    return undefined;
  }
}

class FakeWt implements WtPort {
  readonly merges: { workspace: string; target?: string }[] = [];
  async merge(workspace: string, target?: string): Promise<string> {
    this.merges.push({ workspace, target });
    return `merged ${workspace}`;
  }
}

class FakeGit implements GitPort {
  readonly checks: { cwd: string; target: string; revision: string }[] = [];
  readonly pushes: { workspace: string; branch: string }[] = [];
  constructor(private readonly containment: boolean | Error) {}
  async contains(cwd: string, target: string, revision: string): Promise<boolean> {
    this.checks.push({ cwd, target, revision });
    if (this.containment instanceof Error) throw this.containment;
    return this.containment;
  }
  async push(workspace: string, branch: string): Promise<string> {
    this.pushes.push({ workspace, branch });
    return `pushed ${branch}`;
  }
  async abortRebase(_workspace: string): Promise<undefined> {
    return undefined;
  }
}

class FakeGh implements GhPort {
  async createPullRequest(
    _workspace: string,
    _request: { branch: string; title: string; body: string },
  ): Promise<string> {
    return "https://github.com/o/r/pull/9";
  }
  async armAutoMerge(_workspace: string, _url: string): Promise<string> {
    return "armed";
  }
}

const settledTask = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: "at-gone",
  status: "complete",
  project: "capability-replicas",
  verdict: "2/2 required checks passed",
  attempt: { workspace: "/ws/gone", branch: "atask/at-gone" },
  completedRevision: "6b241737c7f74a72b8fd41406d61c68e52a32779",
  createdCwd: "/repo-checkout",
  ...overrides,
});

const input = (overrides: Record<string, unknown> = {}) =>
  normalizeInput({ id: "at-gone", ...overrides });

const deps = (
  atask: FakeAtask,
  git: FakeGit,
  on_complete: Record<string, unknown> = {},
) => ({
  atask,
  worker: new FakeWorker(),
  wt: new FakeWt(),
  git,
  gh: new FakeGh(),
  clock: new ScriptedClock(),
  pollMs: 1,
  workspaceExists: async (_path: string) => false,
  ...on_complete,
});

describe("start_atask_task landing after the worktree is gone", () => {
  it("answers merged for an already-complete task whose worktree and branch are gone", async () => {
    const atask = new FakeAtask(settledTask());
    const git = new FakeGit(true);

    const output = await startAtaskTask(input(), deps(atask, git));

    expect(output.status).toBe("settled");
    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(git.checks).toEqual([
      { cwd: "/repo-checkout", target: "main", revision: "6b241737c7f74a72b8fd41406d61c68e52a32779" },
    ]);
  });

  it("never spawns wt in the gone worktree", async () => {
    const atask = new FakeAtask(settledTask());
    const wt = new FakeWt();
    const git = new FakeGit(true);

    await startAtaskTask(input(), { ...deps(atask, git), wt });

    expect(wt.merges).toEqual([]);
  });

  it("names the gone worktree and the revision outside the target, never a spawn error", async () => {
    const atask = new FakeAtask(settledTask());
    const git = new FakeGit(false);

    const output = await startAtaskTask(input(), deps(atask, git));

    expect(output.status).toBe("settled");
    expect(output.completion?.outcome).toBe("failed");
    expect(output.completion?.error).toContain("/ws/gone is gone");
    expect(output.completion?.error).toContain("is not in main");
    expect(output.completion?.error).not.toMatch(/could not start/);
  });

  it("checks the attempt's branch when atask recorded no completed revision", async () => {
    const atask = new FakeAtask(settledTask({ completedRevision: undefined }));
    const git = new FakeGit(true);

    const output = await startAtaskTask(input(), deps(atask, git));

    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(git.checks).toEqual([{ cwd: "/repo-checkout", target: "main", revision: "atask/at-gone" }]);
  });

  it("answers failed naming the gone worktree when the landing cannot be checked at all", async () => {
    const atask = new FakeAtask(settledTask({ createdCwd: undefined }));
    const git = new FakeGit(true);

    const output = await startAtaskTask(input(), deps(atask, git));

    expect(output.completion?.outcome).toBe("failed");
    expect(output.completion?.error).toContain("/ws/gone is gone");
    expect(output.completion?.error).toContain("could not be checked");
    expect(output.completion?.error).not.toMatch(/could not start/);
    expect(git.checks).toEqual([]);
  });

  it("answers merged for a pull-request landing whose work already reached the target", async () => {
    const atask = new FakeAtask(settledTask());
    const git = new FakeGit(true);

    const output = await startAtaskTask(input({ onComplete: "pr-auto" }), deps(atask, git));

    expect(output.completion).toEqual({ on_complete: "pr-auto", outcome: "merged" });
    expect(git.pushes).toEqual([]);
  });
});

}
ported2();

// ---- ported from mastra/test/capability/start_atask_task/liveness.test.ts
function ported3(): void {

/**
 * Liveness: `running` is always backed by a live worker process, and a live worker is attached to,
 * never given a second claim or spawn — even when atask reads the claim `interrupted` (the lease
 * lapsed, not the process) and even when this call cannot see the worker at all.
 */

/** A clock that never waits in real time: each sleep moves `time` by the sleep. */
class ScriptedClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

/** Answers each show with its scripted result, repeating the last one, and records every call. */
class FakeAtask implements StartTaskAtaskPort {
  readonly claims: string[] = [];
  readonly assigned: (string | undefined)[] = [];
  readonly renews: string[] = [];
  readonly verifies: string[] = [];
  readonly projects: string[] = [];
  private showCall = 0;

  constructor(
    private readonly shown: readonly (TaskSnapshot | Error)[],
    private readonly claimed: ClaimedTask = {
      token: "sess-token",
      workspace: "/ws/task",
      branch: "atask/at-1",
      target_branch: "main",
    },
    private readonly verifyError?: Error,
    private readonly projectTargetResult: string | undefined = "main",
    readonly assignedId: string = "at-assigned",
  ) {}

  async show(_id: string): Promise<TaskSnapshot> {
    const next = this.shown[Math.min(this.showCall++, this.shown.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }

  async claim(id: string): Promise<ClaimedTask> {
    this.claims.push(id);
    return this.claimed;
  }

  async assign(project?: string): Promise<ClaimedTask & { readonly id: string }> {
    this.assigned.push(project);
    return { ...this.claimed, id: this.assignedId };
  }

  async renew(token: string): Promise<void> {
    this.renews.push(token);
  }

  async verifyComplete(workspace: string): Promise<void> {
    this.verifies.push(workspace);
    if (this.verifyError !== undefined) throw this.verifyError;
  }

  async projectTarget(project: string): Promise<string | undefined> {
    this.projects.push(project);
    return this.projectTargetResult;
  }
}

class FakeWorker implements WorkerPort {
  readonly starts: WorkerSpawnRequest[] = [];
  readonly stops: string[] = [];
  private statusCall = 0;
  findResult: string | undefined = undefined;

  constructor(private readonly statuses: readonly WorkerSpawnStatus[] = [{ state: "running" }]) {}

  async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
    this.starts.push(request);
    return { job_id: "job-1" };
  }

  async status(_jobId: string): Promise<WorkerSpawnStatus> {
    return this.statuses[Math.min(this.statusCall++, this.statuses.length - 1)];
  }

  stop(jobId: string): "killed" | "unknown" {
    this.stops.push(jobId);
    return "killed";
  }

  async find(_taskId: string): Promise<string | undefined> {
    return this.findResult;
  }
}

class FakeWt implements WtPort {
  readonly merges: { workspace: string; target?: string }[] = [];
  async merge(workspace: string, target?: string): Promise<string> {
    this.merges.push({ workspace, target });
    return `merged ${workspace}`;
  }
}

class FakeGit implements GitPort {
  async push(): Promise<string> {
    return "pushed";
  }
  async contains(): Promise<boolean> {
    return false;
  }
  async abortRebase(): Promise<RebaseConflict | undefined> {
    return undefined;
  }
}

class FakeGh implements GhPort {
  async createPullRequest(
    _workspace: string,
    _request: { branch: string; title: string; body: string },
  ): Promise<string> {
    return "https://github.com/o/r/pull/9";
  }

  async armAutoMerge(_workspace: string, url: string): Promise<string> {
    return `armed ${url}`;
  }
}

const snapshot = (id: string, status: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id,
  status,
  ...overrides,
});

const deps = (atask: FakeAtask, worker: FakeWorker, wt = new FakeWt()) => ({
  atask,
  worker,
  wt,
  git: new FakeGit(),
  gh: new FakeGh(),
  clock: new ScriptedClock(),
  pollMs: 1,
  workspaceExists: async (_path: string) => true,
});

const input = (overrides: Record<string, unknown> = {}) =>
  normalizeInput({ ...overrides });

describe("start_atask_task liveness", () => {
  it("attaches to the live recorded worker of an interrupted claim and never claims or spawns again", async () => {
    const attempt = { workspace: "/ws/live", branch: "atask/at-live", token: "lease-1" };
    const atask = new FakeAtask([
      snapshot("at-live", "interrupted", { project: "ai-task", attempt }),
      snapshot("at-live", "claimed", { project: "ai-task", attempt }),
      snapshot("at-live", "complete", { verdict: "the live worker finished" }),
    ]);
    const worker = new FakeWorker([{ state: "running" }]);
    worker.findResult = "herdr:/logs/atask-at-live";
    const wt = new FakeWt();

    const output = await startAtaskTask(input({ id: "at-live" }), deps(atask, worker, wt));

    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
    expect(output.status).toBe("settled");
    expect(output.job_id).toBe("herdr:/logs/atask-at-live");
    expect(output.completion?.outcome).toBe("merged");
    expect(wt.merges).toEqual([{ workspace: "/ws/live", target: "main" }]);
  });

  it("refuses to spawn when a live worker holds a claim whose attempt records no worktree", async () => {
    const atask = new FakeAtask([snapshot("at-orphan", "interrupted", { attempt: {} })]);
    const worker = new FakeWorker([{ state: "running" }]);
    worker.findResult = "herdr:/logs/atask-at-orphan";

    const output = await startAtaskTask(input({ id: "at-orphan" }), deps(atask, worker));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("no worktree");
    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
  });

  it("reports a dead recorded worker truthfully through the completion gate, never as running", async () => {
    const atask = new FakeAtask(
      [snapshot("at-dead", "claimed", { attempt: { workspace: "/ws/dead", branch: "atask/at-dead" } })],
      undefined,
      new Error("proof failed: exit 1"),
    );
    const worker = new FakeWorker([
      { state: "exited", exit_code: 1, output_tail: "PostgresError: password authentication failed for user 'neondb_owner'" },
    ]);
    worker.findResult = "herdr:/logs/atask-at-dead";

    const output = await startAtaskTask(input({ id: "at-dead" }), deps(atask, worker));

    expect(output.status).not.toBe("running");
    expect(output.status).toBe("failed");
    expect(output.error).toContain("verify complete");
    expect(output.error).toContain("PostgresError");
    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
  });

  it("never answers running for a claimed task whose worker it cannot see: the wait ends at the gate", async () => {
    const atask = new FakeAtask(
      [snapshot("at-blind", "claimed", { attempt: { workspace: "/ws/blind", branch: "atask/at-blind" } })],
      undefined,
      new Error("proof failed: exit 1"),
    );
    const worker = new FakeWorker([]);

    const output = await startAtaskTask(input({ id: "at-blind", timeout_s: 3 }), deps(atask, worker));

    expect(output.status).not.toBe("running");
    expect(output.status).toBe("failed");
    expect(output.error).toContain("verify complete");
    expect(atask.verifies).toEqual(["/ws/blind"]);
    expect(worker.starts).toEqual([]);
  });

  it("answers running only behind a live worker: one that dies by the wait's end goes to the gate", async () => {
    const atask = new FakeAtask(
      [snapshot("at-boundary", "ready"), snapshot("at-boundary", "claimed")],
      undefined,
      new Error("proof failed: exit 1"),
    );
    const worker = new FakeWorker([
      { state: "running" },
      { state: "running" },
      { state: "exited", exit_code: 1, output_tail: "died just before the wait ended" },
    ]);

    const output = await startAtaskTask(
      input({ id: "at-boundary", timeout_s: 3 }),
      { ...deps(atask, worker), pollMs: 2_000 },
    );

    expect(output.status).not.toBe("running");
    expect(output.status).toBe("failed");
    expect(output.error).toContain("died just before the wait ended");
  });

  it("reattaches to the worker this process started even with no findable run, and starts nothing new", async () => {
    const worker = new FakeWorker([{ state: "running" }]);
    const first = new FakeAtask([snapshot("at-record", "ready"), snapshot("at-record", "claimed")]);
    const firstOutput = await startAtaskTask(input({ id: "at-record", timeout_s: 1 }), deps(first, worker));
    expect(firstOutput.status).toBe("running");

    const second = new FakeAtask([
      snapshot("at-record", "claimed", { attempt: { workspace: "/ws/task", branch: "atask/at-record" } }),
    ]);
    const secondOutput = await startAtaskTask(input({ id: "at-record", timeout_s: 1 }), deps(second, worker));

    expect(worker.starts).toHaveLength(1);
    expect(secondOutput.status).toBe("running");
    expect(secondOutput.job_id).toBe("job-1");
    expect(second.claims).toEqual([]);
  });

  it("attaches an assigned task to the live worker this process already started for it", async () => {
    const worker = new FakeWorker([{ state: "running" }]);
    const claimed: ClaimedTask = {
      token: "sess-token",
      workspace: "/ws/task",
      branch: "atask/at-assign",
      target_branch: "main",
    };
    const first = new FakeAtask(
      [snapshot("at-assign", "ready"), snapshot("at-assign", "claimed")],
      claimed,
    );
    const firstOutput = await startAtaskTask(input({ id: "at-assign", timeout_s: 1 }), deps(first, worker));
    expect(firstOutput.status).toBe("running");

    const second = new FakeAtask(
      [snapshot("at-assign", "claimed", { attempt: { workspace: "/ws/task", branch: "atask/at-assign" } })],
      claimed,
      undefined,
      "main",
      "at-assign",
    );
    const output = await startAtaskTask(input({ timeout_s: 1 }), deps(second, worker));

    expect(output.task_id).toBe("at-assign");
    expect(worker.starts).toHaveLength(1);
    expect(output.status).toBe("running");
    expect(output.job_id).toBe("job-1");
  });
});

}
ported3();

// ---- ported from mastra/test/capability/start_atask_task/resume_after_failed_verify.test.ts
function ported4(): void {

/**
 * The resume of a task atask left `verification_failed` — a proof run that died mid-verify (a
 * killed worker, a timed-out check) leaves the task there, and the same claim path as
 * `interrupted` is the only honest way back: its worker may still be alive, and a fresh claim and
 * worker when it is not.
 */

class ScriptedClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

class FakeAtask implements StartTaskAtaskPort {
  readonly claims: string[] = [];
  readonly renews: string[] = [];
  readonly verifies: string[] = [];
  readonly projects: string[] = [];
  private showCall = 0;
  constructor(
    private readonly shown: readonly TaskSnapshot[],
    private readonly projectTargetResult: string | undefined = "main",
  ) {}
  async show(_id: string): Promise<TaskSnapshot> {
    return this.shown[Math.min(this.showCall++, this.shown.length - 1)];
  }
  async claim(id: string): Promise<ClaimedTask> {
    this.claims.push(id);
    return { token: "sess-token", workspace: "/ws/resumed", branch: `atask/${id}`, target_branch: "main" };
  }
  async assign(_project?: string): Promise<never> {
    throw new Error("a named task is never assigned");
  }
  async renew(token: string): Promise<void> {
    this.renews.push(token);
  }
  async verifyComplete(workspace: string): Promise<void> {
    this.verifies.push(workspace);
  }
  async projectTarget(project: string): Promise<string | undefined> {
    this.projects.push(project);
    return this.projectTargetResult;
  }
}

class FakeWorker implements WorkerPort {
  readonly starts: WorkerSpawnRequest[] = [];
  readonly stops: string[] = [];
  private statusCall = 0;
  constructor(
    private readonly statuses: readonly WorkerSpawnStatus[],
    private readonly recordedJob?: string,
  ) {}
  async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
    this.starts.push(request);
    return { job_id: "job-resumed" };
  }
  async status(_jobId: string): Promise<WorkerSpawnStatus> {
    return this.statuses[Math.min(this.statusCall++, this.statuses.length - 1)];
  }
  stop(jobId: string): "killed" | "unknown" {
    this.stops.push(jobId);
    return "killed";
  }
  async find(_taskId: string): Promise<string | undefined> {
    return this.recordedJob;
  }
}

class FakeWt implements WtPort {
  readonly merges: { workspace: string; target?: string }[] = [];
  async merge(workspace: string, target?: string): Promise<string> {
    this.merges.push({ workspace, target });
    return `merged ${workspace}`;
  }
}

class FakeGit implements GitPort {
  async push(): Promise<string> {
    return "pushed";
  }
  async contains(): Promise<boolean> {
    return false;
  }
  async abortRebase(): Promise<RebaseConflict | undefined> {
    return undefined;
  }
}

class FakeGh implements GhPort {
  async createPullRequest(): Promise<string> {
    return "https://github.com/o/r/pull/9";
  }
  async armAutoMerge(): Promise<string> {
    return "armed";
  }
}

const snapshot = (status: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: "at-vf",
  status,
  project: "capability-replicas",
  ...overrides,
});

const deps = (atask: FakeAtask, worker: FakeWorker, wt: FakeWt = new FakeWt()) => ({
  atask,
  worker,
  wt,
  git: new FakeGit(),
  gh: new FakeGh(),
  clock: new ScriptedClock(),
  pollMs: 1_000,
  workspaceExists: async (_path: string) => true,
});

const input = (overrides: Record<string, unknown> = {}) =>
  normalizeInput({ id: "at-vf", timeout_s: 1, ...overrides });

describe("start_atask_task resumes a verification_failed task", () => {
  it("claims a fresh worker for a verification_failed task with no live worker, and lands it", async () => {
    const atask = new FakeAtask([
      snapshot("verification_failed", { attempt: { workspace: "/ws/vf", branch: "atask/at-vf" } }),
      snapshot("complete", { verdict: "2/2 required checks passed" }),
    ]);
    const worker = new FakeWorker([{ state: "exited", exit_code: 0 }]);
    const wt = new FakeWt();

    const output = await startAtaskTask(input({ timeout_s: 60 }), deps(atask, worker, wt));

    expect(atask.claims).toEqual(["at-vf"]);
    expect(worker.starts[0]?.taskId).toBe("at-vf");
    expect(output.status).toBe("settled");
    expect(output.verdict).toBe("2/2 required checks passed");
    expect(output.completion).toEqual({ on_complete: "merge", outcome: "merged" });
    expect(wt.merges).toEqual([{ workspace: "/ws/resumed", target: "main" }]);
  });

  it("attaches to a verification_failed task's live recorded worker and never claims again", async () => {
    const atask = new FakeAtask([
      snapshot("verification_failed", { attempt: { workspace: "/ws/vf", branch: "atask/at-vf" } }),
    ]);
    const worker = new FakeWorker([{ state: "running" }], "job-live");

    const output = await startAtaskTask(input(), deps(atask, worker));

    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
    expect(output.status).toBe("running");
    expect(output.job_id).toBe("job-live");
  });

  it("refuses a verification_failed task whose live worker records no worktree, naming the state", async () => {
    const atask = new FakeAtask([
      snapshot("verification_failed", { attempt: { workspace: undefined, branch: "atask/at-vf" } }),
    ]);
    const worker = new FakeWorker([{ state: "running" }], "job-live");

    const output = await startAtaskTask(input(), deps(atask, worker));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("at-vf");
    expect(output.error).toContain("no worktree");
    expect(atask.claims).toEqual([]);
  });
});

}
ported4();

// ---- ported from mastra/test/capability/start_atask_task/unstored_claim.test.ts
function ported5(): void {

/**
 * A claim atask recorded but never gave a worktree cannot be attached to, and its token was never
 * printed, so nobody can release it: the lease is the only thing that frees the task, and atask
 * grants such a claim its short claim window rather than the whole lease. These tests hold that
 * the call waits that window out and claims the task instead of refusing one that becomes
 * claimable moments later.
 */

/** A clock that never waits in real time: each sleep moves `time` by the sleep. */
class ScriptedClock implements Clock {
  time = Date.UTC(2026, 0, 2, 9, 0, 0);
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

/** Answers each show with its scripted result, repeating the last one, and records every call. */
class FakeAtask implements StartTaskAtaskPort {
  readonly claims: string[] = [];
  readonly renews: string[] = [];
  readonly verifies: string[] = [];
  readonly projects: string[] = [];
  showCalls = 0;
  private showCall = 0;

  constructor(
    private readonly shown: readonly TaskSnapshot[],
    private readonly claimed: ClaimedTask = {
      token: "sess-token",
      workspace: "/ws/task",
      branch: "atask/at-1",
      target_branch: "main",
    },
  ) {}

  async show(id: string): Promise<TaskSnapshot> {
    this.showCalls += 1;
    return (this.shown[Math.min(this.showCall++, this.shown.length - 1)] as TaskSnapshot) ?? { id, status: "ready" };
  }

  async claim(id: string): Promise<ClaimedTask> {
    this.claims.push(id);
    return this.claimed;
  }

  async assign(): Promise<ClaimedTask & { readonly id: string }> {
    return { ...this.claimed, id: "at-assigned" };
  }

  async renew(token: string): Promise<void> {
    this.renews.push(token);
  }

  async verifyComplete(workspace: string): Promise<void> {
    this.verifies.push(workspace);
  }

  async projectTarget(): Promise<string | undefined> {
    return "main";
  }
}

class FakeWorker implements WorkerPort {
  readonly starts: WorkerSpawnRequest[] = [];
  readonly stops: string[] = [];
  private statusCall = 0;
  findResult: string | undefined = undefined;

  constructor(private readonly statuses: readonly WorkerSpawnStatus[] = [{ state: "running" }]) {}

  async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
    this.starts.push(request);
    return { job_id: "job-1" };
  }

  async status(_jobId: string): Promise<WorkerSpawnStatus> {
    return this.statuses[Math.min(this.statusCall++, this.statuses.length - 1)] as WorkerSpawnStatus;
  }

  stop(jobId: string): "killed" | "unknown" {
    this.stops.push(jobId);
    return "killed";
  }

  async find(_taskId: string): Promise<string | undefined> {
    return this.findResult;
  }
}

class FakeWt implements WtPort {
  readonly merges: { workspace: string; target?: string }[] = [];
  async merge(workspace: string, target?: string): Promise<string> {
    this.merges.push({ workspace, target });
    return `merged ${workspace}`;
  }
}

class FakeGit implements GitPort {
  async push(): Promise<string> {
    return "pushed";
  }
  async contains(): Promise<boolean> {
    return false;
  }
  async abortRebase(): Promise<RebaseConflict | undefined> {
    return undefined;
  }
}

class FakeGh implements GhPort {
  async createPullRequest(): Promise<string> {
    return "https://github.com/o/r/pull/9";
  }
  async armAutoMerge(_workspace: string, url: string): Promise<string> {
    return `armed ${url}`;
  }
}

const deps = (atask: FakeAtask, worker: FakeWorker, clock: ScriptedClock, wt = new FakeWt()) => ({
  atask,
  worker,
  wt,
  git: new FakeGit(),
  gh: new FakeGh(),
  clock,
  pollMs: 1,
  workspaceExists: async (_path: string) => true,
});

const input = (overrides: Record<string, unknown> = {}) => normalizeInput({ ...overrides });

const snapshot = (id: string, status: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id,
  status,
  ...overrides,
});

describe("start_atask_task and a claim whose worktree was never recorded", () => {
  it("waits the claim window out and claims the task instead of refusing it", async () => {
    const clock = new ScriptedClock();
    const unstored = { lease_expires_ms: clock.time + 120_000, lease_active: true };
    const atask = new FakeAtask([
      snapshot("at-unstored", "claimed", { project: "ai-task", attempt: unstored }),
      snapshot("at-unstored", "claimed", { project: "ai-task", attempt: unstored }),
      snapshot("at-unstored", "interrupted", { project: "ai-task", attempt: { lease_active: false } }),
      snapshot("at-unstored", "claimed", { project: "ai-task", attempt: { workspace: "/ws/task", branch: "atask/at-unstored" } }),
      snapshot("at-unstored", "complete", { project: "ai-task", verdict: "the retry finished the work" }),
    ]);
    const worker = new FakeWorker([
      { state: "running" },
      { state: "running" },
      { state: "running" },
      { state: "exited", exit_code: 0 },
    ]);

    const output = await startAtaskTask(input({ id: "at-unstored" }), deps(atask, worker, clock));

    expect(output.status).toBe("settled");
    expect(atask.claims).toEqual(["at-unstored"]);
    expect(worker.starts).toHaveLength(1);
    expect(atask.showCalls).toBeGreaterThanOrEqual(3);
    expect(atask.verifies).toEqual([]);
    expect(output.completion?.outcome).toBe("merged");
  });

  it("never spawns for a claim an alive worker holds, worktree or not", async () => {
    const clock = new ScriptedClock();
    const atask = new FakeAtask([
      snapshot("at-held", "claimed", { attempt: { lease_expires_ms: clock.time + 120_000, lease_active: true } }),
    ]);
    const worker = new FakeWorker([{ state: "running" }]);
    worker.findResult = "herdr:/logs/atask-at-held";

    const output = await startAtaskTask(input({ id: "at-held" }), deps(atask, worker, clock));

    expect(output.status).toBe("refused");
    expect(output.error).toContain("no worktree");
    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
  });

  it("refuses, naming when the claim lapses, when it outlasts the wait", async () => {
    const clock = new ScriptedClock();
    const expires = clock.time + 30 * 60_000;
    const atask = new FakeAtask([
      snapshot("at-long", "claimed", { attempt: { lease_expires_ms: expires, lease_active: true } }),
    ]);
    const worker = new FakeWorker();

    const output = await startAtaskTask(input({ id: "at-long" }), {
      ...deps(atask, worker, clock),
      pollMs: UNSTORED_CLAIM_WAIT_MS,
    });

    expect(output.status).toBe("refused");
    expect(output.error).toContain(new Date(expires).toISOString());
    expect(output.error).toContain("call again after it");
    expect(clock.time - Date.UTC(2026, 0, 2, 9, 0, 0)).toBeLessThanOrEqual(UNSTORED_CLAIM_WAIT_MS + 60_000);
    expect(atask.claims).toEqual([]);
    expect(worker.starts).toEqual([]);
  });
});

}
ported5();


// ---- helpers shared by the tests below
/** Polls `check` until it stops throwing; the failure of the last attempt is the timeout's message. */
async function eventually(check: () => Promise<void> | void, timeoutMs = 8_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(intervalMs);
    }
  }
}

class StepClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

// ---- ported from mastra/test/capability/start_atask_task/claim_timeout.test.ts
/**
 * A stand-in `atask` on PATH that behaves like the real claim: it records the attempt and its lease
 * first (`claimed`), builds the worktree (`worktree`), and prints the session token only at the very
 * end. A claim killed in between leaves `claimed` with no `worktree` and a token nobody saw.
 */
const FAKE_ATASK = `#!/bin/sh
for last; do :; done
case "$*" in
  *"claim release"*)
    echo "released $last" >> "$FAKE_ATASK_DIR/events"
    echo '{"ok":true,"result":{"released":true}}'
    ;;
  *claim*)
    echo claimed >> "$FAKE_ATASK_DIR/events"
    sleep 1
    echo worktree >> "$FAKE_ATASK_DIR/events"
    echo '{"ok":true,"target_branch":"main","result":{"token":"sess-fake","workspace":"/ws/at-1","branch":"atask/at-1"}}'
    ;;
esac
`;

/** The generic per-call bound shrunk to 300 ms: far shorter than the fake claim's second of worktree building. */
const genericBoundRun: RunAtask = (argv, options) =>
  runAtask(argv, { ...options, timeoutMs: options?.timeoutMs ?? 300 });

describe("start_atask_task claim that outlives the generic atask bound", () => {
  let directory: string;
  let originalPath: string | undefined;

  const events = async (): Promise<string[]> =>
    (await readFile(join(directory, "events"), "utf8")).split("\n").filter((line) => line !== "");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fake-atask-"));
    await writeFile(join(directory, "atask"), FAKE_ATASK);
    await chmod(join(directory, "atask"), 0o755);
    await writeFile(join(directory, "events"), "");
    originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    process.env.FAKE_ATASK_DIR = directory;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_ATASK_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("waits for the claim to finish instead of killing it mid-worktree", async () => {
    const claimed = await cliStartTaskAtask(genericBoundRun).claim("at-1");

    expect(claimed).toEqual({ token: "sess-fake", workspace: "/ws/at-1", branch: "atask/at-1", target_branch: "main" });
    expect(await events()).toEqual(["claimed", "worktree"]);
  }, 20_000);

  it("leaves a given-up claim running and releases it with the token it prints", async () => {
    const failure = await cliStartTaskAtask(genericBoundRun, 300)
      .claim("at-1")
      .then(() => undefined, (error: unknown) => error);

    await eventually(async () => {
      expect(await events()).toEqual(["claimed", "worktree", "released sess-fake"]);
    });
    expect(failure).toBeInstanceOf(AtaskError);
    expect(failure).toMatchObject({ code: "TIMEOUT" });
  }, 20_000);

  it("stops waiting when the call is aborted, leaves the claim running and still releases it", async () => {
    const controller = new AbortController();
    const pending = cliStartTaskAtask(genericBoundRun, 60_000, controller.signal)
      .claim("at-1")
      .then(() => undefined, (error: unknown) => error);
    await eventually(async () => expect(await events()).toEqual(["claimed"]));
    controller.abort(new Error("caller gave up"));

    const failure = await pending;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("caller gave up");
    await eventually(async () => {
      expect(await events()).toEqual(["claimed", "worktree", "released sess-fake"]);
    });
  }, 20_000);

  it("kills a non-claim atask call on abort and rejects with the reason", async () => {
    const controller = new AbortController();
    const run = runAtask(["--json", "show", "at-1"], { signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(run).rejects.toThrow("stop");
  });
});

// ---- atask CLI mechanics
describe("atask CLI runner and envelope", () => {
  /** A directory holding a stand-in `atask` that runs `body`, to put first on the runner's search path. */
  const standIn = async (body: string): Promise<string> => {
    const bin = await mkdtemp(join(tmpdir(), "atask-bin-"));
    const script = join(bin, "atask");
    await writeFile(script, `#!/bin/sh\nPATH=/bin:/usr/bin:$PATH\n${body}\n`);
    await chmod(script, 0o755);
    return bin;
  };

  it("kills a running child on abort and rejects with the abort reason", async () => {
    const controller = new AbortController();
    const pending = ataskRunnerIn(undefined, await standIn('exec sh "$@"'))(["-c", "sleep 5"], { signal: controller.signal, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(new Error("cancelled")), 30);
    const started = Date.now();
    await expect(pending).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already"));
    await expect(ataskRunnerIn(undefined, await standIn("exit 0"))(["--json"], { signal: controller.signal })).rejects.toThrow("already");
  });

  it("answers a missing binary as spawnError, which the envelope names", async () => {
    const run = await ataskRunnerIn(undefined, "/nonexistent/atask-bin")(["--json", "show", "x"]);
    expect(run.spawnError).toBeDefined();
    expect(() => ataskEnvelope(run, "show")).toThrow("atask CLI is not runnable");
  });

  it("runs the binary in the default cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atask-cwd-"));
    try {
      const run = await ataskRunnerIn(directory, await standIn("pwd"))([]);
      expect(run.stdout.trim().endsWith(basename(directory))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes an ok envelope, raises atask's own error, and names non-JSON output", () => {
    expect(ataskEnvelope({ code: 0, stdout: '{"ok":true,"result":{"a":1},"target_branch":"main"}', stderr: "" }, "x"))
      .toMatchObject({ ok: true, target_branch: "main" });
    expect(() => ataskEnvelope({ code: 1, stdout: '{"ok":false,"error":{"code":"CONFLICT","message":"held"}}', stderr: "" }, "claim"))
      .toThrow("held");
    try {
      ataskEnvelope({ code: 1, stdout: '{"ok":false,"error":{"code":"CONFLICT","message":"held"}}', stderr: "" }, "claim");
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFLICT", call: "claim" });
    }
    expect(() => ataskEnvelope({ code: 2, stdout: "oops", stderr: "boom\n" }, "show")).toThrow("non-JSON output (exit 2): boom");
    expect(() => ataskEnvelope({ code: 3, stdout: "null", stderr: "bad" }, "show")).toThrow("bad");
  });

  it("treats complete and verified as the settled statuses", () => {
    expect(isSettledTaskStatus("complete")).toBe(true);
    expect(isSettledTaskStatus("verified")).toBe(true);
    expect(isSettledTaskStatus("claimed")).toBe(false);
  });

  it("does not release a claim whose run printed no token", async () => {
    const calls: string[][] = [];
    const run: RunAtask = async (argv, options) => {
      calls.push([...argv]);
      if (options?.onTimeout === "leave") {
        return { code: 1, stdout: "", stderr: "", stillRunning: Promise.resolve({ code: 1, stdout: '{"ok":false,"error":{"message":"no"}}', stderr: "" }) };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };
    await expect(runClaim(run, ["--json", "claim", "at-1"], 10)).rejects.toThrow("did not finish within");
    await Bun.sleep(20);
    expect(calls).toEqual([["--json", "claim", "at-1"]]);
  });
});

// ---- the atask port over a scripted runner
describe("cliStartTaskAtask", () => {
  const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, ...(body as object) }), stderr: "" });

  it("reads a shown task: verdict from the complete run, lease as epoch milliseconds, attempt facts", async () => {
    const seen: (readonly string[])[] = [];
    const port = cliStartTaskAtask(async (argv) => {
      seen.push(argv);
      return ok({
        result: {
          id: "at-1",
          status: "claimed",
          title: "T",
          project: "p",
          completed_revision: "abc",
          created_cwd: "/repo",
          verification: { complete: { summary: "3/3 passed" }, proof: { summary: "other" } },
          attempt: { workspace: "/ws", branch: "atask/at-1", token: "tok", lease_expires_at: "2026-01-02T09:00:00Z", lease_active: true },
        },
      });
    });
    const snapshot = await port.show("at-1");
    expect(seen).toEqual([["--json", "show", "at-1"]]);
    expect(snapshot).toMatchObject({
      id: "at-1",
      status: "claimed",
      title: "T",
      project: "p",
      verdict: "3/3 passed",
      completedRevision: "abc",
      createdCwd: "/repo",
      attempt: { workspace: "/ws", branch: "atask/at-1", token: "tok", lease_expires_ms: Date.UTC(2026, 0, 2, 9), lease_active: true },
    });
  });

  it("refuses a show whose result is not a task", async () => {
    const port = cliStartTaskAtask(async () => ok({ result: { id: 3 } }));
    await expect(port.show("at-1")).rejects.toThrow("atask show did not return the task");
    expect(snapshotFromShow({ result: { id: "a", status: "ready" } })).toEqual({
      id: "a",
      status: "ready",
      title: undefined,
      project: undefined,
      verdict: undefined,
      completedRevision: undefined,
      createdCwd: undefined,
      attempt: undefined,
    });
  });

  it("claims by id and by assignment, resolving a project name to its id", async () => {
    const seen: (readonly string[])[] = [];
    const port = cliStartTaskAtask(async (argv) => {
      seen.push(argv);
      if (argv.includes("projects")) {
        return ok({ result: [{ id: "proj-aaa", name: "Home Lab", root_path: "/home/lab" }] });
      }
      if (argv.at(-1) === "claim") {
        return ok({ result: { token: "t2", workspace: "/ws2", branch: "atask/at-9", target_branch: "feat/x", task: { id: "at-9" } } });
      }
      return ok({ target_branch: "main", result: { token: "t1", workspace: "/ws1", branch: "atask/at-1" } });
    });
    expect(await port.claim("at-1")).toEqual({ token: "t1", workspace: "/ws1", branch: "atask/at-1", target_branch: "main" });
    expect(await port.assign("home-lab")).toEqual({
      id: "at-9",
      token: "t2",
      workspace: "/ws2",
      branch: "atask/at-9",
      target_branch: "feat/x",
    });
    expect(seen).toContainEqual(["--json", "--project", "proj-aaa", "claim"]);
    await port.assign(undefined);
    expect(seen.at(-1)).toEqual(["--json", "claim"]);
  });

  it("rejects a claim that lacks a token, workspace or branch, and an assignment without a task id", async () => {
    await expect(cliStartTaskAtask(async () => ok({ result: { token: "t", workspace: "/w" } })).claim("at-1"))
      .rejects.toThrow("did not return a workspace");
    await expect(cliStartTaskAtask(async () => ok({ result: { token: "t", workspace: "/w", branch: "b" } })).assign())
      .rejects.toThrow("task.id");
  });

  it("renews, verifies in the task worktree with the long bound, and reads a project's target", async () => {
    const calls: { argv: readonly string[]; options?: { cwd?: string; timeoutMs?: number } }[] = [];
    const port = cliStartTaskAtask(async (argv, options) => {
      calls.push({ argv, options });
      if (argv.includes("project")) return ok({ result: { target_branch: "feat/z" } });
      if (argv.includes("projects")) return ok({ result: [] });
      return ok({ result: {} });
    });
    await port.renew("tok");
    await port.verifyComplete("/ws");
    expect(await port.projectTarget("proj-1")).toBe("feat/z");
    expect(calls[0]?.argv).toEqual(["--json", "claim", "renew", "tok"]);
    expect(calls[1]?.argv).toEqual(["--json", "verify", "complete"]);
    expect(calls[1]?.options).toMatchObject({ cwd: "/ws", timeoutMs: 20 * 60_000 });
    expect(calls[2]?.argv).toEqual(["--json", "--project", "proj-1", "project"]);
  });

  it("fails verifyComplete with atask's own message", async () => {
    const port = cliStartTaskAtask(async () => ({
      code: 1,
      stdout: '{"ok":false,"error":{"code":"VERIFY","message":"proof failed"}}',
      stderr: "",
    }));
    await expect(port.verifyComplete("/ws")).rejects.toThrow("proof failed");
  });
});

// ---- project name resolution
describe("project resolution", () => {
  const projects = [
    { id: "proj-a", name: "Capability Replicas" },
    { id: "proj-b", name: "capability-replicas", root_path: "/work/capability-replicas" },
    { id: "proj-c", name: "Other", root_path: "/work/other" },
  ];

  it("passes an id through and picks the one project with a checkout for a shared name", () => {
    expect(pickProject(projects, "proj-zzz")).toBe("proj-zzz");
    expect(pickProject(projects, "capability replicas")).toBe("proj-b");
    expect(pickProject(projects, "other")).toBe("proj-c");
    expect(pickProject(projects, "nothing-matches")).toBe("nothing-matches");
    expect(pickProject(projects, "---")).toBe("---");
  });

  it("uses the hint to choose between several checkouts and leaves an ambiguous name unchanged", () => {
    const shared = [
      { id: "proj-1", name: "x", root_path: "/a/x" },
      { id: "proj-2", name: "x", root_path: "/b/x" },
    ];
    expect(pickProject(shared, "x")).toBe("x");
    expect(pickProject(shared, "x", "/b/x/src")).toBe("proj-2");
  });

  it("reads the listing envelope, rejects a failed one, and falls back to the name when unreadable", async () => {
    expect(projectsFromList(JSON.stringify({ ok: true, result: [{ id: "proj-1", name: "n", root_path: "" }, { id: 3 }] })))
      .toEqual([{ id: "proj-1", name: "n" }]);
    expect(() => projectsFromList(JSON.stringify({ ok: false, error: { message: "down" } }))).toThrow("down");
    expect(() => projectsFromList(JSON.stringify({ ok: true, result: {} }))).toThrow("no project list");
    expect(await resolveProject("some name", async () => {
      throw new Error("registry down");
    })).toBe("some name");
  });
});

// ---- the landing ports over a scripted program runner
describe("live landing ports", () => {
  type Call = { binary: string; argv: readonly string[]; cwd?: string };
  const scripted = (answer: (call: Call) => { code?: number; stdout?: string; stderr?: string; spawnError?: string }) => {
    const calls: Call[] = [];
    const program: RunProgram = async (binary, argv, options) => {
      const call = { binary, argv, cwd: options.cwd };
      calls.push(call);
      const result = answer(call);
      return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", spawnError: result.spawnError };
    };
    return { calls, ports: liveLandingPorts(undefined, program) };
  };

  it("merges with the exact wt argv from the task worktree, and names a failure with wt's own text", async () => {
    const ok = scripted(() => ({ stdout: "merged\n" }));
    expect(await ok.ports.wt.merge("/ws", "main")).toBe("merged");
    expect(ok.calls).toEqual([{ binary: "wt", argv: ["-y", "merge", "main", "--no-squash", "--no-remove"], cwd: "/ws" }]);
    const failing = scripted(() => ({ code: 1, stderr: "not fast-forwardable" }));
    await expect(failing.ports.wt.merge("/ws")).rejects.toThrow("wt merge exited 1: not fast-forwardable");
    expect(failing.calls[0]?.argv).toEqual(["-y", "merge", "--no-squash", "--no-remove"]);
    const missing = scripted(() => ({ spawnError: "ENOENT" }));
    await expect(missing.ports.wt.merge("/ws")).rejects.toThrow("wt merge could not start: ENOENT");
  });

  it("answers containment from merge-base's exit code: 0 yes, 1 no, anything else an error", async () => {
    for (const [code, expected] of [[0, true], [1, false]] as const) {
      const { ports, calls } = scripted(() => ({ code }));
      expect(await ports.git.contains("/repo", "main", "atask/at-1")).toBe(expected);
      expect(calls[0]).toEqual({ binary: "git", argv: ["merge-base", "--is-ancestor", "atask/at-1", "main"], cwd: "/repo" });
    }
    await expect(scripted(() => ({ code: 128, stderr: "fatal" })).ports.git.contains("/repo", "main", "x")).rejects.toThrow("exited 128: fatal");
    await expect(scripted(() => ({ spawnError: "ENOENT" })).ports.git.contains("/repo", "main", "x")).rejects.toThrow("could not start");
  });

  it("pushes, opens a pull request against the target, and arms auto-merge", async () => {
    const { ports, calls } = scripted((call) => ({ stdout: call.binary === "gh" && call.argv[1] === "create" ? "https://github.com/o/r/pull/3\n" : "" }));
    await ports.git.push("/ws", "atask/at-1");
    const url = await ports.gh.createPullRequest("/ws", { branch: "atask/at-1", title: "T", body: "B", base: "feat/x" });
    await ports.gh.createPullRequest("/ws", { branch: "atask/at-1", title: "T", body: "B" });
    await ports.gh.armAutoMerge("/ws", "https://github.com/o/r/pull/3");
    expect(url).toBe("https://github.com/o/r/pull/3");
    expect(calls.map((call) => [call.binary, ...call.argv])).toEqual([
      ["git", "push", "-u", "origin", "atask/at-1"],
      ["gh", "pr", "create", "--head", "atask/at-1", "--base", "feat/x", "--title", "T", "--body", "B"],
      ["gh", "pr", "create", "--head", "atask/at-1", "--title", "T", "--body", "B"],
      ["gh", "pr", "merge", "https://github.com/o/r/pull/3", "--auto", "--squash"],
    ]);
  });

  describe("abortRebase", () => {
    let directory: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "rebase-"));
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("answers nothing when no rebase is in progress and runs no abort", async () => {
      const { ports, calls } = scripted((call) => ({ stdout: join(directory, String(call.argv[3]).replace("/onto", "-onto")) }));
      expect(await ports.git.abortRebase("/ws")).toBeUndefined();
      expect(calls.some((call) => call.argv.includes("--abort"))).toBe(false);
    });

    it("reads the onto commit and the unmerged files, then aborts the rebase", async () => {
      await writeFile(join(directory, "onto"), "4f2c9e1d0b\n");
      const { ports, calls } = scripted((call) => {
        if (call.argv[0] === "rev-parse") return { stdout: join(directory, "onto") };
        if (call.argv[0] === "diff") return { stdout: "src/a.ts\0README.md\0" };
        return {};
      });
      expect(await ports.git.abortRebase("/ws")).toEqual({ onto: "4f2c9e1d0b", files: ["src/a.ts", "README.md"] });
      expect(calls.at(-1)?.argv).toEqual(["rebase", "--abort"]);
    });

    it("throws when the abort itself fails", async () => {
      await writeFile(join(directory, "onto"), "abc");
      const { ports } = scripted((call) => {
        if (call.argv[0] === "rev-parse") return { stdout: join(directory, "onto") };
        if (call.argv[0] === "rebase") return { code: 128, stderr: "fatal" };
        return {};
      });
      await expect(ports.git.abortRebase("/ws")).rejects.toThrow("git rebase --abort exited 128");
    });
  });
});

// ---- the worker script, run by a real sh against trivial commands
describe("worker script", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "worker-script-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const run = async (options: { command: string; timeoutSeconds: number; output: "tee" | "file"; after?: string }) => {
    const logPath = join(directory, "output.log");
    const scriptPath = join(directory, "run.sh");
    await writeFile(logPath, "");
    await writeFile(scriptPath, workerScript({ ...options, logPath }));
    const stdout = await new Promise<string>((resolve) => {
      execFile("sh", [scriptPath], (_error, out) => resolve(out));
    });
    return { log: await readFile(logPath, "utf8"), stdout };
  };

  it("logs the command's output and its own exit code (file mode)", async () => {
    const { log } = await run({ command: "echo hello; exit 3", timeoutSeconds: 30, output: "file" });
    expect(log).toContain("hello");
    expect(log).toMatch(new RegExp(`${EXIT_MARKER}3\\s*$`));
  });

  it("tees the output to the pane and the log, then runs the closing command last (tee mode)", async () => {
    const { log, stdout } = await run({
      command: "echo visible; exit 0",
      timeoutSeconds: 30,
      output: "tee",
      after: "echo closing-the-pane",
    });
    expect(stdout).toContain("visible");
    expect(stdout.trim().endsWith("closing-the-pane")).toBe(true);
    expect(log).toContain("visible");
    expect(log).toMatch(new RegExp(`${EXIT_MARKER}0\\s*$`));
  });

  it("quotes a command that carries single quotes and spaces", async () => {
    const { log } = await run({ command: `echo "it's here"`, timeoutSeconds: 30, output: "file" });
    expect(log).toContain("it's here");
  });

  it("kills a command that outlives its budget and records a nonzero exit", async () => {
    const started = Date.now();
    const { log } = await run({ command: "sleep 30", timeoutSeconds: 1, output: "file" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const code = Number(log.match(new RegExp(`${EXIT_MARKER}(-?\\d+)\\s*$`))?.[1]);
    expect(code).not.toBe(0);
    expect(Number.isNaN(code)).toBe(false);
  }, 20_000);

  it("embeds the budget and never a hard-coded herdr binary", () => {
    const script = workerScript({ command: "x", timeoutSeconds: 90, logPath: "/l", output: "tee" });
    expect(script).toContain("N=90");
    expect(script).not.toContain("herdr");
  });
});

// ---- the disk worker: herdr pane launcher (ported from tools/bash/herdr-worker.test.ts)
/** A scripted herdr: records every call and answers splits and pane lookups from memory. */
class FakeHerdr {
  readonly calls: string[][] = [];
  readonly panes = new Set<string>();
  private next = 1;

  readonly call: HerdrCall = async (binary, args) => this.handle(binary, args);

  protected async handle(_binary: string, args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === "pane" && args[1] === "split") {
      const id = `pane-${this.next++}`;
      this.panes.add(id);
      return JSON.stringify({ result: { pane: { pane_id: id } } });
    }
    if (args[0] === "pane" && args[1] === "get" && !this.panes.has(args[2] ?? "")) {
      throw new Error("pane not found");
    }
    if (args[0] === "pane" && args[1] === "close") this.panes.delete(args[2] ?? "");
    return "";
  }
}

describe("herdr pane worker", () => {
  let root: string;
  let legacy: string;
  let made = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "disk-worker-"));
    legacy = await mkdtemp(join(tmpdir(), "disk-worker-legacy-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(legacy, { recursive: true, force: true });
  });

  function environment(herdr: FakeHerdr, overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment {
    return {
      herdr: async () => "/fake/herdr",
      paneId: () => "parent",
      logDir: () => root,
      legacyDirs: () => [legacy],
      makeDir: async (parent, prefix) => {
        const dir = join(parent, `${prefix}${made++}`);
        await mkdir(dir, { recursive: true });
        return dir;
      },
      call: herdr.call,
      ...overrides,
    };
  }
  const dirOf = (jobId: string): string => jobId.slice(jobId.indexOf(":") + 1);

  it("splits a pane off the caller, runs the command there, and reports it running", async () => {
    const herdr = new FakeHerdr();
    const port = diskWorkerPort(environment(herdr));

    const started = await port.start({ command: "echo hi", cwd: "/ws/task", taskId: "at-1", timeoutSeconds: 90 });

    expect(started.job_id.startsWith("herdr:")).toBe(true);
    expect(started.job_id).toContain("atask-at-1-");
    expect((await port.status(started.job_id)).state).toBe("running");
    const submitted = herdr.calls.find((call) => call[1] === "run")?.[3] ?? "";
    const script = await readFile(join(dirOf(started.job_id), "run.sh"), "utf8");
    expect(submitted.startsWith("sh ")).toBe(true);
    expect(script).toContain("N=90");
    expect(script).toContain("echo hi");
    expect(script).toContain(EXIT_MARKER);
    expect(script).toContain("'/fake/herdr' pane close 'pane-1'");
    expect(herdr.calls[0]).toContain("--cwd");
    expect(herdr.calls[0]).toContain("/ws/task");
    expect(await port.find("at-1")).toBe(started.job_id);
  });

  it("submits a short line to the pane whatever the worker command's length", async () => {
    // The real pane refuses a line over 1024 bytes in canonical mode (`pane_send_failed`), and a
    // worker command carries a whole prompt.
    class LengthLimitedHerdr extends FakeHerdr {
      protected override async handle(binary: string, args: readonly string[]): Promise<string> {
        const line = args[0] === "pane" && args[1] === "run" ? (args[3] ?? "") : "";
        if (line.length > 1024) throw new Error(`herdr failed: ${line.length}-byte line over the canonical limit`);
        return super.handle(binary, args);
      }
    }
    const herdr = new LengthLimitedHerdr();
    const port = diskWorkerPort(environment(herdr));
    const longPrompt = "x".repeat(2000);

    const started = await port.start({ command: `omp -p '${longPrompt}'`, taskId: "at-long", timeoutSeconds: 60 });

    const submitted = herdr.calls.find((call) => call[1] === "run")?.[3] ?? "";
    expect(submitted.length).toBeLessThanOrEqual(1024);
    expect(await readFile(join(dirOf(started.job_id), "run.sh"), "utf8")).toContain(longPrompt);
  });

  it("reads the exit marker the pane appends and reports the command's own code", async () => {
    const port = diskWorkerPort(environment(new FakeHerdr()));
    const started = await port.start({ command: "false", taskId: "at-2", timeoutSeconds: 30 });
    await writeFile(join(dirOf(started.job_id), "output.log"), `boom\n${EXIT_MARKER}7\n`, "utf8");

    const status = await port.status(started.job_id);

    expect(status.state).toBe("exited");
    expect(status.exit_code).toBe(7);
    expect(status.output_tail).toContain("boom");
  });

  it("reports killed when the pane is gone and no exit marker was written", async () => {
    const herdr = new FakeHerdr();
    const port = diskWorkerPort(environment(herdr));
    const started = await port.start({ command: "sleep 9", taskId: "at-3", timeoutSeconds: 30 });
    herdr.panes.clear();

    expect((await port.status(started.job_id)).state).toBe("killed");
  });

  it("closes the pane when stopped", async () => {
    const herdr = new FakeHerdr();
    const port = diskWorkerPort(environment(herdr));
    const started = await port.start({ command: "sleep 9", taskId: "at-4", timeoutSeconds: 30 });
    expect(port.stop(started.job_id)).toBe("killed");
    await port.closing;

    expect(herdr.panes.size).toBe(0);
    expect(herdr.calls.find((call) => call[1] === "close")?.[2]).toBe("pane-1");
  });

  it("closes the fresh pane and rethrows when the pane refuses the command", async () => {
    class RefusingHerdr extends FakeHerdr {
      protected override async handle(binary: string, args: readonly string[]): Promise<string> {
        if (args[0] === "pane" && args[1] === "run") throw new Error("pane_send_failed");
        return super.handle(binary, args);
      }
    }
    const herdr = new RefusingHerdr();
    const port = diskWorkerPort(environment(herdr));
    await expect(port.start({ command: "x", taskId: "at-5", timeoutSeconds: 30 })).rejects.toThrow("pane_send_failed");
    expect(herdr.panes.size).toBe(0);
  });

  it("finds nothing for a task that was never started, and an unknown job id is unknown", async () => {
    const port = diskWorkerPort(environment(new FakeHerdr()));
    expect(await port.find("at-missing")).toBeUndefined();
    expect(await port.status("job-1")).toEqual({ state: "unknown" });
    expect(port.stop("job-1")).toBe("unknown");
  });

  it("finds the newest run of a task, not an arbitrary one", async () => {
    const port = diskWorkerPort(environment(new FakeHerdr()));
    const { utimes } = await import("node:fs/promises");
    for (const [name, seconds] of [["atask-at-7-zzz", 1_000], ["atask-at-7-aaa", 2_000], ["atask-at-7-mmm", 500], ["atask-at-70-new", 9_000]] as const) {
      await mkdir(join(root, name));
      await utimes(join(root, name), seconds, seconds);
    }
    expect(await port.find("at-7")).toBe(`herdr:${join(root, "atask-at-7-aaa")}`);
  });

  it("also finds a pane run the Mastra twin started in the legacy directory", async () => {
    const port = diskWorkerPort(environment(new FakeHerdr()));
    await mkdir(join(legacy, "atask-at-8-abc123"));
    expect(await port.find("at-8")).toBe(`herdr:${join(legacy, "atask-at-8-abc123")}`);
  });
});

// ---- the disk worker: detached process launcher
describe("detached process worker", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proc-worker-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts the script detached in the task directory when there is no herdr pane, and tracks it by pid", async () => {
    const spawned: { script: string; cwd?: string }[] = [];
    const killed: number[] = [];
    let alive = true;
    const port = diskWorkerPort({
      herdr: async () => undefined,
      paneId: () => undefined,
      logDir: () => root,
      legacyDirs: () => [],
      spawnDetached: async (script, cwd) => {
        spawned.push({ script, cwd });
        return 4242;
      },
      pidAlive: (pid) => alive && pid === 4242,
      killGroup: (pid) => killed.push(pid),
    });

    const started = await port.start({ command: "echo hi", cwd: "/ws/task", taskId: "at-1", timeoutSeconds: 30 });

    expect(started.job_id.startsWith("proc:")).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cwd).toBe("/ws/task");
    expect((await port.status(started.job_id)).state).toBe("running");
    expect(await port.find("at-1")).toBe(started.job_id);

    expect(port.stop(started.job_id)).toBe("killed");
    await port.closing;
    expect(killed).toEqual([4242]);

    alive = false;
    expect((await port.status(started.job_id)).state).toBe("killed");
    await writeFile(join(started.job_id.slice("proc:".length), "output.log"), `done\n${EXIT_MARKER}0\n`);
    expect(await port.status(started.job_id)).toMatchObject({ state: "exited", exit_code: 0 });
  });

  it("runs a real detached worker to completion and reads its exit from the log directory", async () => {
    const port = diskWorkerPort({ herdr: async () => undefined, paneId: () => undefined, logDir: () => root, legacyDirs: () => [] });
    const cwd = await mkdtemp(join(tmpdir(), "proc-worker-cwd-"));
    try {
      const started = await port.start({ command: "pwd; echo worked; exit 5", cwd, taskId: "at-real", timeoutSeconds: 30 });
      await eventually(async () => {
        const status = await port.status(started.job_id);
        expect(status.state).toBe("exited");
        expect(status.exit_code).toBe(5);
        expect(status.output_tail).toContain("worked");
        expect(status.output_tail).toContain("proc-worker-cwd-");
      });
      // A fresh port over the same directory — as a later omp process would be — finds and reads the run.
      const later = diskWorkerPort({ herdr: async () => undefined, paneId: () => undefined, logDir: () => root, legacyDirs: () => [] });
      const found = await later.find("at-real");
      expect(found).toBe(started.job_id);
      expect((await later.status(found ?? "")).exit_code).toBe(5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("stops a real running worker and reports it killed", async () => {
    const port = diskWorkerPort({ herdr: async () => undefined, paneId: () => undefined, logDir: () => root, legacyDirs: () => [] });
    const started = await port.start({ command: "sleep 30", taskId: "at-kill", timeoutSeconds: 60 });
    await eventually(async () => expect((await port.status(started.job_id)).state).toBe("running"));
    port.stop(started.job_id);
    await port.closing;
    await eventually(async () => expect((await port.status(started.job_id)).state).toBe("killed"));
  }, 20_000);
});

// ---- the lifecycle: what the port added
describe("lifecycle additions", () => {
  class Atask implements StartTaskAtaskPort {
    shows = 0;
    constructor(private readonly seq: TaskSnapshot[], private readonly delayMs = 0) {}
    async show(): Promise<TaskSnapshot> {
      if (this.delayMs > 0) await Bun.sleep(this.delayMs);
      return this.seq[Math.min(this.shows++, this.seq.length - 1)]!;
    }
    async claim(): Promise<ClaimedTask> {
      return { token: "tok", workspace: "/ws/task", branch: "atask/at-1", target_branch: "feat/target" };
    }
    async assign(): Promise<never> {
      throw new Error("not assigned");
    }
    async renew(): Promise<void> {}
    async verifyComplete(): Promise<void> {}
    async projectTarget(): Promise<string | undefined> {
      return "main";
    }
  }
  class Worker implements WorkerPort {
    starts: WorkerSpawnRequest[] = [];
    stops: string[] = [];
    constructor(private readonly statuses: WorkerSpawnStatus[], private readonly startError?: Error) {}
    private n = 0;
    async start(request: WorkerSpawnRequest): Promise<{ job_id: string }> {
      if (this.startError !== undefined) throw this.startError;
      this.starts.push(request);
      return { job_id: "job-x" };
    }
    async status(): Promise<WorkerSpawnStatus> {
      return this.statuses[Math.min(this.n++, this.statuses.length - 1)]!;
    }
    stop(jobId: string): "killed" {
      this.stops.push(jobId);
      return "killed";
    }
  }
  const wt: WtPort = { merge: async () => "ok" };
  const git: GitPort = { push: async () => "", contains: async () => false, abortRebase: async () => undefined };
  const gh = (log: { base?: string; title?: string }[]): GhPort => ({
    createPullRequest: async (_w, request) => {
      log.push({ base: request.base, title: request.title });
      return "https://github.com/o/r/pull/1";
    },
    armAutoMerge: async () => "",
  });
  const deps = (atask: StartTaskAtaskPort, worker: WorkerPort, extra: Record<string, unknown> = {}) => ({
    atask,
    worker,
    wt,
    git,
    gh: gh([]),
    clock: new StepClock(),
    pollMs: 1,
    workspaceExists: async () => true,
    ...extra,
  });
  const ready = (id = "at-1"): TaskSnapshot => ({ id, status: "ready" });
  const complete = (id = "at-1"): TaskSnapshot => ({ id, status: "complete", verdict: "ok", title: "Fix the thing" });

  it("opens the pull request against the claim's target branch", async () => {
    const log: { base?: string; title?: string }[] = [];
    const output = await startAtaskTask(
      normalizeInput({ id: "at-1", onComplete: "pr" }),
      deps(new Atask([ready(), complete()]), new Worker([{ state: "exited", exit_code: 0 }]), { gh: gh(log) }),
    );
    expect(output.completion).toMatchObject({ outcome: "pull_request", url: "https://github.com/o/r/pull/1" });
    expect(log).toEqual([{ base: "feat/target", title: "Fix the thing" }]);
  });

  it("answers failed naming the cause when the worker cannot start, and lands nothing", async () => {
    const output = await startAtaskTask(
      normalizeInput({ id: "at-1" }),
      deps(new Atask([ready()]), new Worker([], new Error("herdr is not available"))),
    );
    expect(output.status).toBe("failed");
    expect(output.workspace).toBe("/ws/task");
    expect(output.error).toBe("the worker could not start in /ws/task: herdr is not available");
  });

  it("passes the config overlay and extra dirs into the worker command", async () => {
    const worker = new Worker([{ state: "exited", exit_code: 0 }]);
    await startAtaskTask(
      normalizeInput({ id: "at-1", add_dirs: ["/x"] }),
      deps(new Atask([ready(), complete()]), worker, { workerConfig: "/cfg/pin-model.yml" }),
    );
    expect(worker.starts[0]?.command).toContain("--config '/cfg/pin-model.yml'");
    expect(worker.starts[0]?.command).toContain("--add-dir '/x'");
  });

  it("reports what it is waiting on while it waits", async () => {
    const messages: string[] = [];
    await startAtaskTask(
      normalizeInput({ id: "at-1" }),
      deps(new Atask([ready(), { id: "at-1", status: "claimed" }, complete()]), new Worker([{ state: "running" }, { state: "running" }]), {
        report: (message: string) => messages.push(message),
      }),
    );
    expect(messages.some((m) => m.startsWith("claiming at-1"))).toBe(true);
    expect(messages.some((m) => m.includes("starting the worker for at-1"))).toBe(true);
    expect(messages.some((m) => m.includes("waiting on at-1: task claimed, worker job-x running"))).toBe(true);
    expect(messages.at(-1)).toBe("landing at-1 (merge)");
  });

  it("throws the abort reason and leaves the worker running when the wait is aborted", async () => {
    const controller = new AbortController();
    const worker = new Worker([{ state: "running" }]);
    const clock: Clock = {
      now: () => 0,
      async sleep(_ms, signal) {
        controller.abort(new Error("user cancelled"));
        signal?.throwIfAborted();
      },
    };
    const run = startAtaskTask(
      normalizeInput({ id: "at-1" }),
      deps(new Atask([ready(), { id: "at-1", status: "claimed" }]), worker, { clock, signal: controller.signal }),
    );
    await expect(run).rejects.toThrow("user cancelled");
    expect(worker.stops).toEqual([]);
  });

  it("does not turn an aborted atask call into a refusal", async () => {
    const controller = new AbortController();
    const atask = new Atask([ready()]);
    atask.show = async () => {
      controller.abort(new Error("cancelled early"));
      throw controller.signal.reason;
    };
    await expect(startAtaskTask(normalizeInput({ id: "at-1" }), deps(atask, new Worker([]), { signal: controller.signal })))
      .rejects.toThrow("cancelled early");
  });

  it("does not turn an aborted landing into a failed outcome", async () => {
    const controller = new AbortController();
    const abortingWt: WtPort = {
      merge: async () => {
        controller.abort(new Error("cancelled mid-merge"));
        throw controller.signal.reason;
      },
    };
    await expect(
      startAtaskTask(
        normalizeInput({ id: "at-1" }),
        deps(new Atask([ready(), complete()]), new Worker([{ state: "exited", exit_code: 0 }]), {
          wt: abortingWt,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("cancelled mid-merge");
  });
});

// ---- the system clock
describe("systemClock", () => {
  it("sleeps, and rejects with the signal's reason when aborted first or already aborted", async () => {
    await systemClock.sleep(5);
    const controller = new AbortController();
    const pending = systemClock.sleep(10_000, controller.signal);
    controller.abort(new Error("stop sleeping"));
    await expect(pending).rejects.toThrow("stop sleeping");
    await expect(systemClock.sleep(5, controller.signal)).rejects.toThrow("stop sleeping");
    expect(systemClock.now()).toBeGreaterThan(0);
  });
});

// ---- text helpers
describe("text helpers", () => {
  it("quotes single quotes for sh, keeps a bounded trimmed tail, and names any error", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(tailOf("  abcdef  ", 3)).toBe("def");
    expect(tailOf("short")).toBe("short");
    expect(messageOf(new Error("e"))).toBe("e");
    expect(messageOf("s")).toBe("s");
  });
});

// ---- the tool: schema, description, execute
describe("start_atask_task tool", () => {
  /** A chainable stand-in for `pi.zod`: every property and call answers itself. The real zod is exercised by the load check. */
  const chain: any = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  const pi = { zod: chain, cwd: "/tmp" } as any;

  const answerer = (statuses: TaskSnapshot[], delayMs = 0) => {
    const atask: StartTaskAtaskPort = {
      show: (() => {
        let n = 0;
        return async () => {
          if (delayMs > 0) await Bun.sleep(delayMs);
          return statuses[Math.min(n++, statuses.length - 1)]!;
        };
      })(),
      claim: async () => ({ token: "t", workspace: "/ws/task", branch: "atask/at-1", target_branch: "main" }),
      assign: async () => {
        throw new Error("no");
      },
      renew: async () => {},
      verifyComplete: async () => {},
      projectTarget: async () => "main",
    };
    const worker: WorkerPort = {
      start: async () => ({ job_id: "job-1" }),
      status: async () => ({ state: "running" }),
      stop: () => "killed",
    };
    return {
      forCall: () => ({
        atask,
        worker,
        wt: { merge: async () => "ok" },
        git: { push: async () => "", contains: async () => false, abortRebase: async () => undefined },
        gh: { createPullRequest: async () => "u", armAutoMerge: async () => "" },
        clock: new StepClock(),
        pollMs: 1,
        workspaceExists: async () => true,
      }),
    };
  };

  it("declares its name, label, discoverable load mode and a parameters schema", () => {
    const tool = createTool(pi, answerer([{ id: "at-1", status: "ready" }])) as any;
    expect(tool.name).toBe("start_atask_task");
    expect(tool.label).toBe("Start atask task");
    expect(tool.loadMode).toBe("discoverable");
    expect(tool.parameters).toBeDefined();
  });

  it("has a description of 80-250 words that states what, input, output, boundary and effects", () => {
    const words = DESCRIPTION.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const phrase of ["atask verify complete", "`onComplete`", "`timeout_s`", "`worker_timeout_s`", "`settled`", "`failed`", "`running`", "`refused`", "complete_atask_group", "Aborting the call stops the wait, not the worker", "spends model quota"]) {
      expect(DESCRIPTION).toContain(phrase);
    }
    expect(DESCRIPTION).not.toContain("/Users/");
  });

  it("answers a settled task as text plus typed details", async () => {
    const tool = createTool(pi, answerer([{ id: "at-1", status: "complete", verdict: "2/2 passed", attempt: { workspace: "/ws/done", branch: "atask/at-1" } }])) as any;
    const result = await tool.execute("call", { id: "at-1", onComplete: "nil" }, undefined, {}, undefined);
    expect(result.details).toMatchObject({ task_id: "at-1", status: "settled", verdict: "2/2 passed", completion: { outcome: "left" } });
    expect(result.content[0].text).toContain("start_atask_task: settled — at-1");
    expect(result.content[0].text).toContain("verdict: 2/2 passed");
    expect(result.content[0].text).toContain("landing (nil): left");
  });

  it("sends heartbeats while it waits and clears its timer", async () => {
    const tool = createTool(pi, { ...answerer([{ id: "at-1", status: "complete", attempt: { workspace: "/w", branch: "b" } }], 60), heartbeatMs: 10 }) as any;
    const updates: string[] = [];
    await tool.execute("call", { id: "at-1", onComplete: "nil" }, (update: any) => updates.push(update.content[0].text), {}, undefined);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]).toContain("start_atask_task: starting at-1");
    const settled = updates.length;
    await Bun.sleep(40);
    expect(updates.length).toBe(settled);
  });

  it("answers running with the call-again hint when the wait ends over a live worker", async () => {
    const tool = createTool(pi, answerer([{ id: "at-1", status: "ready" }, { id: "at-1", status: "claimed" }])) as any;
    const result = await tool.execute("call", { id: "at-1", timeout_s: 3 }, undefined, {}, undefined);
    expect(result.details.status).toBe("running");
    expect(result.content[0].text).toContain("call start_atask_task again with id at-1");
  });

  it("throws on an invalid id before touching atask, and on an abort", async () => {
    let touched = false;
    const ports = answerer([{ id: "at-1", status: "ready" }]);
    const tool = createTool(pi, { forCall: (signal) => { touched = true; return ports.forCall(); } }) as any;
    await expect(tool.execute("call", { id: "--json" }, undefined, {}, undefined)).rejects.toThrow("not an atask id");
    expect(touched).toBe(false);

    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    await expect(tool.execute("call", { id: "at-1" }, undefined, {}, controller.signal)).rejects.toThrow("cancelled by user");
  });

  it("renders every answer field in the text", () => {
    const text = answerText({
      task_id: "at-2",
      status: "settled",
      summary: "task at-2 complete",
      workspace: "/w",
      branch: "b",
      job_id: "j",
      verdict: "v",
      completion: { on_complete: "merge", outcome: "failed", error: "boom", conflict: { onto: "abc", files: ["a.ts"] } },
    });
    for (const part of ["settled — at-2", "workspace: /w", "branch: b", "job: j", "verdict: v", "landing (merge): failed", "landing error: boom", "conflict onto abc: a.ts"]) {
      expect(text).toContain(part);
    }
    expect(answerText({ task_id: "at-3", status: "refused", error: "nope" })).toContain("error: nope");
  });
});
