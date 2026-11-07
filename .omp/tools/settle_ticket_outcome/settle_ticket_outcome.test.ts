import { describe, expect, it } from "bun:test";
import { fakeOmp } from "./fake_omp.js";
import { githubPort, type GitHubPort, type PullRequestState } from "./github.js";
import factory from "./index.js";
import { linearSessionPort, type LinearPort, type LinearRead, type LinearWrite } from "./linear.js";
import type { Exec, ExecResult } from "./omp_session.js";
import { sameWords } from "./reader_words.js";
import {
  closingOf,
  linkedPullsOf,
  READ_BACK_ATTEMPTS,
  READ_BACK_INTERVAL_MS,
  settleTicketOutcome,
  type SettleDeps,
  statusOf,
} from "./settle_ticket_outcome.js";
import { type Closing, OUTCOMES, ticketComment } from "./texts.js";
import { WORKSPACES } from "./workspaces.js";
import { loadZod } from "./zod_for_tests.js";

const OWN = "zachbornheimer";
const pull = (n: number, org = OWN): string => `https://github.com/${org}/app/pull/${n}`;

const closing = (outcome: Closing["outcome"], extra: Partial<Closing> = {}): Closing => ({
  outcome,
  summary: "The summary.",
  concerns: [],
  evidence: ["the evidence"],
  closeLinkedPullRequest: false,
  ...extra,
});

interface World {
  deps: SettleDeps;
  log: string[];
  pulls: Map<string, PullRequestState>;
  writes: LinearWrite[];
  sleeps: number[];
}

/**
 * A GitHub and a Linear that keep what is written to them. `reads` scripts the Linear read-back: each call answers the
 * next entry (the last repeats); by default it shows exactly what was written.
 */
function world(options: { pulls?: Record<string, PullRequestState>; reads?: (LinearRead | Error)[]; stuckOpen?: string[]; writeFails?: Error } = {}): World {
  const log: string[] = [];
  const pulls = new Map(Object.entries(options.pulls ?? {}));
  const writes: LinearWrite[] = [];
  const sleeps: number[] = [];
  let looks = 0;
  const github: GitHubPort = {
    async readPullRequest(url) {
      log.push(`read ${url}`);
      const state = pulls.get(url);
      if (state === undefined) throw new Error(`no such pull request ${url}`);
      return { url, state };
    },
    async closePullRequest({ url, comment }) {
      log.push(`close ${url} :: ${comment}`);
      if (!options.stuckOpen?.includes(url)) pulls.set(url, "CLOSED");
    },
  };
  const linear: LinearPort = {
    async write(_workspace, input) {
      log.push(`write ${input.ticket} ${input.status}`);
      if (options.writeFails !== undefined) throw options.writeFails;
      writes.push(input);
    },
    async read() {
      log.push("read-back");
      const scripted = options.reads?.[Math.min(looks++, options.reads.length - 1)];
      if (scripted instanceof Error) throw scripted;
      if (scripted !== undefined) return scripted;
      const last = writes.at(-1)!;
      return { status: last.status, comments: ["an older comment", last.comment] };
    },
  };
  return { deps: { github, linear, sleep: async (ms) => void sleeps.push(ms) }, log, pulls, writes, sleeps };
}

describe("settling a superseded ticket", () => {
  it("closes each open linked pull request with the reason, skips a merged one, marks the ticket a duplicate and comments", async () => {
    const w = world({ pulls: { [pull(1)]: "OPEN", [pull(2)]: "MERGED", [pull(3)]: "OPEN" } });
    const out = await settleTicketOutcome(
      {
        ticket: "zys-9",
        closing: closing("superseded", { summary: "Superseded by ZYS-14.", supersededBy: "ZYS-14", closeLinkedPullRequest: true }),
        linkedPulls: [pull(1), { url: pull(2), org: OWN, repo: "app", number: 2 }, pull(3)],
      },
      w.deps,
    );
    expect(out).toEqual({ status: "Duplicate", closedPullRequests: [pull(1), pull(3)] });
    expect(w.log.filter((line) => line.startsWith("close"))).toEqual([
      `close ${pull(1)} :: Closed by the software factory for ZYS-9 (superseded): Superseded by ZYS-14.`,
      `close ${pull(3)} :: Closed by the software factory for ZYS-9 (superseded): Superseded by ZYS-14.`,
    ]);
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]).toMatchObject({ ticket: "ZYS-9", status: "Duplicate", duplicateOf: "ZYS-14" });
    expect(w.writes[0]!.comment).toContain("**Software factory: Closed: superseded**");
    expect(w.writes[0]!.comment).toContain("Superseded by ZYS-14.");
    expect(w.writes[0]!.comment).toContain(`Closed pull requests:\n- ${pull(1)}\n- ${pull(3)}`);
    // GitHub first, then Linear, then the read-back.
    expect(w.log.at(-2)).toMatch(/^write ZYS-9 Duplicate/);
    expect(w.log.at(-1)).toBe("read-back");
  });

  it("is Canceled with no duplicate relation when it names no other ticket, or names itself", async () => {
    for (const supersededBy of [undefined, "ZYS-9", "not a ticket"]) {
      const w = world();
      const out = await settleTicketOutcome(
        { ticket: "ZYS-9", closing: closing("superseded", { ...(supersededBy === undefined ? {} : { supersededBy }) }), linkedPulls: [] },
        w.deps,
      );
      expect(out.status).toBe("Canceled");
      expect(w.writes[0]!.duplicateOf).toBeUndefined();
    }
  });

  it("accepts a superseding ticket in lower case", async () => {
    const w = world();
    await settleTicketOutcome({ ticket: "ZYS-9", closing: closing("superseded", { supersededBy: "zys-14" }), linkedPulls: [] }, w.deps);
    expect(w.writes[0]!.duplicateOf).toBe("ZYS-14");
  });
});

describe("what each outcome does", () => {
  it("leaves each outcome in the workspace's own status", () => {
    const zys = WORKSPACES.find((workspace) => workspace.team === "ZYS")!.statuses;
    const sah = WORKSPACES.find((workspace) => workspace.team === "SAH")!.statuses;
    const table = (statuses: typeof zys) =>
      OUTCOMES.filter((outcome) => outcome !== "busy").map((outcome) => [outcome, statusOf(outcome, undefined, statuses)]);
    expect(table(zys)).toEqual([
      ["undecipherable", "Initial Ticket Review"],
      ["already_done", "Done"],
      ["obsolete", "Canceled"],
      ["superseded", "Canceled"],
      ["needs_info", "Initial Ticket Review"],
      ["pr_ready", "Pull Request"],
      ["work_completed", "Done"],
      ["blocked", "Initial Ticket Review"],
    ]);
    expect(statusOf("blocked", undefined, sah)).toBe("Not Ready for Dev");
    expect(statusOf("superseded", "SAH-1", sah)).toBe("Duplicate");
  });

  it("writes SAH tickets with SAH's own status", async () => {
    const w = world();
    expect((await settleTicketOutcome({ ticket: "SAH-4", closing: closing("needs_info", { concerns: ["which API?"] }), linkedPulls: [] }, w.deps)).status).toBe("Not Ready for Dev");
    expect(w.writes[0]!.comment).toContain("Outstanding concerns:\n- which API?");
  });

  it("cites the published pull request, and closes nothing for pr_ready", async () => {
    const w = world({ pulls: { [pull(5)]: "OPEN" } });
    const out = await settleTicketOutcome(
      { ticket: "ZYS-9", closing: closing("pr_ready"), linkedPulls: [pull(5)], pullRequest: { url: pull(6), number: 6, draft: true } },
      w.deps,
    );
    expect(out).toEqual({ status: "Pull Request", closedPullRequests: [] });
    expect(w.writes[0]!.comment).toContain(`Draft pull request: ${pull(6)}`);
    expect(w.log.some((line) => line.startsWith("close") || line.startsWith("read https"))).toBe(false);
  });

  it("closes the linked pull requests of an obsolete ticket, and of an already_done one only when told", async () => {
    const obsolete = world({ pulls: { [pull(1)]: "OPEN" } });
    expect((await settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [pull(1)] }, obsolete.deps)).closedPullRequests).toEqual([pull(1)]);
    const kept = world({ pulls: { [pull(1)]: "OPEN" } });
    expect((await settleTicketOutcome({ ticket: "ZYS-9", closing: closing("already_done"), linkedPulls: [pull(1)] }, kept.deps)).closedPullRequests).toEqual([]);
    expect(kept.pulls.get(pull(1))).toBe("OPEN");
    const redundant = world({ pulls: { [pull(1)]: "OPEN" } });
    const out = await settleTicketOutcome(
      { ticket: "ZYS-9", closing: closing("already_done", { closeLinkedPullRequest: true }), linkedPulls: [pull(1)] },
      redundant.deps,
    );
    expect(out).toEqual({ status: "Done", closedPullRequests: [pull(1)] });
  });
});

describe("refusals", () => {
  it("settles nothing for a busy run, an unknown workspace, or a ticket that is not an identifier", async () => {
    const w = world();
    await expect(settleTicketOutcome({ ticket: "ZYS-9", closing: closing("busy"), linkedPulls: [] }, w.deps)).rejects.toThrow(/a busy run settles nothing/);
    await expect(settleTicketOutcome({ ticket: "ABC-1", closing: closing("obsolete"), linkedPulls: [] }, w.deps)).rejects.toThrow(/no Linear workspace/);
    await expect(settleTicketOutcome({ ticket: "nope", closing: closing("obsolete"), linkedPulls: [] }, w.deps)).rejects.toThrow(/not a Linear ticket identifier/);
    expect(w.log).toEqual([]);
  });

  it("refuses a third-party pull request before it closes any, so nothing is half settled", async () => {
    const w = world({ pulls: { [pull(1)]: "OPEN", [pull(2, "someone-else")]: "OPEN" } });
    await expect(
      settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [pull(1), pull(2, "someone-else")] }, w.deps),
    ).rejects.toThrow(/refusing to write to third-party GitHub organisation "someone-else"/);
    expect(w.log).toEqual([]);
    expect(w.pulls.get(pull(1))).toBe("OPEN");
  });

  it("does not look at a third-party pull request when the outcome closes none", async () => {
    const w = world();
    expect((await settleTicketOutcome({ ticket: "ZYS-9", closing: closing("pr_ready"), linkedPulls: [pull(2, "someone-else")] }, w.deps)).status).toBe("Pull Request");
  });

  it("refuses malformed input before any write", async () => {
    const w = world();
    const bad = (extra: object) => settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [], ...extra }, w.deps);
    await expect(bad({ linkedPulls: ["https://github.com/a/b/issues/3"] })).rejects.toThrow(/not a pull request URL/);
    await expect(bad({ linkedPulls: [42] })).rejects.toThrow(/linkedPulls\[0\]/);
    await expect(bad({ linkedPulls: "x" })).rejects.toThrow(/linkedPulls must be an array/);
    await expect(bad({ closing: { outcome: "gone" } })).rejects.toThrow(/outcome must be one of/);
    await expect(bad({ closing: { ...closing("obsolete"), concerns: "none" } })).rejects.toThrow(/concerns must be an array of strings/);
    await expect(bad({ closing: { ...closing("obsolete"), closeLinkedPullRequest: undefined } })).rejects.toThrow(/closeLinkedPullRequest must be a boolean/);
    await expect(bad({ pullRequest: { url: pull(1), number: 1.5, draft: false } })).rejects.toThrow(/pullRequest.number/);
    expect(w.log).toEqual([]);
  });

  it("reads a pull request URL's tail off, and lists it once", () => {
    expect(linkedPullsOf([`${pull(1)}/files`, pull(1), `${pull(1)}#issuecomment-5`, { url: pull(2) }])).toEqual([pull(1), pull(2)]);
    expect(closingOf({ ...closing("obsolete"), supersededBy: null }).supersededBy).toBeUndefined();
  });
});

describe("failures are loud and leave the rest unwritten", () => {
  it("fails when a closed pull request still reads as open, without writing to Linear", async () => {
    const w = world({ pulls: { [pull(1)]: "OPEN" }, stuckOpen: [pull(1)] });
    await expect(settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [pull(1)] }, w.deps)).rejects.toThrow(
      /closing it was not visible; it is still OPEN/,
    );
    expect(w.writes).toHaveLength(0);
  });

  it("lets a Linear write failure through", async () => {
    const w = world({ writeFails: new Error("Linear write on ZYS-9 did not complete: the comment was not posted") });
    await expect(settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [] }, w.deps)).rejects.toThrow(/did not complete/);
  });

  it("looks again when the read-back is stale, and succeeds once the write shows", async () => {
    const w = world({
      reads: [
        { status: "Unreviewed", comments: [] },
        { status: "Canceled", comments: [] },
        { status: "Canceled", comments: ["x", "**Software factory: Canceled: obsolete**\n\nThe summary.\n\nEvidence:\n- the evidence"] },
      ],
    });
    expect((await settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [] }, w.deps)).status).toBe("Canceled");
    expect(w.sleeps).toEqual([READ_BACK_INTERVAL_MS, READ_BACK_INTERVAL_MS]);
  });

  it("fails after the last look when the status never shows, or the comment never does", async () => {
    const wrongStatus = world({ reads: [{ status: "Unreviewed", comments: [] }] });
    await expect(settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [] }, wrongStatus.deps)).rejects.toThrow(
      /asked for status "Canceled", the read-back says "Unreviewed"/,
    );
    expect(wrongStatus.log.filter((line) => line === "read-back")).toHaveLength(READ_BACK_ATTEMPTS);
    const noComment = world({ reads: [{ status: "Canceled", comments: ["something else"] }] });
    await expect(settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [] }, noComment.deps)).rejects.toThrow(
      /no comment on it carries the body that was posted/,
    );
  });

  it("does not retry a read-back session that itself fails", async () => {
    const w = world({ reads: [new Error("Linear MCP is down")] });
    await expect(settleTicketOutcome({ ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [] }, w.deps)).rejects.toThrow(/Linear MCP is down/);
    expect(w.log.filter((line) => line === "read-back")).toHaveLength(1);
  });
});

describe("comparing a comment with what Linear stored", () => {
  it("sees through the rewrites Linear makes", () => {
    const written = ticketComment(closing("superseded", { evidence: ["see zachbornheimer/app#7 and [the doc](https://x.dev/a)"] }), {
      closedPullRequests: [],
      supersededBy: "ZYS-14",
    });
    const stored = written
      .replace("zachbornheimer/app#7", '<pull-request id="u" href="https://github.com/x/y/pull/7">zachbornheimer/app#7</pull-request>')
      .replace("ZYS-14", '<issue id="u" label="ZYS-14" href="https://linear.app/x"/>')
      .replace("(https://x.dev/a)", "(<https://x.dev/a>)");
    expect(sameWords(stored, written)).toBe(true);
    expect(sameWords("something else", written)).toBe(false);
  });
});

describe("the live Linear port", () => {
  const ZYS = WORKSPACES.find((workspace) => workspace.team === "ZYS")!;
  const write: LinearWrite = { ticket: "ZYS-9", status: "Duplicate", duplicateOf: "ZYS-14", comment: "**Software factory: Closed: superseded**\n\nSuperseded by ZYS-14." };
  const ok = JSON.stringify({ status_set: true, duplicate_linked: true, comment_posted: true, problem: null });

  it("tells a full session the status, the duplicate relation and the comment verbatim", async () => {
    const { exec, calls } = fakeOmp([ok]);
    await linearSessionPort({ exec }).write(ZYS, write);
    const prompt = calls[0]!.prompt;
    expect(calls[0]!.args).not.toContain("--no-tools");
    expect(prompt).toContain('Set its status to exactly "Duplicate"');
    expect(prompt).toContain("duplicates ZYS-14");
    expect(prompt).toContain(`----- COMMENT BEGIN -----\n${write.comment}\n----- COMMENT END -----`);
    expect(prompt).toContain('"linear-personal"');
    expect(prompt).toContain("NEVER call the omp tools prepare_ticket");
  });

  it("fails, naming what is missing, when the session says a write did not happen", async () => {
    const half = fakeOmp([JSON.stringify({ status_set: true, duplicate_linked: false, comment_posted: false, problem: "relations are read-only" })]);
    await expect(linearSessionPort({ exec: half.exec }).write(ZYS, write)).rejects.toThrow(
      /did not complete: the duplicate relation to ZYS-14 was not recorded; the comment was not posted \(relations are read-only\)/,
    );
    const noStatus = fakeOmp([JSON.stringify({ status_set: false, comment_posted: false, problem: 'no status named "Duplicate"' })]);
    await expect(linearSessionPort({ exec: noStatus.exec }).write(ZYS, { ...write, duplicateOf: undefined })).rejects.toThrow(
      /the status was not set to "Duplicate".*no status named/,
    );
  });

  it("asks again after a bad reply with a prompt that checks before it writes, so the comment is never posted twice", async () => {
    const { exec, calls } = fakeOmp(["done", ok]);
    await linearSessionPort({ exec }).write(ZYS, write);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("never post the comment a second time");
    expect(calls[1]!.prompt).toContain("the reply is not one JSON object");
  });

  it("reads back in a read-only session that is not told what to expect", async () => {
    const { exec, calls } = fakeOmp([JSON.stringify({ status: "Duplicate", comments: [write.comment, "older"] })]);
    const seen = await linearSessionPort({ exec }).read(ZYS, "ZYS-9");
    expect(seen).toEqual({ status: "Duplicate", comments: [write.comment, "older"] });
    expect(calls[0]!.prompt).toContain("read-only check: change nothing");
    expect(calls[0]!.prompt).not.toContain("Duplicate");
    const bad = JSON.stringify({ status: "X", comments: [1] });
    await expect(linearSessionPort({ exec: fakeOmp([bad, bad, bad]).exec }).read(ZYS, "ZYS-9")).rejects.toThrow(
      /no valid reply after 3 attempts: comments must be an array of strings/,
    );
  });
});

describe("the GitHub port", () => {
  function ghExec(replies: Record<string, string | ExecResult>): { exec: Exec; calls: string[][] } {
    const calls: string[][] = [];
    const exec: Exec = async (command, args) => {
      expect(command).toBe("gh");
      calls.push(args);
      const reply = replies[args.slice(0, 2).join(" ")];
      if (reply === undefined) throw new Error(`no fake for gh ${args.join(" ")}`);
      return typeof reply === "string" ? { stdout: reply, stderr: "", code: 0, killed: false } : reply;
    };
    return { exec, calls };
  }

  it("reads a pull request's state and closes it with the reason as a comment", async () => {
    const { exec, calls } = ghExec({ "pr view": JSON.stringify({ url: pull(1), state: "OPEN" }), "pr close": "" });
    const port = githubPort(exec);
    expect(await port.readPullRequest(pull(1))).toEqual({ url: pull(1), state: "OPEN" });
    await port.closePullRequest({ url: pull(1), comment: "because" });
    expect(calls).toEqual([
      ["pr", "view", pull(1), "--json", "url,state"],
      ["pr", "close", pull(1), "--comment", "because"],
    ]);
  });

  it("refuses what is not a pull request URL, and fails on a gh error or an unknown state", async () => {
    const { exec } = ghExec({
      "pr view": { stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest", code: 1, killed: false },
      "pr close": JSON.stringify({}),
    });
    const port = githubPort(exec);
    await expect(port.readPullRequest("https://github.com/a/b")).rejects.toThrow(/not a pull request URL/);
    await expect(port.closePullRequest({ url: "nope", comment: "x" })).rejects.toThrow(/not a pull request URL/);
    await expect(port.readPullRequest(pull(1))).rejects.toThrow(/gh pr view exited 1: GraphQL: Could not resolve/);
    const odd = githubPort(ghExec({ "pr view": JSON.stringify({ url: pull(1), state: "DRAFT" }) }).exec);
    await expect(odd.readPullRequest(pull(1))).rejects.toThrow(/state "DRAFT"/);
  });

  it("settles end to end through the live ports", async () => {
    let views = 0;
    const ghCalls: string[][] = [];
    const omp = fakeOmp([
      JSON.stringify({ status_set: true, duplicate_linked: null, comment_posted: true, problem: null }),
      () => {
        const comment = /----- COMMENT BEGIN -----\n([\s\S]*?)\n----- COMMENT END -----/.exec(omp.calls[0]!.prompt)![1]!;
        return JSON.stringify({ status: "Canceled", comments: [comment] });
      },
    ]);
    const exec: Exec = async (command, args, options) => {
      if (command === "omp") return omp.exec(command, args, options);
      ghCalls.push(args);
      if (args[1] === "view") {
        views += 1;
        return { stdout: JSON.stringify({ url: pull(1), state: views === 1 ? "OPEN" : "CLOSED" }), stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    };
    const out = await settleTicketOutcome(
      { ticket: "ZYS-9", closing: closing("obsolete"), linkedPulls: [pull(1)] },
      { github: githubPort(exec), linear: linearSessionPort({ exec }), sleep: async () => {} },
    );
    expect(out).toEqual({ status: "Canceled", closedPullRequests: [pull(1)] });
    expect(ghCalls.map((args) => args.slice(0, 2).join(" "))).toEqual(["pr view", "pr close", "pr view"]);
    expect(omp.calls).toHaveLength(2);
  });
});

describe("loading against omp's own pi.zod", () => {
  it("returns a tool object and validates its parameters", async () => {
    const tool = factory({ zod: await loadZod(), exec: async () => ({}) } as never) as unknown as {
      name: string;
      description: string;
      parameters: { parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean } };
    };
    expect(tool.name).toBe("settle_ticket_outcome");
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
    const valid = {
      ticket: "ZYS-9",
      closing: { outcome: "superseded", summary: "s", concerns: [], evidence: ["e"], supersededBy: "ZYS-14", closeLinkedPullRequest: true },
      linkedPulls: [pull(1), { url: pull(2) }],
    };
    expect(check(valid)).toBe(true);
    expect(check({ ...valid, pullRequest: { url: pull(3), number: 3, draft: false } })).toBe(true);
    expect(check({ ...valid, pullRequest: null, closing: { ...valid.closing, supersededBy: null } })).toBe(true);
    expect(check({ ...valid, closing: { ...valid.closing, outcome: "gone" } })).toBe(false);
    expect(check({ ...valid, linkedPulls: "x" })).toBe(false);
    expect(check({ ...valid, ticket: "" })).toBe(false);
    expect(check({ ticket: "ZYS-9" })).toBe(false);
  });
});
