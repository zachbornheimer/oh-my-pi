/**
 * Ported from the Mastra factory's `list_eligible_tickets.test.ts`. The sweep names one Linear project across every
 * configured workspace, and only some workspaces have that project: `{ project: "AI Tooling" }` with no `teams` reaches the
 * ZYS workspace and asks the SAH one for a project it does not have. That answer must not fail the whole sweep. Then the
 * live port: one read-only full omp session per workspace, its listing checked in code.
 */
import { describe, expect, it } from "bun:test";
import { fakeOmp } from "./fake_omp.js";
import factory from "./index.js";
import {
  type EligiblePorts,
  inWorkOrder,
  type IssueSummary,
  listEligibleTickets,
  listingOf,
  listingPrompt,
  liveEligiblePorts,
} from "./list_eligible_tickets.js";
import { WORKSPACES } from "./workspaces.js";
import { loadZod } from "./zod_for_tests.js";

const ZYS = WORKSPACES.find((workspace) => workspace.team === "ZYS")!;
const SAH = WORKSPACES.find((workspace) => workspace.team === "SAH")!;

const summary = (identifier: string, priority: number, createdAt: string, status = "Unreviewed"): IssueSummary => ({
  identifier,
  status,
  priority,
  createdAt,
});

/** A port whose `listIssues` answers from `byTeam`, and throws `failure` for a workspace that names one. */
function port(byTeam: Record<string, IssueSummary[]>, failure?: { team: string; error: Error }): EligiblePorts & { asked: unknown[][] } {
  const asked: unknown[][] = [];
  return {
    asked,
    async listIssues(workspace, statuses, project) {
      asked.push([workspace.team, [...statuses], project]);
      if (failure !== undefined && workspace.team === failure.team) throw failure.error;
      return byTeam[workspace.team] ?? [];
    },
  };
}

describe("listing the tickets a sweep works", () => {
  it("skips a workspace whose Linear has no such project instead of failing the sweep", async () => {
    const ports = port(
      { [ZYS.team]: [summary("ZYS-1732", 2, "2026-11-01T00:00:00.000Z")] },
      { team: SAH.team, error: new Error('linear-sah/list_issues: Error: Could not find project "AI Tooling"') },
    );
    expect(await listEligibleTickets(ports, { project: "AI Tooling", limit: 5 })).toEqual(["ZYS-1732"]);
  });

  it("keeps every workspace it can read, in priority then age order", async () => {
    const ports = port({
      [ZYS.team]: [summary("ZYS-40", 0, "2026-10-01T00:00:00.000Z"), summary("ZYS-41", 1, "2026-11-01T00:00:00.000Z")],
      [SAH.team]: [summary("SAH-7", 1, "2026-09-01T00:00:00.000Z")],
    });
    // Priority 1 before no-priority, and the older of the two priority-1 tickets first.
    expect(await listEligibleTickets(ports, { limit: 5 })).toEqual(["SAH-7", "ZYS-41", "ZYS-40"]);
  });

  it("propagates a failure that is not a missing project", async () => {
    const ports = port({ [ZYS.team]: [] }, { team: SAH.team, error: new Error("linear-sah/list_issues: 503 Service Unavailable") });
    await expect(listEligibleTickets(ports, { project: "AI Tooling", limit: 5 })).rejects.toThrow(/503/);
  });

  it("does not hide a missing-project error when no project was named", async () => {
    const ports = port({}, { team: SAH.team, error: new Error('Could not find project "x"') });
    await expect(listEligibleTickets(ports, {})).rejects.toThrow(/Could not find project/);
  });

  it("returns one ticket by default, reads only the teams named, and asks each for its own input statuses", async () => {
    const ports = port({
      [ZYS.team]: [summary("ZYS-2", 3, "2026-10-02T00:00:00.000Z"), summary("ZYS-1", 3, "2026-10-01T00:00:00.000Z")],
      [SAH.team]: [summary("SAH-1", 1, "2026-10-01T00:00:00.000Z")],
    });
    expect(await listEligibleTickets(ports, { teams: ["zys"] })).toEqual(["ZYS-1"]);
    expect(ports.asked).toEqual([["ZYS", ["Unreviewed", "Ready for Development"], undefined]]);
    const both = port({});
    await listEligibleTickets(both, {});
    expect(both.asked.map((row) => [row[0], row[1]])).toEqual([
      ["SAH", ["Triage", "Unreviewed", "Ready for Dev"]],
      ["ZYS", ["Unreviewed", "Ready for Development"]],
    ]);
  });

  it("lists a ticket once, and refuses an unknown team or a limit that is not a positive integer", async () => {
    const twice = port({ [ZYS.team]: [summary("ZYS-1", 2, "2026-10-01T00:00:00.000Z"), summary("ZYS-1", 2, "2026-10-01T00:00:00.000Z")] });
    expect(await listEligibleTickets(twice, { limit: 5 })).toEqual(["ZYS-1"]);
    await expect(listEligibleTickets(port({}), { teams: ["NOPE"] })).rejects.toThrow(/no Linear workspace the software factory works; it works SAH, ZYS/);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(listEligibleTickets(port({}), { limit })).rejects.toThrow(/limit must be a positive integer/);
    }
  });

  it("orders Urgent first, No priority last, oldest first within a priority", () => {
    const issues = [
      summary("A-1", 0, "2026-01-01T00:00:00.000Z"),
      summary("A-2", 4, "2026-01-01T00:00:00.000Z"),
      summary("A-3", 1, "2026-03-01T00:00:00.000Z"),
      summary("A-4", 1, "2026-02-01T00:00:00.000Z"),
    ];
    expect(inWorkOrder(issues).map((issue) => issue.identifier)).toEqual(["A-4", "A-3", "A-2", "A-1"]);
  });
});

const listing = (issues: unknown[], extra: object = {}): string => JSON.stringify({ project_found: true, complete: true, issues, ...extra });
const issue = (identifier: string, priority: number, createdAt: string, status = "Unreviewed") => ({ identifier, status, priority, createdAt });

describe("the live port", () => {
  it("runs one read-only session per workspace and orders what they report", async () => {
    const { exec, calls } = fakeOmp([
      (call) =>
        call.prompt.includes("team SAH")
          ? listing([issue("SAH-7", 1, "2026-09-01T00:00:00.000Z", "Triage")])
          : listing([issue("ZYS-41", 1, "2026-11-01T00:00:00.000Z"), issue("ZYS-40", 0, "2026-10-01T00:00:00.000Z", "Ready for Development")]),
      (call) =>
        call.prompt.includes("team SAH")
          ? listing([issue("SAH-7", 1, "2026-09-01T00:00:00.000Z", "Triage")])
          : listing([issue("ZYS-41", 1, "2026-11-01T00:00:00.000Z"), issue("ZYS-40", 0, "2026-10-01T00:00:00.000Z", "Ready for Development")]),
    ]);
    const tickets = await listEligibleTickets(liveEligiblePorts({ exec }), { limit: 5 });
    expect(tickets).toEqual(["SAH-7", "ZYS-41", "ZYS-40"]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toContain("--no-session");
      expect(call.args).not.toContain("--no-tools");
      expect(call.prompt).toContain("read-only check: change nothing");
      expect(call.prompt).toContain("NEVER call the omp tools prepare_ticket");
    }
    const sah = calls.find((call) => call.prompt.includes("team SAH"))!;
    expect(sah.prompt).toContain('"Triage", "Unreviewed", "Ready for Dev"');
    expect(sah.prompt).toContain('"linear-sah"');
  });

  it("names the project, and a workspace without it contributes nothing", async () => {
    const { exec, calls } = fakeOmp([
      (call) =>
        call.prompt.includes("team SAH")
          ? JSON.stringify({ project_found: false, complete: true, issues: [] })
          : listing([issue("ZYS-9", 2, "2026-10-01T00:00:00.000Z")]),
      (call) =>
        call.prompt.includes("team SAH")
          ? JSON.stringify({ project_found: false, complete: true, issues: [] })
          : listing([issue("ZYS-9", 2, "2026-10-01T00:00:00.000Z")]),
    ]);
    expect(await listEligibleTickets(liveEligiblePorts({ exec }), { project: "AI Tooling" })).toEqual(["ZYS-9"]);
    expect(calls.every((call) => call.prompt.includes('Linear project named "AI Tooling"'))).toBe(true);
  });

  it("asks again after a listing that is incomplete or off-team, and fails after three bad ones", async () => {
    const { exec, calls } = fakeOmp([
      listing([], { complete: false }),
      listing([issue("SAH-1", 1, "2026-01-01T00:00:00.000Z")]),
      listing([issue("ZYS-3", 2, "2026-10-01T00:00:00.000Z")]),
    ]);
    expect(await listEligibleTickets(liveEligiblePorts({ exec }), { teams: ["ZYS"] })).toEqual(["ZYS-3"]);
    expect(calls[1]!.prompt).toContain("complete is false");
    expect(calls[2]!.prompt).toContain("is not a ZYS ticket");

    const hopeless = fakeOmp(["nothing", "nothing", "nothing"]);
    await expect(listEligibleTickets(liveEligiblePorts({ exec: hopeless.exec }), { teams: ["ZYS"] })).rejects.toThrow(
      /list_eligible_tickets ZYS: no valid reply after 3 attempts/,
    );
  });

  it("propagates a session that fails, instead of listing nothing", async () => {
    const { exec } = fakeOmp([{ stdout: "", stderr: "Linear MCP is down", code: 1, killed: false }]);
    await expect(listEligibleTickets(liveEligiblePorts({ exec }), { teams: ["ZYS"] })).rejects.toThrow(/exited 1: Linear MCP is down/);
  });
});

describe("the listing's validation", () => {
  const statuses = ZYS.inputs;
  it("keeps only issues of the team, in an input status, with a priority 0-4 and a date", () => {
    expect(listingOf(ZYS, statuses, { project_found: true, complete: true, issues: [issue("zys-5", 2, "2026-10-01T00:00:00Z")] }).issues).toEqual([
      issue("ZYS-5", 2, "2026-10-01T00:00:00Z"),
    ]);
    const bad = (entry: unknown) => () => listingOf(ZYS, statuses, { project_found: true, complete: true, issues: [entry] });
    expect(bad(issue("ZYS-5", 2, "2026-10-01T00:00:00Z", "Done"))).toThrow(/is in "Done"/);
    expect(bad(issue("ZYS-5", 7, "2026-10-01T00:00:00Z"))).toThrow(/priority must be an integer 0-4/);
    expect(bad(issue("ZYS-5", 1.5, "2026-10-01T00:00:00Z"))).toThrow(/priority/);
    expect(bad(issue("ZYS-5", 2, "yesterday"))).toThrow(/not a date/);
    expect(bad("ZYS-5")).toThrow(/must be an object/);
    expect(() => listingOf(ZYS, statuses, { project_found: false, complete: true, issues: [issue("ZYS-5", 2, "2026-10-01T00:00:00Z")] })).toThrow(/project_found is false/);
  });

  it("states the statuses it was given in the prompt", () => {
    expect(listingPrompt(ZYS, ["Unreviewed"], undefined)).toContain('exactly these statuses: "Unreviewed".');
  });
});

describe("loading against omp's own pi.zod", () => {
  it("returns a tool object and validates its parameters", async () => {
    const tool = factory({ zod: await loadZod(), exec: async () => ({}) } as never) as unknown as {
      name: string;
      description: string;
      parameters: { parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean } };
    };
    expect(tool.name).toBe("list_eligible_tickets");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    const check = (value: unknown): boolean => {
      try {
        const parsed = tool.parameters.safeParse?.(value);
        if (parsed !== undefined) return parsed.success;
        tool.parameters.parse?.(value);
        return true;
      } catch {
        return false;
      }
    };
    expect(check({})).toBe(true);
    expect(check({ teams: ["ZYS"], project: "AI Tooling", limit: 5 })).toBe(true);
    expect(check({ teams: null, project: null, limit: null })).toBe(true);
    expect(check({ limit: 0 })).toBe(false);
    expect(check({ limit: 1.5 })).toBe(false);
    const refusal = (tool.parameters as unknown as { safeParse: (v: unknown) => { error?: { issues: { path: string[]; message: string }[] } } }).safeParse({ limit: 0 });
    const message = refusal.error?.issues[0]?.message ?? "";
    expect(message).toBe("must be an integer of at least 1 (the most identifiers to return; default 1, null for the default) (was 0)");
    expect(message).not.toContain("Most identifiers");
    expect(check({ project: "" })).toBe(false);
    expect(check({ teams: "ZYS" })).toBe(false);
  });
});
