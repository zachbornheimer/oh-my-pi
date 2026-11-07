import { describe, expect, it } from "bun:test";
import { fakeOmp } from "./fake_omp.js";
import { judgeSupersession, runFindSupersedingTickets, supersessionAnswerOf } from "./find_superseding_tickets.js";
import factory from "./index.js";
import { loadZod } from "./zod_for_tests.js";

const FILED = "2026-09-01T10:00:00.000Z";
const answer = (superseded_by: unknown[], extra: object = {}): string =>
  JSON.stringify({ filed_at: FILED, superseded_by, evidence: "searched export and CSV", ...extra });
const later = (id: string, filed_at = "2026-09-20T08:30:00.000Z", why = "covers it") => ({ id, filed_at, why });

describe("find_superseding_tickets", () => {
  it("keeps a later ticket and names the question to the session", async () => {
    const { exec, calls } = fakeOmp([answer([later("zys-14")])]);
    const out = await runFindSupersedingTickets({ ticket: "zys-10" }, { exec });
    expect(out).toEqual({
      ticket: "ZYS-10",
      verdict: "superseded",
      filed_at: FILED,
      superseded_by: [{ id: "ZYS-14", filed_at: "2026-09-20T08:30:00.000Z", why: "covers it" }],
      rejected: [],
      evidence: "searched export and CSV",
    });
    expect(calls[0]!.args).toContain("--no-session");
    expect(calls[0]!.args).not.toContain("--no-tools");
    expect(calls[0]!.prompt).toContain("Find which Linear tickets, filed after Linear ticket ZYS-10 was filed");
    expect(calls[0]!.prompt).toContain("read-only check");
    expect(calls[0]!.prompt).toContain("NEVER call the omp tools prepare_ticket");
  });

  it("never reports a ticket that was not filed after this one, however plausible", async () => {
    const { exec } = fakeOmp([
      answer([
        later("ZYS-8", "2026-08-01T00:00:00.000Z"),
        later("ZYS-9", FILED),
        later("ZYS-10"),
        later("ZYS-14"),
        later("ZYS-14"),
        later("not a ticket"),
        later("ZYS-15", "yesterday"),
      ]),
    ]);
    const out = await runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec });
    expect(out.verdict).toBe("superseded");
    expect(out.superseded_by.map((entry) => entry.id)).toEqual(["ZYS-14"]);
    expect(out.rejected).toEqual([
      { id: "ZYS-8", reason: "filed 2026-08-01T00:00:00.000Z, not after the ticket (2026-09-01T10:00:00.000Z)" },
      { id: "ZYS-9", reason: "filed 2026-09-01T10:00:00.000Z, not after the ticket (2026-09-01T10:00:00.000Z)" },
      { id: "ZYS-10", reason: "the ticket itself" },
      { id: "ZYS-14", reason: "named twice" },
      { id: "NOT A TICKET", reason: "not a Linear identifier" },
      { id: "ZYS-15", reason: "filing date yesterday is not a date" },
    ]);
  });

  it("is not_superseded when every candidate is dropped or none was named", async () => {
    const { exec } = fakeOmp([answer([later("ZYS-8", "2026-08-01T00:00:00.000Z")]), answer([])]);
    expect((await runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec })).verdict).toBe("not_superseded");
    expect((await runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec })).verdict).toBe("not_superseded");
  });

  it("is unverified when the ticket's own filing date is not a date", () => {
    const out = judgeSupersession("ZYS-10", { filed_at: "soon", superseded_by: [{ id: "ZYS-11", filed_at: FILED, why: "x" }], evidence: "e" });
    expect(out.verdict).toBe("unverified");
    expect(out.superseded_by).toEqual([]);
    expect(out.evidence).toMatch(/not a date \(soon\)/);
  });

  it("is unverified, never not_superseded, when the session cannot answer", async () => {
    const failing = fakeOmp([{ stdout: "", stderr: "Linear is not connected", code: 1, killed: false }]);
    const failed = await runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec: failing.exec });
    expect(failed).toMatchObject({ verdict: "unverified", filed_at: null, superseded_by: [], rejected: [] });
    expect(failed.evidence).toMatch(/the agent did not answer: .*exited 1: Linear is not connected/);

    const prose = fakeOmp(["I found nothing.", "Still nothing.", "No."]);
    const unanswered = await runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec: prose.exec });
    expect(unanswered.verdict).toBe("unverified");
    expect(unanswered.evidence).toMatch(/no valid reply after 3 attempts/);
    expect(prose.calls[1]!.prompt).toContain("Your previous reply was rejected");
  });

  it("asks again after a reply of the wrong shape", async () => {
    const { exec, calls } = fakeOmp([answer([{ id: "ZYS-14" }]), answer([later("ZYS-14")])]);
    const out = await runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec });
    expect(out.verdict).toBe("superseded");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("filed_at must be a non-empty string");
  });

  it("refuses a ticket that is not an identifier, and passes a cancellation through", async () => {
    const { exec, calls } = fakeOmp([]);
    await expect(runFindSupersedingTickets({ ticket: "everything" }, { exec })).rejects.toThrow(/not a Linear ticket identifier/);
    const controller = new AbortController();
    controller.abort();
    await expect(runFindSupersedingTickets({ ticket: "ZYS-10" }, { exec, signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("rejects an answer with an empty field", () => {
    expect(() => supersessionAnswerOf({ filed_at: "", superseded_by: [], evidence: "e" })).toThrow(/filed_at/);
    expect(() => supersessionAnswerOf({ filed_at: FILED, superseded_by: "none", evidence: "e" })).toThrow(/superseded_by must be an array/);
    expect(() => supersessionAnswerOf({ filed_at: FILED, superseded_by: [], evidence: " " })).toThrow(/evidence/);
  });
});

describe("loading against omp's own pi.zod", () => {
  it("returns a tool object and validates its parameters", async () => {
    const tool = factory({ zod: await loadZod(), exec: async () => ({}) } as never) as unknown as {
      name: string;
      description: string;
      parameters: { parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean } };
    };
    expect(tool.name).toBe("find_superseding_tickets");
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
    expect(check({ ticket: "ZYS-123" })).toBe(true);
    expect(check({ ticket: "" })).toBe(false);
    expect(check({ ticket: null })).toBe(false);
    expect(check({})).toBe(false);
  });
});
