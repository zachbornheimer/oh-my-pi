import { describe, expect, it } from "bun:test";
import { FakeFactory, implemented } from "./fake_world.js";
import { inWorkOrder } from "./steps_intake.js";
import { runSweep } from "./sweep.js";
import { sweepText, sweepTool } from "./sweep_tool.js";

async function sweep(world: FakeFactory, input: { teams?: string[]; project?: string; limit?: number; merge?: boolean } = {}) {
  const result = await runSweep(world.ports(), { ...input, merge: input.merge ?? false });
  if (result.stopped !== undefined) throw new Error(`the sweep stopped at ${result.stopped.ticket}: ${result.stopped.error}`);
  return result;
}

/** Tickets the sweep must rank: Urgent (1) first, No priority (0) last, oldest first within a priority. */
function backlog(): FakeFactory {
  const world = new FakeFactory();
  world.addIssue("SAH-10", { priority: 0, createdAt: "2026-01-01T00:00:00.000Z" });
  world.addIssue("SAH-11", { priority: 3, createdAt: "2026-03-02T00:00:00.000Z" });
  world.addIssue("SAH-12", { priority: 1, createdAt: "2026-05-01T00:00:00.000Z", status: "Unreviewed" });
  world.addIssue("SAH-13", { priority: 3, createdAt: "2026-03-01T00:00:00.000Z", status: "Ready for Dev" });
  world.addIssue("SAH-14", { priority: 4, createdAt: "2026-02-01T00:00:00.000Z" });
  world.addIssue("SAH-15", { priority: 1, createdAt: "2026-06-01T00:00:00.000Z", status: "In Progress" });
  world.addIssue("SAH-16", { priority: 1, createdAt: "2026-01-01T00:00:00.000Z", status: "Done" });
  return world;
}

describe("software_factory", () => {
  it("takes one ticket by default: the most urgent eligible one, not an in-flight or finished one", async () => {
    const world = backlog();
    world.implementations.push(implemented({ outcome: "already_done" }));

    const result = await sweep(world);

    expect(result.tickets).toEqual([{ ticket: "SAH-12", outcome: "already_done", linearStatus: "Done" }]);
    expect(world.issue("SAH-10").status).toBe("Triage");
  });

  it("works the tickets in priority-then-age order, one at a time, and never picks the same ticket twice", async () => {
    const world = backlog();
    for (let i = 0; i < 5; i++) world.implementations.push(implemented({ outcome: "already_done" }));

    const result = await sweep(world, { limit: 5 });

    expect(result.tickets.map((run) => run.ticket)).toEqual(["SAH-12", "SAH-13", "SAH-11", "SAH-14", "SAH-10"]);
    expect(result.tickets.every((run) => run.outcome === "already_done")).toBe(true);
    // A second run in flight would have found the lock held and answered busy; none did, and never two held at once.
    expect(world.maxHeld).toBe(1);
    expect(world.lockHolder).toBeUndefined();
    const started = world.events.filter((event) => event.startsWith("git.openWorktree"));
    expect(started).toEqual(["sah-12", "sah-13", "sah-11", "sah-14", "sah-10"].map((branch) => `git.openWorktree ${branch}`));
    for (const ticket of ["SAH-10", "SAH-11", "SAH-12", "SAH-13", "SAH-14"]) expect(world.issue(ticket).status).toBe("Done");
    expect(world.issue("SAH-15").status).toBe("In Progress");
    expect(world.issue("SAH-16").status).toBe("Done");
  });

  it("takes every workspace's own input statuses by default, still one at a time, priority then age", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-1", { status: "Initial Ticket Review", priority: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    world.addIssue("ZYS-2", { status: "Ready for Development", priority: 2, createdAt: "2026-02-01T00:00:00.000Z" });
    world.addIssue("ZYS-3", { status: "Unreviewed", priority: 3, createdAt: "2026-02-02T00:00:00.000Z" });
    world.addIssue("SAH-1", { status: "Ready for Dev", priority: 2, createdAt: "2026-03-01T00:00:00.000Z" });
    for (let i = 0; i < 3; i++) world.implementations.push(implemented({ outcome: "already_done" }));

    const result = await sweep(world, { limit: 3 });

    expect(result.tickets.map((run) => run.ticket)).toEqual(["ZYS-2", "SAH-1", "ZYS-3"]);
    expect(world.maxHeld).toBe(1);
    expect(world.issue("ZYS-1").status).toBe("Initial Ticket Review");
  });

  it("sweeps only the teams it is given", async () => {
    const world = backlog();
    world.addIssue("ZYS-1", { status: "Ready for Development", priority: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    world.implementations.push(implemented({ outcome: "already_done" }));

    const result = await sweep(world, { teams: ["ZYS"], limit: 3 });

    expect(result.tickets.map((run) => run.ticket)).toEqual(["ZYS-1"]);
    expect(world.issue("SAH-12").status).toBe("Unreviewed");
  });

  it("sweeps only the Linear project it is given", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-1", { status: "Ready for Development", priority: 1, createdAt: "2026-01-01T00:00:00.000Z", project: "Other" });
    world.addIssue("ZYS-2", { status: "Ready for Development", priority: 2, createdAt: "2026-01-02T00:00:00.000Z", project: "AI Tooling" });
    world.addIssue("ZYS-3", { status: "Unreviewed", priority: 1, createdAt: "2026-01-03T00:00:00.000Z", project: "AI Tooling" });
    for (let i = 0; i < 2; i++) world.implementations.push(implemented({ outcome: "already_done" }));

    const result = await sweep(world, { teams: ["ZYS"], project: "AI Tooling", limit: 3 });

    expect(result.tickets.map((run) => run.ticket)).toEqual(["ZYS-3", "ZYS-2"]);
    expect(world.issue("ZYS-1").status).toBe("Ready for Development");
  });

  it("a ticket another run is already working ends busy and nothing is written for it", async () => {
    const world = backlog();
    world.lockHolder = "an-earlier-sweep";

    const result = await sweep(world, { limit: 2 });

    expect(result.tickets).toEqual([
      { ticket: "SAH-12", outcome: "busy", linearStatus: undefined },
      { ticket: "SAH-13", outcome: "busy", linearStatus: undefined },
    ]);
    expect(world.linearWrites).toEqual([]);
    expect(world.lockHolder).toBe("an-earlier-sweep");
  });

  it("passes merge through to each ticket's make_pr_mergable", async () => {
    const world = backlog();
    world.implementations.push(implemented());
    world.changeReviews.push({ verdict: "CLEAN", summary: "ok", findings: [] });

    await sweep(world, { merge: true });

    expect(world.mergeRuns.map((run) => run.merge)).toEqual([true]);
  });

  it("stops at the first ticket whose run fails: the next ticket is never started, and the lock is free", async () => {
    const world = backlog();
    // The code-improver has no answer for SAH-12, so its run fails at implement_ticket.
    const result = await runSweep(world.ports(), { limit: 2, merge: false });

    expect(result.stopped?.ticket).toBe("SAH-12");
    expect(result.stopped?.error).toContain("no scripted answer left");
    expect(result.tickets).toEqual([]);
    expect(world.events.filter((event) => event.startsWith("git.openWorktree"))).toEqual(["git.openWorktree sah-12"]);
    expect(world.issue("SAH-13").status).toBe("Ready for Dev");
    expect(world.linearWrites.some((write) => write.includes("SAH-13"))).toBe(false);
    expect(world.lockHolder).toBeUndefined();
  });
});

describe("inWorkOrder", () => {
  const issue = (identifier: string, priority: number, createdAt: string) => ({ identifier, status: "Triage", priority, createdAt });

  it("ranks Urgent before Low and No priority last, then oldest first", () => {
    const ordered = inWorkOrder([
      issue("none-old", 0, "2020-01-01T00:00:00Z"),
      issue("low", 4, "2020-01-01T00:00:00Z"),
      issue("urgent-new", 1, "2026-01-01T00:00:00Z"),
      issue("urgent-old", 1, "2025-01-01T00:00:00Z"),
      issue("high", 2, "2019-01-01T00:00:00Z"),
    ]);
    expect(ordered.map((entry) => entry.identifier)).toEqual(["urgent-old", "urgent-new", "high", "low", "none-old"]);
  });
});

describe("the sweep tool", () => {
  // omp's own zod is not installed beside the tools; a chainable recorder stands in for `pi.zod`.
  const chain: unknown = new Proxy(function () {}, { get: () => () => chain, apply: () => chain });
  type Tool = {
    name: string;
    description: string;
    execute(
      id: string,
      params: unknown,
      onUpdate: (update: { content: { text: string }[] }) => void,
      ctx: unknown,
      signal: AbortSignal | undefined,
    ): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };

  it("sweeps with null parameters as defaults, beats while a ticket is in flight, and stops its heartbeat with the run", async () => {
    const world = backlog();
    world.implementations.push(implemented({ outcome: "already_done" }));
    const slow = () => {
      const ports = world.ports();
      const implement = ports.implement;
      ports.implement = async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return implement(input);
      };
      return ports;
    };
    const tool = sweepTool(slow, 5)({ zod: chain } as never) as unknown as Tool;
    const updates: string[] = [];

    const result = await tool.execute(
      "call",
      { teams: null, project: null, limit: null, merge: null },
      (update) => updates.push(update.content[0]!.text),
      {} as never,
      undefined,
    );

    expect(tool.name).toBe("software_factory");
    expect(result.content[0]!.text).toContain("SAH-12: already_done, Linear status Done");
    expect(updates.length).toBeGreaterThan(2);
    expect(updates.some((text) => text.includes("implement_ticket#1"))).toBe(true);
    const settledAt = updates.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updates.length).toBe(settledAt);
  });

  it("a sweep run again after a ticket failed resumes that ticket instead of redoing it", async () => {
    const world = backlog();
    world.implementations.push(implemented({ outcome: "already_done" }));
    world.failOnce = "implement";

    const first = await runSweep(world.ports(), { limit: 1, merge: false });
    expect(first.stopped?.ticket).toBe("SAH-12");
    const reviewsBefore = world.reviewPrompts.length;

    const second = await runSweep(world.ports(), { limit: 1, merge: false });

    expect(second.stopped).toBeUndefined();
    expect(second.tickets).toEqual([{ ticket: "SAH-12", outcome: "already_done", linearStatus: "Done", resumed: true }]);
    expect(world.reviewPrompts.length).toBe(reviewsBefore);
    expect(sweepText(second)).toContain("(resumed)");
  });

  it("names a failed ticket in the text and a quiet backlog as empty", () => {
    expect(sweepText({ tickets: [], stopped: { ticket: "SAH-1", error: "boom" } })).toContain("Stopped at SAH-1: boom");
    expect(sweepText({ tickets: [] })).toBe("No eligible ticket.");
  });
});
