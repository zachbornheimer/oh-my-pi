import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import {
  appendToFile,
  claimAnswerOf,
  claimsOf,
  type ClaimAnswer,
  DEFAULTS,
  drainQueue,
  heartbeatText,
  liveDrainPort,
  nightlyLog,
  selfImprovementTick,
  settingsOf,
  type DrainPort,
} from "./loop.js";
import { delegateToolCall, type Exec, parseObjectReply } from "./omp_delegate.js";
import { zodStub } from "./zod_stub.js";

const settled = (id: string): ClaimAnswer => ({ task_id: id, status: "settled", completion: { on_complete: "merge", outcome: "merged" } });

describe("settings", () => {
  it("defaults are the unattended-safe ones", () => {
    expect(settingsOf({})).toEqual(DEFAULTS);
  });
  it("rejects values outside the bounds", () => {
    expect(() => settingsOf({ per_project: 9 })).toThrow(/per_project/);
    expect(() => settingsOf({ concurrency: 0 })).toThrow(/concurrency/);
    expect(() => settingsOf({ on_complete: "force" })).toThrow(/on_complete/);
    expect(() => settingsOf({ timeout_s: 0 })).toThrow(/timeout_s/);
    expect(() => settingsOf({ projects: [""] })).toThrow(/projects/);
  });
});

describe("claims", () => {
  it("orders every project's first claim before any second", () => {
    expect(claimsOf({ projects: ["a", "b"], per_project: 2 })).toEqual(["a", "b", "a", "b"]);
  });
  it("runs at most `concurrency` lanes and keeps claim order in the results", async () => {
    let active = 0;
    let peak = 0;
    const port: DrainPort = {
      async start(input) {
        active += 1;
        peak = Math.max(peak, active);
        for (let turn = 0; turn < (input.project === "a" ? 6 : 1); turn += 1) await Promise.resolve();
        active -= 1;
        return settled(input.project);
      },
    };
    const results = await drainQueue(settingsOf({ projects: ["a", "b", "c"], per_project: 2, concurrency: 2 }), port);
    expect(peak).toBe(2);
    expect(results.map((r) => r.project)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });
  it("answers a throwing claim as refused without ending the tick", async () => {
    const port: DrainPort = {
      async start(input) {
        if (input.project === "bad") throw new Error("atask exploded");
        return settled(input.project);
      },
    };
    const results = await drainQueue(settingsOf({ projects: ["bad", "good"] }), port);
    expect(results[0]!.answer).toEqual({ task_id: "", status: "refused", error: "atask exploded" });
    expect(results[1]!.answer.status).toBe("settled");
  });
  it("passes the settings to the port and stops starting claims once aborted", async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    const port: DrainPort = {
      async start(input) {
        seen.push(input);
        controller.abort();
        return settled(input.project);
      },
    };
    const results = await drainQueue(settingsOf({ projects: ["a", "b"], concurrency: 1, on_complete: "pr", timeout_s: 99 }), port, controller.signal);
    expect(seen[0]).toEqual({ project: "a", onComplete: "pr", add_dirs: [], timeout_s: 99 });
    expect(results[1]!.answer.status).toBe("refused");
  });
});

describe("tick", () => {
  const now = () => new Date("2026-11-06T04:00:00.000Z");
  it("dry_run lists the planned claims, starts nothing and writes nothing", async () => {
    const lines: string[] = [];
    let started = 0;
    const out = await selfImprovementTick(settingsOf({ dry_run: true, projects: ["a"], per_project: 2 }), {
      port: { start: async () => (started++, settled("x")) },
      append: async (_p, t) => void lines.push(t),
      now,
      logPath: "/nope",
    });
    expect(out).toMatchObject({ status: "planned", planned: ["a", "a"], claims: [] });
    expect(started).toBe(0);
    expect(lines).toEqual([]);
  });
  it("appends the heartbeat for a drained tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "si-"));
    try {
      const logPath = join(dir, "nested", "nightly.log");
      const out = await selfImprovementTick(settingsOf({ projects: ["p"] }), {
        port: { start: async () => settled("at-1") },
        append: appendToFile,
        now,
        logPath,
      });
      expect(out.status).toBe("drained");
      const text = await readFile(logPath, "utf8");
      expect(text).toBe(out.heartbeat);
      expect(text).toContain("self-improvement tick: 1 claim(s), 1 settled, 0 running, 0 failed, 0 refused");
      expect(text).toContain("  p: at-1 settled merged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("heartbeat names a refused claim with no objective", () => {
    const text = heartbeatText("T", [{ project: "p", answer: { task_id: "", status: "refused", error: "nothing ready" } }]);
    expect(text).toContain("  p: (no objective) refused: nothing ready");
  });
  it("nightlyLog is under the home directory", () => {
    expect(nightlyLog("/h")).toBe("/h/.local/share/capability-replicas/nightly.log");
  });
});

describe("delegate to start_atask_task", () => {
  const reply = (stdout: string, code = 0, killed = false): Exec => async () => ({ stdout, stderr: "boom", code, killed });
  it("validates the answer", () => {
    expect(() => claimAnswerOf({ task_id: 1, status: "settled" })).toThrow(/task_id/);
    expect(() => claimAnswerOf({ task_id: "x", status: "done" })).toThrow(/status/);
    expect(() => claimAnswerOf({ task_id: "x", status: "settled", completion: { outcome: "x" } })).toThrow(/completion/);
    expect(claimAnswerOf({ task_id: "x", status: "running" }).status).toBe("running");
  });
  it("parses fenced and prose-wrapped objects and rejects non-objects", () => {
    expect(parseObjectReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseObjectReply('Here: {"a":1}')).toEqual({ a: 1 });
    expect(() => parseObjectReply("no json")).toThrow(/no JSON object/);
    expect(() => parseObjectReply("{not json}")).toThrow(/not JSON/);
  });
  it("calls omp with the tool prompt and returns the validated answer", async () => {
    let args: string[] = [];
    let prompt = "";
    const exec: Exec = async (_c, a) => {
      args = a;
      prompt = await readFile(a[1]!.slice(1), "utf8");
      return { stdout: '{"task_id":"at-9","status":"settled"}', stderr: "", code: 0, killed: false };
    };
    const answer = await liveDrainPort(exec).start({ project: "p", onComplete: "nil", add_dirs: [], timeout_s: 10 });
    expect(answer.task_id).toBe("at-9");
    expect(args[0]).toBe("-p");
    expect(prompt).toContain("`start_atask_task`");
    expect(prompt).toContain('"project":"p"');
  });
  it("fails explicitly when the tool is missing, omp fails, is killed, or prose comes back", async () => {
    const call = (exec: Exec) => liveDrainPort(exec).start({ project: "p", onComplete: "nil", add_dirs: [], timeout_s: 1 });
    await expect(call(reply('{"error":"start_atask_task is not available"}'))).rejects.toThrow(/not available/);
    await expect(call(reply("", 2))).rejects.toThrow(/omp exited 2/);
    await expect(call(reply("", 0, true))).rejects.toThrow(/killed/);
    await expect(call(reply("I did the work."))).rejects.toThrow(/no JSON object/);
    await expect(delegateToolCall(reply("{}"), { tool: "t", args: {}, validate: claimAnswerOf, timeoutMs: 1 })).rejects.toThrow(/task_id/);
  });
});

describe("tool", () => {
  it("loads with a stub zod and a description within 250 words", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
    const tool = (await factory({ zod: zodStub, exec, cwd: "/" } as unknown as Parameters<typeof factory>[0])) as unknown as {
      name: string;
      description: string;
    };
    expect(tool.name).toBe("self_improvement");
    expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(250);
  });
});
