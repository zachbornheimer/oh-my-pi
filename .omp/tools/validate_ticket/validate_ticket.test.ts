import { describe, expect, it } from "bun:test";
import { fakeOmp, type Reply } from "./fake_omp.js";
import type { FindSupersedingTicketsOutput } from "./find_superseding_tickets.js";
import factory from "./index.js";
import type { Exec, ExecResult } from "./omp_session.js";
import {
  candidateLines,
  liveValidateTicketPorts,
  type PullRequestCandidate,
  reviewOf,
  runValidateTicket,
  supersessionInputOf,
  type ValidateTicketPorts,
} from "./validate_ticket.js";
import { loadZod } from "./zod_for_tests.js";

const FILED = "2026-09-01T10:00:00.000Z";
const LATER = "2026-09-20T08:30:00.000Z";

const ANSWER = {
  status: "Ready for Development",
  status_type: "unstarted",
  already_resolved: false,
  open_pull_requests: [] as string[],
  evidence: "The code does not do what the ticket asks and no pull request links it.",
};
const PR: PullRequestCandidate = { url: "https://github.com/zysys/app/pull/7", title: "ZYS-9: fix the thing", isDraft: false };

const supersession = (
  verdict: FindSupersedingTicketsOutput["verdict"],
  superseded_by: FindSupersedingTicketsOutput["superseded_by"] = [],
): FindSupersedingTicketsOutput => ({
  ticket: "ZYS-9",
  verdict,
  filed_at: FILED,
  superseded_by,
  rejected: [],
  evidence: verdict === "unverified" ? "the agent did not answer" : "searched",
});

interface ScriptedPorts extends ValidateTicketPorts {
  readonly reviewCalls: unknown[][];
  readonly superseding: { calls: number };
}

/** The ports with a search, a review script and a supersession answer. */
function ports(options: {
  search?: readonly PullRequestCandidate[] | Error;
  replies: readonly (Record<string, unknown> | Error)[];
  superseding?: FindSupersedingTicketsOutput;
}): ScriptedPorts {
  let turn = 0;
  const reviewCalls: unknown[][] = [];
  const superseding = { calls: 0 };
  return {
    reviewCalls,
    superseding,
    async searchPullRequests() {
      if (options.search instanceof Error) throw options.search;
      return options.search ?? [];
    },
    async review(ticket, candidates) {
      reviewCalls.push([ticket, candidates]);
      const reply = options.replies[Math.min(turn++, options.replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async findSuperseding() {
      superseding.calls++;
      return options.superseding ?? supersession("not_superseded");
    },
  };
}

describe("validate_ticket", () => {
  it("rejects a ticket id that is not a Linear identifier, so it can never become a search flag", async () => {
    for (const ticket of ["", "--owner", "ZYS", "ZYS-", "-123", "ZYS-12 foo"]) {
      await expect(runValidateTicket({ ticket }, ports({ replies: [ANSWER] }))).rejects.toThrow(/not a Linear ticket identifier/);
    }
  });

  it("calls an open, unstarted, unsuperseded ticket with no pull request current", async () => {
    const result = await runValidateTicket({ ticket: "zys-9" }, ports({ replies: [ANSWER] }));
    expect(result.ticket).toBe("ZYS-9");
    expect(result.verdict).toBe("current");
    expect(result.reasons).toEqual([]);
    expect(result.pull_request_search).toEqual({ status: "measured", candidates: 0 });
  });

  it("stays current when an open pull request addresses it: unlanded work is not done, so the pull request is only listed", async () => {
    const result = await runValidateTicket(
      { ticket: "ZYS-9" },
      ports({ search: [PR], replies: [{ ...ANSWER, status_type: "started", open_pull_requests: [PR.url] }] }),
    );
    expect(result.verdict).toBe("current");
    expect(result.open_pull_requests).toEqual([{ url: PR.url, title: PR.title }]);
  });

  it("keeps a pull request found only through the ticket's links, with no title", async () => {
    const linked = "https://github.com/zysys/app/pull/11";
    const result = await runValidateTicket({ ticket: "ZYS-9" }, ports({ replies: [{ ...ANSWER, open_pull_requests: [linked] }] }));
    expect(result.open_pull_requests).toEqual([{ url: linked, title: null }]);
  });

  it("is not current when the ticket is completed or canceled, or already delivered", async () => {
    const canceled = await runValidateTicket(
      { ticket: "ZYS-9" },
      ports({ replies: [{ ...ANSWER, status: "Canceled", status_type: "canceled" }] }),
    );
    expect(canceled.verdict).toBe("not_current");
    expect(canceled.reasons[0]).toContain("Canceled");
    const done = await runValidateTicket({ ticket: "ZYS-9" }, ports({ replies: [{ ...ANSWER, status: "Done", status_type: "completed" }] }));
    expect(done.verdict).toBe("not_current");
    const resolved = await runValidateTicket({ ticket: "ZYS-9" }, ports({ replies: [{ ...ANSWER, already_resolved: true }] }));
    expect(resolved.verdict).toBe("not_current");
    expect(resolved.reasons).toEqual(["the repository or a merged pull request already delivers it"]);
  });

  it("is not current when a later ticket supersedes it, and lists the open pull requests to close with it", async () => {
    const by = [{ id: "ZYS-14", filed_at: LATER, why: "replaces the approach" }];
    const result = await runValidateTicket(
      { ticket: "ZYS-9" },
      ports({
        search: [PR],
        replies: [{ ...ANSWER, status_type: "started", open_pull_requests: [PR.url] }],
        superseding: supersession("superseded", by),
      }),
    );
    expect(result.verdict).toBe("not_current");
    expect(result.superseded_by).toEqual(by);
    expect(result.reasons.join("\n")).toContain("ZYS-14");
    expect(result.reasons.join("\n")).toContain(`closed with it: ${PR.url}`);
  });

  it("runs find_superseding_tickets unless the caller passed its result", async () => {
    const ran = ports({ replies: [ANSWER] });
    await runValidateTicket({ ticket: "ZYS-9" }, ran);
    expect(ran.superseding.calls).toBe(1);
    const given = ports({ replies: [ANSWER] });
    const result = await runValidateTicket(
      { ticket: "ZYS-9", supersession: supersession("superseded", [{ id: "ZYS-14", filed_at: LATER, why: "x" }]) },
      given,
    );
    expect(given.superseding.calls).toBe(0);
    expect(result.verdict).toBe("not_current");
  });

  it("is unverified when the supersession check could not answer, but a finding still wins", async () => {
    const unverified = await runValidateTicket({ ticket: "ZYS-9" }, ports({ replies: [ANSWER], superseding: supersession("unverified") }));
    expect(unverified.verdict).toBe("unverified");
    expect(unverified.reasons[0]).toContain("supersession unchecked");
    const finding = await runValidateTicket(
      { ticket: "ZYS-9" },
      ports({ replies: [{ ...ANSWER, status_type: "completed" }], superseding: supersession("unverified") }),
    );
    expect(finding.verdict).toBe("not_current");
  });

  it("does not let a failed pull request search change the verdict, and tells the agent to look through the ticket", async () => {
    const failing = ports({ search: new Error("gh: not logged in"), replies: [ANSWER] });
    const result = await runValidateTicket({ ticket: "ZYS-9" }, failing);
    expect(result.verdict).toBe("current");
    expect(result.pull_request_search).toEqual({ status: "unmeasured", reason: "gh: not logged in" });
    expect(failing.reviewCalls[0]![1]).toContain("The search failed (gh: not logged in)");
  });

  it("is unverified with null answers when the agent cannot answer or answers off-schema", async () => {
    const down = await runValidateTicket({ ticket: "ZYS-9" }, ports({ replies: [new Error("no reply")] }));
    expect(down.verdict).toBe("unverified");
    expect(down.reasons[0]).toContain("no reply");
    expect(down.status).toBeNull();
    expect(down.already_resolved).toBeNull();
    const offSchema = await runValidateTicket({ ticket: "ZYS-9" }, ports({ replies: [{ ...ANSWER, status_type: "in progress" }] }));
    expect(offSchema.verdict).toBe("unverified");
  });

  it("hands the agent the search candidates", async () => {
    const asked = ports({ search: [PR, { ...PR, url: "https://github.com/zysys/app/pull/8", isDraft: true }], replies: [ANSWER] });
    await runValidateTicket({ ticket: "zys-9" }, asked);
    expect(asked.reviewCalls[0]![0]).toBe("ZYS-9");
    expect(asked.reviewCalls[0]![1]).toBe(`- ${PR.url} — ${PR.title}\n- https://github.com/zysys/app/pull/8 — ${PR.title} (draft)`);
    expect(candidateLines({ status: "measured", candidates: 0 }, [])).toBe("None: no open pull request mentions the ticket.");
  });

  it("lets a cancellation through instead of recording it as an unanswered check", async () => {
    const controller = new AbortController();
    const cancelled: ValidateTicketPorts = {
      async searchPullRequests() {
        return [];
      },
      async review() {
        controller.abort();
        throw new Error("stopped");
      },
      async findSuperseding() {
        return supersession("not_superseded");
      },
    };
    await expect(runValidateTicket({ ticket: "ZYS-9" }, cancelled, controller.signal)).rejects.toThrow();
  });
});

describe("the supersession a caller passes", () => {
  it("accepts the narrow shape optimize_tooling hands over and fills the rest", () => {
    const given = supersessionInputOf(
      { verdict: "superseded", superseded_by: [{ id: "zys-14", filed_at: LATER, why: "x" }], evidence: "e" },
      "ZYS-9",
    );
    expect(given).toEqual({
      ticket: "ZYS-9",
      verdict: "superseded",
      filed_at: null,
      superseded_by: [{ id: "ZYS-14", filed_at: LATER, why: "x" }],
      rejected: [],
      evidence: "e",
    });
  });

  it("refuses one for another ticket, one that is superseded with nothing superseding it, and a contradiction", () => {
    expect(() => supersessionInputOf({ ...supersession("not_superseded"), ticket: "ZYS-1" }, "ZYS-9")).toThrow(/for ZYS-1, not ZYS-9/);
    expect(() => supersessionInputOf(supersession("superseded"), "ZYS-9")).toThrow(/names no superseding ticket/);
    expect(() => supersessionInputOf(supersession("not_superseded", [{ id: "ZYS-2", filed_at: LATER, why: "x" }]), "ZYS-9")).toThrow(
      /says not_superseded but names/,
    );
    expect(() => supersessionInputOf({ verdict: "maybe", superseded_by: [], evidence: "" }, "ZYS-9")).toThrow(/verdict must be one of/);
    expect(() => supersessionInputOf("superseded", "ZYS-9")).toThrow(/must be an object/);
    expect(() => supersessionInputOf({ verdict: "superseded", superseded_by: [{ id: "x", filed_at: LATER, why: "w" }], evidence: "" }, "ZYS-9")).toThrow(
      /not a Linear identifier/,
    );
  });

  it("is refused before any source runs", async () => {
    const sources = ports({ replies: [ANSWER] });
    await expect(runValidateTicket({ ticket: "ZYS-9", supersession: { ...supersession("not_superseded"), ticket: "ZYS-1" } }, sources)).rejects.toThrow(
      /for ZYS-1/,
    );
    expect(sources.reviewCalls).toHaveLength(0);
    expect(sources.superseding.calls).toBe(0);
  });
});

describe("the review's answer", () => {
  it("accepts only full pull request URLs, each once", () => {
    const url = "https://github.com/zysys/app/pull/7";
    expect(reviewOf({ ...ANSWER, open_pull_requests: [url, url] }).open_pull_requests).toEqual([url]);
    for (const bad of ["#7", "https://github.com/zysys/app/pull/7/files", "https://github.com/zysys/app/issues/7", "pull 7"]) {
      expect(() => reviewOf({ ...ANSWER, open_pull_requests: [bad] })).toThrow(/not a full/);
    }
    expect(() => reviewOf({ ...ANSWER, already_resolved: "no" })).toThrow(/already_resolved must be a boolean/);
  });
});

/** `gh` answers from a table keyed by its first two arguments; `omp` from a script. */
function liveExec(options: { gh: Record<string, string | ExecResult>; omp: Reply[] }): { exec: Exec; ghCalls: string[][]; ompCalls: { args: string[]; prompt: string }[] } {
  const omp = fakeOmp(options.omp);
  const ghCalls: string[][] = [];
  const exec: Exec = async (command, args, execOptions) => {
    if (command === "omp") return omp.exec(command, args, execOptions);
    expect(command).toBe("gh");
    ghCalls.push(args);
    const reply = options.gh[args.slice(0, 2).join(" ")];
    if (reply === undefined) throw new Error(`no fake for gh ${args.join(" ")}`);
    return typeof reply === "string" ? { stdout: reply, stderr: "", code: 0, killed: false } : reply;
  };
  return { exec, ghCalls, ompCalls: omp.calls };
}

describe("the live ports", () => {
  const search = JSON.stringify([{ url: PR.url, title: PR.title, isDraft: false }]);

  it("searches every owner the user belongs to for the ticket as a phrase, and reviews with the candidates", async () => {
    const { exec, ghCalls, ompCalls } = liveExec({
      gh: { "api user": "zachbornheimer\n", "api user/orgs": "zysys\nSoftware-Automation-Holdings-LLC\n", "search prs": search },
      omp: [JSON.stringify({ ...ANSWER, status_type: "started", open_pull_requests: [PR.url] })],
    });
    const result = await runValidateTicket(
      { ticket: "zys-9", supersession: { verdict: "not_superseded", superseded_by: [], evidence: "none" } },
      liveValidateTicketPorts({ exec, addDirs: ["/scratch/dev"] }),
    );
    expect(result.verdict).toBe("current");
    expect(result.pull_request_search).toEqual({ status: "measured", candidates: 1 });
    expect(result.open_pull_requests).toEqual([{ url: PR.url, title: PR.title }]);
    const searchArgs = ghCalls.find((args) => args[0] === "search")!;
    expect(searchArgs.slice(0, 3)).toEqual(["search", "prs", '"ZYS-9"']);
    expect(searchArgs).toContain("open");
    expect(searchArgs.join(" ")).toContain("--owner zachbornheimer --owner zysys --owner Software-Automation-Holdings-LLC");
    expect(ompCalls).toHaveLength(1);
    expect(ompCalls[0]!.args).toContain("--add-dir=/scratch/dev");
    expect(ompCalls[0]!.args).toContain("--no-session");
    expect(ompCalls[0]!.prompt).toContain(`- ${PR.url} — ${PR.title}`);
    expect(ompCalls[0]!.prompt).toContain("Check whether Linear ticket ZYS-9 is still current");
  });

  it("runs the supersession check when none is passed, and asks the review again after a bad answer", async () => {
    const { exec, ompCalls } = liveExec({
      gh: { "api user": "me", "api user/orgs": "", "search prs": "[]" },
      omp: [
        JSON.stringify({ filed_at: FILED, superseded_by: [{ id: "ZYS-14", filed_at: LATER, why: "covers it" }], evidence: "e" }),
        "Looks open to me.",
        JSON.stringify(ANSWER),
      ],
    });
    const result = await runValidateTicket({ ticket: "ZYS-9" }, liveValidateTicketPorts({ exec, addDirs: [] }));
    expect(result.verdict).toBe("not_current");
    expect(result.superseded_by.map((later) => later.id)).toEqual(["ZYS-14"]);
    expect(ompCalls).toHaveLength(3);
    expect(ompCalls[0]!.prompt).toContain("Find which Linear tickets");
    expect(ompCalls[2]!.prompt).toContain("Your previous reply was rejected");
    expect(ompCalls[1]!.args.some((arg) => arg.startsWith("--add-dir"))).toBe(false);
  });

  it("records a gh failure as an unmeasured search, and a gh with no signed-in user is never searched without an owner", async () => {
    const failing = liveExec({
      gh: {
        "api user": { stdout: "", stderr: "gh: To get started with GitHub CLI, please run: gh auth login", code: 4, killed: false },
        "api user/orgs": "",
      },
      omp: [JSON.stringify(ANSWER)],
    });
    const result = await runValidateTicket(
      { ticket: "ZYS-9", supersession: supersession("not_superseded") },
      liveValidateTicketPorts({ exec: failing.exec, addDirs: [] }),
    );
    expect(result.verdict).toBe("current");
    expect(result.pull_request_search.status).toBe("unmeasured");
    expect(failing.ghCalls.some((args) => args[0] === "search")).toBe(false);

    const silent = liveExec({ gh: { "api user": "", "api user/orgs": "" }, omp: [] });
    await expect(liveValidateTicketPorts({ exec: silent.exec, addDirs: [] }).searchPullRequests("ZYS-9")).rejects.toThrow(
      /no signed-in GitHub user/,
    );
  });

  it("records a review that exits non-zero as unverified, never as current", async () => {
    const { exec } = liveExec({
      gh: { "api user": "me", "api user/orgs": "", "search prs": "[]" },
      omp: [{ stdout: "", stderr: "Linear is not connected", code: 1, killed: false }],
    });
    const result = await runValidateTicket(
      { ticket: "ZYS-9", supersession: supersession("not_superseded") },
      liveValidateTicketPorts({ exec, addDirs: [] }),
    );
    expect(result.verdict).toBe("unverified");
    expect(result.reasons[0]).toMatch(/review unanswered: .*Linear is not connected/);
  });
});

describe("loading against omp's own pi.zod", () => {
  it("returns a tool object and validates its parameters", async () => {
    const tool = factory({ zod: await loadZod(), exec: async () => ({}) } as never) as unknown as {
      name: string;
      description: string;
      parameters: { parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean } };
    };
    expect(tool.name).toBe("validate_ticket");
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
    expect(check({ ticket: "ZYS-123", supersession: null })).toBe(true);
    expect(check({ ticket: "ZYS-123", supersession: { verdict: "superseded", superseded_by: [{ id: "ZYS-9", filed_at: LATER, why: "x" }], evidence: "e" } })).toBe(true);
    expect(check({ ticket: "ZYS-123", supersession: { ...supersession("not_superseded"), rejected: null, ticket: null } })).toBe(true);
    expect(check({ ticket: "" })).toBe(false);
    expect(check({ ticket: "ZYS-123", supersession: { verdict: "maybe", superseded_by: [], evidence: "" } })).toBe(false);
    expect(check({})).toBe(false);
  });
});
