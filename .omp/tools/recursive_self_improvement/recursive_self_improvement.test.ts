import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import factory from "./index.js";
import type { Exec } from "./omp_delegate.js";
import {
  DEFAULTS,
  headlineOf,
  learningText,
  livePorts,
  optimizeSummaryOf,
  type Ports,
  recursiveSelfImprovement,
  settingsOf,
} from "./run.js";
import type { Chosen } from "./triage.js";
import { zodStub } from "./zod_stub.js";

const chosen = (conversation: string): Chosen => ({ conversation, source: `/s/${conversation}`, export: conversation, day: "2026-11-05", bytes: 1, human_turns: 3 });

function ports(over: Partial<Ports> = {}): Ports & { remembered: string[]; lines: string[]; released: number[]; learned: string[]; selects: unknown[] } {
  const state = { remembered: [] as string[], lines: [] as string[], released: [] as number[], learned: [] as string[], selects: [] as unknown[] };
  const base: Ports = {
    alreadyLearned: async () => new Set(["omp:done"]),
    select: async (options) => (state.selects.push(options), [chosen("omp:a"), chosen("omp:b")]),
    remember: async (list) => void state.remembered.push(...list.map((c) => c.conversation)),
    learn: async (conversation) => (state.learned.push(conversation), `2 ticket(s) filed from ${conversation}`),
    optimize: async () => "optimize_tooling=worked (ZYS-1=implemented)",
    append: async (_p, text) => void state.lines.push(text),
    lock: { acquire: async () => ({ held: true }), release: async () => void state.released.push(1) },
    logPath: "/log",
    now: () => new Date("2026-11-06T00:00:00.000Z"),
  };
  return Object.assign({ ...base, ...over }, state);
}

describe("settings", () => {
  it("defaults and bounds", () => {
    expect(settingsOf({})).toEqual({ ...DEFAULTS });
    expect(() => settingsOf({ hours: 0 })).toThrow(/hours/);
    expect(() => settingsOf({ force: "yes" })).toThrow(/force/);
    expect(() => settingsOf({ sources: [""] })).toThrow(/sources/);
  });
});

describe("recursiveSelfImprovement", () => {
  it("triages, learns from each chosen session, remembers them and appends one nightly line", async () => {
    const p = ports();
    const out = await recursiveSelfImprovement(settingsOf({ max_transcripts: 2, hours: 24 }), p);
    expect(p.selects).toEqual([{ max: 2, hours: 24 }]);
    expect(out.status).toBe("done");
    expect(out.learnings.map((l) => l.conversation)).toEqual(["omp:a", "omp:b"]);
    expect(out.learnings[0]!.answer_markdown).toBe("2 ticket(s) filed from omp:a | optimize_tooling skipped");
    expect(p.remembered.sort()).toEqual(["omp:a", "omp:b"]);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toContain("2026-11-06T00:00:00.000Z nightly: 2 learning(s)");
    expect(p.released).toHaveLength(1);
  });
  it("explicit sources skip the triage and drop sessions already learned unless forced", async () => {
    const p = ports();
    await recursiveSelfImprovement(settingsOf({ sources: ["omp:done", "omp:new"] }), p);
    expect(p.selects).toEqual([]);
    expect(p.learned).toEqual(["omp:new"]);
    const q = ports();
    await recursiveSelfImprovement(settingsOf({ sources: ["omp:done"], force: true }), q);
    expect(q.learned).toEqual(["omp:done"]);
  });
  it("a failed learn run is reported and not remembered; the others still run", async () => {
    const p = ports({ learn: async (c) => (c === "omp:a" ? Promise.reject(new Error("timed out")) : "ok") });
    const out = await recursiveSelfImprovement(settingsOf({}), p);
    expect(out.learnings[0]!.answer_markdown).toContain("(learn_from_transcript failed: timed out)");
    expect(p.remembered).toEqual(["omp:b"]);
  });
  it("runs optimize_tooling only when asked, with apply and limit, and keeps an error in the summary", async () => {
    const calls: unknown[] = [];
    const p = ports({ optimize: async (o) => (calls.push(o), "optimize_tooling=empty (no ticket worked)") });
    const out = await recursiveSelfImprovement(settingsOf({ run_optimize_tooling: true, apply: false, optimize_limit: 2 }), p);
    expect(calls).toEqual([{ apply: false, limit: 2 }]);
    expect(out.optimize).toContain("empty");
    const bad = await recursiveSelfImprovement(
      settingsOf({ run_optimize_tooling: true }),
      ports({ optimize: async () => Promise.reject(new Error("tool missing")) }),
    );
    expect(bad.optimize).toBe("optimize_tooling error: tool missing");
  });
  it("with nothing chosen still writes the heartbeat with the optimize summary", async () => {
    const p = ports({ select: async () => [] });
    const out = await recursiveSelfImprovement(settingsOf({}), p);
    expect(out.learnings).toEqual([{ conversation: "optimize_tooling", review_path: "/log", answer_markdown: "optimize_tooling skipped", commits: [], unverified_shas: [] }]);
    expect(p.lines).toHaveLength(1);
  });
  it("answers busy and does nothing when the lock is held", async () => {
    const p = ports({ lock: { acquire: async () => ({ held: false }), release: async () => {} } });
    const out = await recursiveSelfImprovement(settingsOf({}), p);
    expect(out).toMatchObject({ status: "busy", learnings: [] });
    expect(p.learned).toEqual([]);
    expect(p.lines).toEqual([]);
  });
  it("releases the lock and surfaces the error when the heartbeat cannot be written or triage fails", async () => {
    const a = ports({ append: async () => Promise.reject(new Error("disk full")) });
    await expect(recursiveSelfImprovement(settingsOf({}), a)).rejects.toThrow(/disk full/);
    expect(a.released).toHaveLength(1);
    const b = ports({ select: async () => Promise.reject(new Error("no scorer")) });
    await expect(recursiveSelfImprovement(settingsOf({}), b)).rejects.toThrow(/no scorer/);
    expect(b.released).toHaveLength(1);
  });
});

describe("live answers", () => {
  it("reduce the learn and optimize tools' answers", () => {
    expect(headlineOf({ headline: "3 filed" })).toBe("3 filed");
    expect(headlineOf({ tickets: [1, 2] })).toBe("2 ticket(s) filed");
    expect(() => headlineOf({})).toThrow(/neither/);
    expect(optimizeSummaryOf({ status: "worked", runs: [{ ticket: "ZYS-1", outcome: "implemented" }] })).toBe("optimize_tooling=worked (ZYS-1=implemented)");
    expect(optimizeSummaryOf({ status: "empty", runs: [] })).toBe("optimize_tooling=empty (no ticket worked)");
    expect(() => optimizeSummaryOf({})).toThrow();
  });
  it("learningText lists commits", () => {
    const text = learningText("T", [{ conversation: "omp:a", review_path: "r", answer_markdown: "xy", commits: [{ repo: "r", sha: "0123456789abcdef" }], unverified_shas: [] }]);
    expect(text).toBe("T nightly: 1 learning(s)\n  omp:a: review r; answer 2 chars; 1 commit(s) verified (0123456789ab); 0 sha(s) unverified\n");
  });
  it("the live learn port asks omp to call learn_from_transcript with dispatch off", async () => {
    let prompt = "";
    const exec: Exec = async (_c, args) => {
      prompt = await readFile(args[1]!.slice(1), "utf8");
      return { stdout: '{"tickets":[{"id":"ZYS-9"}]}', stderr: "", code: 0, killed: false };
    };
    const live = livePorts(exec);
    expect(await live.learn("omp:a")).toBe("1 ticket(s) filed");
    expect(prompt).toContain("`learn_from_transcript`");
    expect(prompt).toContain('"dispatch":false');
  });
});

describe("tool", () => {
  it("loads with a stub zod; description within 250 words", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
    const tool = (await factory({ zod: zodStub, exec, cwd: "/" } as unknown as Parameters<typeof factory>[0])) as unknown as { name: string; description: string };
    expect(tool.name).toBe("recursive_self_improvement");
    expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(250);
  });
});
