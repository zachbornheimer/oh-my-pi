import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ataskCli } from "./atask.js";
import { DEFAULT_TEST_COMMAND, implementerPrompt, parseInput, runExecuteTicket, TEST_COMMAND_ENV } from "./execute.js";
import { amalgamateFindings, type Finding, parseFindings, type RoundInputs } from "./findings.js";
import { linearKeyVariable, linearPort } from "./linear.js";
import { askJson, type Exec, type ExecResult, ompAgentStep, ompModelStep, parseJsonReply, withHeartbeat } from "./omp.js";
import { CommandError, repoPort } from "./repo.js";
import { reviewPrompt, codeReview, securityReview, CODE_REVIEW_INSTRUCTIONS, SECURITY_REVIEW_INSTRUCTIONS } from "./reviews.js";
import { type ExecuteTicketOutput, executeTicket, roundCommitMessage } from "./run.js";
import { type AtaskFilePort, type LinearPort, type LinearTicket, ticketResolver } from "./ticket.js";

const finding = (severity: Finding["severity"]): Finding => ({ severity, path: "src/a.ts", description: "what is wrong" });
const ok = (stdout = "", stderr = ""): ExecResult => ({ stdout, stderr, code: 0, killed: false });
const fail = (stderr = "", stdout = "", code = 1): ExecResult => ({ stdout, stderr, code, killed: false });

/** A fake exec: `handler` answers by "command arg arg" and every call is recorded. Unmatched calls throw. */
function machine(handler: (line: string, cwd: string | undefined) => ExecResult | Error | undefined) {
  const calls: string[] = [];
  const exec: Exec = async (command, args, options) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const answer = handler(line, options?.cwd);
    if (answer === undefined) throw new Error(`unexpected command: ${line}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, exec };
}

// ---------------------------------------------------------------- findings

describe("amalgamateFindings", () => {
  const inputs = (round: Partial<RoundInputs>): RoundInputs => ({
    codeFindings: [],
    securityFindings: [],
    tests: { ok: true, output: "" },
    ...round,
  });

  it("lands only when no blocking finding stands and the gate is green", () => {
    const verdict = amalgamateFindings(inputs({ codeFindings: [finding("blocking")] }));
    expect(verdict.verdict).toBe("fix");
    expect(verdict.blockers).toHaveLength(1);
    expect(amalgamateFindings(inputs({ securityFindings: [finding("blocking")] })).verdict).toBe("fix");
  });

  it("never lets a suggestion or a nit block a landing", () => {
    const verdict = amalgamateFindings(inputs({ codeFindings: [finding("suggestion"), finding("nit")] }));
    expect(verdict.verdict).toBe("land");
    expect(verdict.suggestions).toHaveLength(2);
  });

  it("carries the test output as a blocker when the gate is red", () => {
    const verdict = amalgamateFindings(inputs({ tests: { ok: false, output: "3 failed" } }));
    expect(verdict.verdict).toBe("fix");
    expect(verdict.blockers).toEqual([expect.stringContaining("3 failed")]);
  });

  it("writes a finding as severity, site and fix", () => {
    const verdict = amalgamateFindings(inputs({ codeFindings: [{ ...finding("blocking"), line: 7, fix: "do x" }] }));
    expect(verdict.blockers).toEqual(["[blocking] src/a.ts:7: what is wrong. Fix: do x"]);
  });
});

describe("parseFindings", () => {
  it("accepts an empty list and a full finding", () => {
    expect(parseFindings({ findings: [] })).toEqual([]);
    expect(parseFindings({ findings: [{ severity: "nit", path: "a", line: 2, description: "d", fix: "f" }] })).toEqual([
      { severity: "nit", path: "a", line: 2, description: "d", fix: "f" },
    ]);
  });

  it("refuses every malformed shape, naming the field", () => {
    expect(() => parseFindings(null)).toThrow("object");
    expect(() => parseFindings({})).toThrow("findings must be an array");
    expect(() => parseFindings({ findings: [], extra: 1 })).toThrow("unexpected key");
    expect(() => parseFindings({ findings: [{ severity: "bad", path: "a", description: "d" }] })).toThrow("findings[0].severity");
    expect(() => parseFindings({ findings: [{ severity: "nit", path: "", description: "d" }] })).toThrow("findings[0].path");
    expect(() => parseFindings({ findings: [{ severity: "nit", path: "a", description: "" }] })).toThrow("findings[0].description");
    expect(() => parseFindings({ findings: [{ severity: "nit", path: "a", description: "d", line: 0 }] })).toThrow("findings[0].line");
    expect(() => parseFindings({ findings: [{ severity: "nit", path: "a", description: "d", fix: 1 }] })).toThrow("findings[0].fix");
    expect(() => parseFindings({ findings: [{ severity: "nit", path: "a", description: "d", why: 1 }] })).toThrow("unexpected key");
  });
});

// ---------------------------------------------------------------- reviews

describe("reviews", () => {
  it("puts the focus and the diff as data in the prompt, with the reply schema", () => {
    const prompt = reviewPrompt(CODE_REVIEW_INSTRUCTIONS, "--- a/x\n+++ b/x", "Add the flag");
    expect(prompt).toContain("Add the flag");
    expect(prompt).toContain("--- a/x\n+++ b/x");
    expect(prompt).toContain('"required":["findings"]');
    expect(prompt).toContain("Do not report security exposure");
    expect(reviewPrompt(SECURITY_REVIEW_INSTRUCTIONS, "d", "")).toContain("security findings only");
  });

  it("asks again with the reason when the reply is not valid, then returns the findings", async () => {
    const prompts: string[] = [];
    const replies = ["not json", JSON.stringify({ findings: [{ severity: "blocking", path: "a", description: "d" }] })];
    const found = await codeReview(async (prompt) => {
      prompts.push(prompt);
      return replies.shift()!;
    })("diff", "focus");
    expect(found).toEqual([{ severity: "blocking", path: "a", description: "d" }]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("was rejected");
  });

  it("fails naming the review after three bad replies", async () => {
    let asked = 0;
    await expect(
      securityReview(async () => {
        asked += 1;
        return '{"findings":"none"}';
      })("diff", ""),
    ).rejects.toThrow("security review: no valid reply after 3 attempts");
    expect(asked).toBe(3);
  });
});

// ---------------------------------------------------------------- omp helpers

describe("omp steps", () => {
  it("runs a bare completion from a private prompt file removed afterwards", async () => {
    let file = "";
    let promptText = "";
    const { exec } = machine((line) => {
      file = /@(\S+)/.exec(line)![1]!;
      promptText = readFileSync(file, "utf8");
      return ok("  the reply \n");
    });
    expect(await ompModelStep(exec)("hello")).toBe("the reply");
    expect(promptText).toBe("hello");
    expect(existsSync(file)).toBe(false);
  });

  it("fails on a killed, non-zero or empty model run and still removes the prompt file", async () => {
    let file = "";
    const run = (answer: ExecResult) =>
      ompModelStep(async (_c, args) => {
        file = /^@(.*)$/.exec(args[1]!)![1]!;
        return answer;
      })("p");
    await expect(run({ ...ok(), killed: true })).rejects.toThrow("killed");
    await expect(run(fail("boom", "", 3))).rejects.toThrow("exited 3: boom");
    await expect(run(ok("  "))).rejects.toThrow("no text");
    expect(existsSync(file)).toBe(false);
  });

  it("runs the implementer as a full omp session in the worktree, with no session file and no extensions", async () => {
    const seen: { args: string[]; cwd?: string }[] = [];
    const exec: Exec = async (_c, args, options) => {
      seen.push({ args, cwd: options?.cwd });
      return ok();
    };
    await ompAgentStep(exec, { pinModel: undefined })({ cwd: "/wt/x", prompt: "do it" });
    expect(seen[0]!.cwd).toBe("/wt/x");
    expect(seen[0]!.args).toContain("--no-session");
    expect(seen[0]!.args).toContain("--no-extensions");
    expect(seen[0]!.args).not.toContain("--no-tools");
    expect(seen[0]!.args.slice(seen[0]!.args.indexOf("--cwd"), seen[0]!.args.indexOf("--cwd") + 2)).toEqual(["--cwd", "/wt/x"]);
    await expect(ompAgentStep(async () => fail("bad", "", 2), { pinModel: undefined })({ cwd: "/wt/x", prompt: "p" })).rejects.toThrow("omp exited 2: bad");
    await expect(ompAgentStep(async () => ({ ...ok(), killed: true }), { pinModel: undefined })({ cwd: "/wt/x", prompt: "p" })).rejects.toThrow("stopped");
  });

  it("stops before spawning when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const exec: Exec = async () => {
      spawned = true;
      return ok("x");
    };
    await expect(ompModelStep(exec)("p", controller.signal)).rejects.toThrow();
    await expect(ompAgentStep(exec, { pinModel: undefined })({ cwd: "/w", prompt: "p" }, controller.signal)).rejects.toThrow();
    expect(spawned).toBe(false);
  });

  it("parses a bare or fenced JSON reply and refuses prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply('Sure: {"a":1}')).toThrow("not JSON");
    return expect(askJson(async () => "{", "p", (v) => v, { attempts: 2 })).rejects.toThrow("no valid reply after 2 attempts");
  });

  it("sends heartbeats while work runs and clears the timer afterwards", async () => {
    // Real timers on purpose: the behavior under test is setInterval being started and cleared.
    const updates: string[] = [];
    const work = Promise.withResolvers<number>();
    const first = Promise.withResolvers<void>();
    const running = withHeartbeat(
      (update) => {
        updates.push(update.content[0]!.text);
        first.resolve();
      },
      () => "working",
      () => work.promise,
      5,
    );
    await first.promise; // the heartbeat fired while the work was still pending
    work.resolve(7);
    expect(await running).toBe(7);
    const settled = updates.length;
    expect(updates[0]).toContain("working");
    const after = Promise.withResolvers<void>();
    setTimeout(after.resolve, 30);
    await after.promise;
    expect(updates).toHaveLength(settled); // cleared: no beat after the work settled
  });
});

// ---------------------------------------------------------------- the round loop

/** What one round's reviews and gate answer. */
interface ScriptedRound {
  readonly code: readonly Finding[];
  readonly security: readonly Finding[];
  readonly testsOk: boolean;
  readonly diff?: string;
  readonly branch?: string;
  readonly refusal?: string;
}

class FakeRepo {
  readonly commits: string[] = [];
  readonly pulls: { title: string; body: string }[] = [];
  private round = 0;
  private held: ScriptedRound;
  constructor(private readonly rounds: readonly ScriptedRound[]) {
    this.held = this.rounds[0]!;
  }
  beginRound(): ScriptedRound {
    this.held = this.rounds[Math.min(this.round, this.rounds.length - 1)]!;
    this.round++;
    return this.held;
  }
  get current(): ScriptedRound {
    return this.held;
  }
  port() {
    return {
      worktree: async (ticket: { readonly identifier: string }) => `/wt/ticket-${ticket.identifier}`,
      diff: async () => this.held.diff ?? "a diff",
      branchDiff: async () => this.held.branch ?? `branch: ${this.held.diff ?? "a diff"}`,
      commit: async (_worktree: string, message: string) => {
        this.commits.push(message);
        const refusal = this.held.refusal;
        return refusal === undefined ? { committed: true as const, sha: "sha" } : { committed: false as const, refusal };
      },
      pullRequest: async (_worktree: string, title: string, body: string) => {
        this.pulls.push({ title, body });
        return "https://github.com/o/r/pull/1";
      },
      runTests: async () => ({ ok: this.held.testsOk, output: "suite output" }),
    };
  }
}

function ticketWorld(rounds: readonly ScriptedRound[], ataskIds: readonly string[] = ["at-own"]) {
  const repo = new FakeRepo(rounds);
  const briefs: string[] = [];
  const improved: string[] = [];
  const steps: string[] = [];
  const ports = {
    resolver: {
      resolve: async () => ({
        title: "Add the flag",
        body: "The ticket body with acceptance lines",
        worktree: "/wt/ticket-ENG-1",
        ataskIds,
        linearIdentifier: "ENG-1",
      }),
    },
    repo: repo.port(),
    implementer: async (brief: string) => {
      repo.beginRound();
      briefs.push(brief);
    },
    reviews: {
      code: async () => repo.current.code,
      security: async () => repo.current.security,
    },
    improvePr: async (prUrl: string) => {
      improved.push(prUrl);
      return { status: "complete" as const, ciStatus: "green", reviewStatus: "complete", unresolvedThreads: 0, requiresAnotherPass: false, finalHeadSha: "abc" };
    },
    step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      steps.push(name);
      return fn();
    },
  };
  return { ports, briefs, improved, repo, steps };
}

const green: ScriptedRound = { code: [], security: [], testsOk: true };

describe("executeTicket", () => {
  it("carries a round's blockers into the next fix pass and lands only a clean round", async () => {
    const { ports, briefs, improved, repo, steps } = ticketWorld([{ code: [finding("blocking")], security: [], testsOk: true }, green]);
    const result: ExecuteTicketOutput = await executeTicket({ linearTicket: "ENG-1", maxRounds: 3 }, ports);
    expect(result.status).toBe("landed");
    expect(result.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({ round: 1, commit: "committed", codeFindings: 1, blocking: 1, testsOk: true });
    expect(result.rounds[1]).toMatchObject({ round: 2, blocking: 0 });
    expect(briefs[0]).toBe("The ticket body with acceptance lines");
    expect(briefs[1]).toContain("Fix these findings from the last review round");
    expect(repo.pulls[0]!.body).toContain("atask: at-own");
    expect(improved).toEqual(["https://github.com/o/r/pull/1"]);
    expect(result.improvePr).toMatchObject({ status: "complete", ciStatus: "green" });
    expect(steps).toEqual(["resolve", "implement-1", "review-1", "implement-2", "review-2", "land", "improve-pr"]);
  });

  it("reports exhausted, with the blockers still standing, when no round closes", async () => {
    const blocker = { code: [finding("blocking")], security: [], testsOk: true };
    const { ports, repo, improved } = ticketWorld([blocker, blocker]);
    const result = await executeTicket({ linearTicket: "ENG-1", maxRounds: 2 }, ports);
    expect(result.status).toBe("exhausted");
    expect(result.prUrl).toBeUndefined();
    expect(result.improvePr).toBeUndefined();
    expect(repo.pulls).toHaveLength(0);
    expect(improved).toHaveLength(0);
    expect(result.blockers).toEqual([expect.stringContaining("what is wrong")]);
  });

  it("refuses a branch with no change at all, without committing or opening a pull request", async () => {
    const { ports, repo } = ticketWorld([{ code: [], security: [], testsOk: true, diff: "", branch: "" }]);
    const result = await executeTicket({ linearTicket: "ENG-1", maxRounds: 3 }, ports);
    expect(result.status).toBe("exhausted");
    expect(result.blockers).toEqual(["the implementer left no change to review"]);
    expect(repo.commits).toHaveLength(0);
    expect(repo.pulls).toHaveLength(0);
  });

  it("reviews and lands work an earlier run committed when this round adds nothing", async () => {
    const { ports, repo, improved } = ticketWorld([{ ...green, diff: "", branch: "branch: the earlier round" }]);
    const result = await executeTicket({ linearTicket: "ENG-1", maxRounds: 3 }, ports);
    expect(result.status).toBe("landed");
    expect(result.rounds[0]).toMatchObject({ round: 1, commit: "unchanged" });
    expect(repo.commits).toHaveLength(0);
    expect(improved).toHaveLength(1);
  });

  it("hands a commit hook's refusal to the next round instead of failing the run", async () => {
    const { ports, briefs, improved } = ticketWorld([
      { ...green, refusal: "dprint: Expected an indented block after `if` statement" },
      green,
    ]);
    const result = await executeTicket({ linearTicket: "ENG-1", maxRounds: 3 }, ports);
    expect(result.status).toBe("landed");
    expect(result.rounds[0]).toMatchObject({ round: 1, commit: "refused", blocking: 1 });
    expect(briefs[1]).toContain("The repo's commit hooks refused this round's change");
    expect(briefs[1]).toContain("Expected an indented block");
    expect(improved).toHaveLength(1);
  });

  it("hands both reviewers the whole branch diff, not the round's uncommitted change", async () => {
    const { ports } = ticketWorld([green]);
    const seen: string[] = [];
    const recording = {
      code: async (diff: string) => (seen.push(diff), []),
      security: async (diff: string) => (seen.push(diff), []),
    };
    await executeTicket({ linearTicket: "ENG-1", maxRounds: 1 }, { ...ports, reviews: recording });
    expect(seen).toEqual(["branch: a diff", "branch: a diff"]);
  });

  it("does not land on a red gate even when both reviews are clean", async () => {
    const { ports, repo } = ticketWorld([{ code: [], security: [], testsOk: false }]);
    const result = await executeTicket({ linearTicket: "ENG-1", maxRounds: 1 }, ports);
    expect(result.status).toBe("exhausted");
    expect(result.rounds[0]).toMatchObject({ testsOk: false, blocking: 1 });
    expect(repo.pulls).toHaveLength(0);
  });

  it("waits for the test gate before failing when a review throws", async () => {
    const { ports } = ticketWorld([green]);
    const gate = Promise.withResolvers<{ ok: boolean; output: string }>();
    const run = executeTicket(
      { linearTicket: "ENG-1", maxRounds: 1 },
      {
        ...ports,
        repo: { ...ports.repo, runTests: () => gate.promise },
        reviews: { code: async () => { throw new Error("review down"); }, security: async () => [] },
      },
    );
    let settled = false;
    run.then(() => (settled = true), () => (settled = true));
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(settled).toBe(false); // the review has failed, but the run still waits for the gate
    gate.resolve({ ok: true, output: "" });
    await expect(run).rejects.toThrow("review down");
  });
});

describe("roundCommitMessage", () => {
  it("writes a short Conventional Commits subject however long the ticket title", () => {
    const title = "Stop CWA from logging in on a client X-Authentik-Username header and much more besides";
    const [subject, blank, body] = roundCommitMessage({ title, ataskIds: ["at-4e7sg8"] }, 2).split("\n");
    expect(subject).toBe("chore(execute-ticket): implement round 2 of at-4e7sg8");
    expect(subject).toMatch(/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\([a-z0-9-]+\): /);
    expect(subject!.length).toBeLessThan(72);
    expect(blank).toBe("");
    expect(body).toBe(title);
  });

  it("names the Linear ticket when there is one", () => {
    expect(roundCommitMessage({ title: "t", ataskIds: ["at-55dv0p"], linearIdentifier: "ZYS-1736" }, 1)).toMatch(
      /^chore\(execute-ticket\): implement round 1 of ZYS-1736\n/,
    );
  });
});

// ---------------------------------------------------------------- the ticket resolver

describe("ticketResolver", () => {
  const parent: LinearTicket = { identifier: "ENG-1", title: "Add the flag", description: "The parent body", subIssues: ["ENG-2"] };
  const child: LinearTicket = { identifier: "ENG-2", title: "The sub-issue", description: "The child body", subIssues: [] };

  const linear = (): LinearPort & { readonly comments: readonly string[] } => {
    const comments: string[] = [];
    return {
      comments,
      issue: async (identifier: string) => (identifier === "ENG-1" ? parent : child),
      comment: async (id: string, body: string) => {
        comments.push(`${id}: ${body}`);
      },
    };
  };
  const atask = (ids: readonly string[]): AtaskFilePort & { readonly filed: readonly string[] } => {
    const filed: string[] = [];
    let next = 0;
    return {
      filed,
      fileOrReuse: async (_project, item) => {
        const id = ids[next] ?? `at-${next}`;
        next++;
        filed.push(`${item.groupKey} -> ${id}`);
        return { id, reused: false };
      },
    };
  };
  const worktreeFor = async (identifier: string) => `/wt/ticket-${identifier}`;
  const show = async (id: string) => ({
    title: `Objective ${id}`,
    outcome: "the outcome",
    acceptance: ["port 8083 is not published on all interfaces"],
    constraints: ["Do not change Navidrome trusted sources"],
  });

  it("files the ticket and each sub-issue as atask objectives and annotates the Linear ticket", async () => {
    const board = linear();
    const filed = atask(["at-sub", "at-own"]);
    const resolved = await ticketResolver({ linear: board, atask: filed, ataskProject: undefined, worktreeFor, show }).resolve({ linearTicket: "ENG-1" });
    expect(resolved.linearIdentifier).toBe("ENG-1");
    expect(resolved.worktree).toBe("/wt/ticket-ENG-1");
    expect(resolved.ataskIds).toEqual(["at-own", "at-sub"]);
    expect(resolved.body).toContain("Sub-issue 1 (ENG-2): The sub-issue");
    expect(filed.filed).toEqual(["linear-eng-2 -> at-sub", "linear-eng-1 -> at-own"]);
    expect(board.comments).toEqual(["ENG-1: execute_ticket: atask at-own, at-sub"]);
  });

  it("briefs an atask objective with its outcome, acceptance lines and constraints, never touching Linear", async () => {
    const board = linear();
    const resolved = await ticketResolver({ linear: board, atask: atask([]), ataskProject: undefined, worktreeFor, show }).resolve({ ataskId: "at-x1" });
    expect(resolved.ataskIds).toEqual(["at-x1"]);
    expect(resolved.worktree).toBe("/wt/ticket-at-x1");
    expect(resolved.body).toContain("# at-x1: Objective at-x1");
    expect(resolved.body).toContain("Acceptance:\n- port 8083 is not published on all interfaces");
    expect(resolved.body).toContain("Constraints:\n- Do not change Navidrome trusted sources");
    expect(board.comments).toEqual([]);
  });

  it("uses the given atask id as the ticket's own objective", async () => {
    const board = linear();
    const filed = atask(["at-sub"]);
    const resolved = await ticketResolver({ linear: board, atask: filed, ataskProject: undefined, worktreeFor, show }).resolve({ linearTicket: "ENG-1", ataskId: "at-given" });
    expect(resolved.ataskIds).toEqual(["at-given", "at-sub"]);
  });

  it("reuses the atask id a ticket's description already marks, filing and commenting nothing", async () => {
    const board: LinearPort & { readonly comments: readonly string[] } = {
      ...linear(),
      issue: async () => ({ ...parent, description: "<!-- atask-id: at-55dv0p -->\nbody", subIssues: [] }),
    };
    const filed = atask(["at-new"]);
    const resolved = await ticketResolver({ linear: board, atask: filed, ataskProject: undefined, worktreeFor, show }).resolve({ linearTicket: "ENG-1" });
    expect(resolved.ataskIds).toEqual(["at-55dv0p"]);
    expect(filed.filed).toEqual([]);
    expect(board.comments).toEqual([]);
  });

  it("refuses a run that names neither an atask id nor a Linear ticket", async () => {
    const resolve = ticketResolver({ linear: linear(), atask: atask([]), ataskProject: undefined, worktreeFor, show }).resolve;
    await expect(resolve({})).rejects.toThrow("name an atask id or a Linear ticket identifier");
  });
});

// ---------------------------------------------------------------- input

describe("parseInput", () => {
  it("requires one of ataskId or linearTicket and defaults to three rounds", () => {
    expect(() => parseInput({})).toThrow("name an atask id or a Linear ticket identifier");
    expect(() => parseInput({ ataskId: null, linearTicket: null })).toThrow("name an atask id");
    expect(parseInput({ linearTicket: "ZYS-1" })).toEqual({ linearTicket: "ZYS-1", maxRounds: 3 });
    expect(parseInput({ ataskId: " at-abc1 ", maxRounds: null, repoRoot: null })).toEqual({ ataskId: "at-abc1", maxRounds: 3 });
  });

  it("refuses blank text, out-of-range rounds and an atask id that could escape the worktree directory", () => {
    expect(() => parseInput({ linearTicket: "  " })).toThrow("must not be blank");
    expect(() => parseInput({ linearTicket: "ZYS-1", maxRounds: 0 })).toThrow("maxRounds");
    expect(() => parseInput({ linearTicket: "ZYS-1", maxRounds: 11 })).toThrow("maxRounds");
    expect(() => parseInput({ linearTicket: "ZYS-1", maxRounds: 1.5 })).toThrow("maxRounds");
    expect(() => parseInput({ ataskId: "../../etc" })).toThrow("not an atask id");
    expect(() => parseInput({ ataskId: "at-a b" })).toThrow("not an atask id");
  });

  it("tells the implementer to leave changes uncommitted and stay in the worktree", () => {
    const prompt = implementerPrompt("# T", "/wt/x");
    expect(prompt).toContain("git worktree at /wt/x");
    expect(prompt).toContain("uncommitted");
    expect(prompt.endsWith("# T")).toBe(true);
  });
});

// ---------------------------------------------------------------- Linear over GraphQL

describe("linearPort", () => {
  const issueAnswer = (extra: object = {}) => ({
    data: {
      issue: {
        id: "uuid-1",
        identifier: "ZYS-1",
        title: "T",
        description: null,
        children: { nodes: [{ identifier: "ZYS-2" }], pageInfo: { hasNextPage: false } },
        ...extra,
      },
    },
  });
  const fetcher = (answers: unknown[], seen: { url: string; init: RequestInit }[] = []): typeof fetch =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const body = answers.shift();
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

  it("routes ZYS and SAH to their own key and refuses an unknown prefix or a non-identifier", () => {
    expect(linearKeyVariable("ZYS-12")).toBe("LINEAR_API_KEY_ZYS");
    expect(linearKeyVariable("sah-3")).toBe("LINEAR_API_KEY_SAH");
    expect(() => linearKeyVariable("ENG-1")).toThrow("unknown prefix ENG");
    expect(() => linearKeyVariable("nonsense")).toThrow("not a Linear identifier");
  });

  it("reads the issue and its sub-issues with the workspace's own key", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = linearPort({ env: { LINEAR_API_KEY_ZYS: "key-z", LINEAR_API_KEY_SAH: "key-s" }, fetch: fetcher([issueAnswer()], seen) });
    expect(await port.issue("ZYS-1")).toEqual({ identifier: "ZYS-1", title: "T", description: "", subIssues: ["ZYS-2"] });
    expect(seen[0]!.url).toBe("https://api.linear.app/graphql");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("key-z");
    expect(JSON.parse(seen[0]!.init.body as string).variables).toEqual({ id: "ZYS-1", first: 51 });
  });

  it("uses the Bearer scheme for an OAuth token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = linearPort({ env: { LINEAR_API_KEY_SAH: "lin_oauth_abc" }, fetch: fetcher([issueAnswer({ identifier: "SAH-1" })], seen) });
    await port.issue("SAH-1");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer lin_oauth_abc");
  });

  it("refuses when the workspace's key is unset, naming the variable, without calling Linear", async () => {
    let called = false;
    const port = linearPort({ env: { LINEAR_API_KEY_SAH: "k" }, fetch: (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch });
    await expect(port.issue("ZYS-1")).rejects.toThrow("LINEAR_API_KEY_ZYS is not set");
    await expect(port.issue("ENG-1")).rejects.toThrow("unknown prefix");
    expect(called).toBe(false);
  });

  it("refuses a ticket whose sub-issues run past one page rather than dropping some", async () => {
    const port = linearPort({
      env: { LINEAR_API_KEY_ZYS: "k" },
      fetch: fetcher([issueAnswer({ children: { nodes: [{ identifier: "ZYS-2" }], pageInfo: { hasNextPage: true } } })]),
    });
    await expect(port.issue("ZYS-1")).rejects.toThrow("more than 50 sub-issues");
  });

  it("names the ticket when Linear refuses, errors, or has no such issue", async () => {
    const env = { LINEAR_API_KEY_ZYS: "k" };
    await expect(linearPort({ env, fetch: fetcher([new Response("no", { status: 401 })]) }).issue("ZYS-1")).rejects.toThrow("linear ZYS-1: http 401");
    await expect(linearPort({ env, fetch: fetcher([{ errors: [{ message: "bad" }] }]) }).issue("ZYS-1")).rejects.toThrow("linear ZYS-1: bad");
    await expect(linearPort({ env, fetch: fetcher([{ data: { issue: null } }]) }).issue("ZYS-1")).rejects.toThrow("no such issue");
  });

  it("posts a comment on the issue's uuid and fails when Linear does not confirm it", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const env = { LINEAR_API_KEY_ZYS: "k" };
    await linearPort({ env, fetch: fetcher([issueAnswer(), { data: { commentCreate: { success: true } } }], seen) }).comment("ZYS-1", "hello");
    expect(JSON.parse(seen[1]!.init.body as string).variables).toEqual({ input: { issueId: "uuid-1", body: "hello" } });
    await expect(
      linearPort({ env, fetch: fetcher([issueAnswer(), { data: { commentCreate: { success: false } } }]) }).comment("ZYS-1", "x"),
    ).rejects.toThrow("did not succeed");
  });
});

// ---------------------------------------------------------------- atask

describe("ataskCli", () => {
  const envelope = (result: unknown) => ok(JSON.stringify({ ok: true, result }));

  it("shows an objective with its acceptance descriptions", async () => {
    const { exec, calls } = machine(() => envelope({ title: "T", outcome: "O", acceptance: [{ description: "a" }, { nope: 1 }], constraints: ["c", 3] }));
    expect(await ataskCli({ exec }).show("at-1")).toEqual({ title: "T", outcome: "O", acceptance: ["a"], constraints: ["c"] });
    expect(calls).toEqual(["atask --json show at-1 --full"]);
  });

  it("reuses an open objective that carries the group key", async () => {
    const { exec, calls } = machine(() => envelope({ tasks: [{ id: "at-done", key: "k", status: "complete" }, { id: "at-open", key: "k", status: "open" }] }));
    expect(await ataskCli({ exec }).fileOrReuse(undefined, { groupKey: "k", title: "t", outcome: "o", proof: "p", regression: "r" })).toEqual({ id: "at-open", reused: true });
    expect(calls).toEqual(["atask --json list"]);
  });

  it("files a new objective with run: presets on its checks", async () => {
    const { exec, calls } = machine((line) => (line.includes(" add ") ? envelope({ task: { id: "at-new" } }) : envelope({ tasks: [] })));
    expect(await ataskCli({ exec }).fileOrReuse(undefined, { groupKey: "k", title: "t", outcome: "o", proof: "echo hi", regression: "run: x" })).toEqual({ id: "at-new", reused: false });
    expect(calls[1]).toBe("atask --json add t --key k --outcome o --proof run: echo hi --regression run: x");
  });

  it("fails with atask's own message, on bad JSON, and when the CLI cannot start", async () => {
    await expect(ataskCli({ exec: machine(() => ok(JSON.stringify({ ok: false, error: { message: "no board" } }))).exec }).show("at-1")).rejects.toThrow("atask show failed (exit 0): no board");
    await expect(ataskCli({ exec: machine(() => fail("oops")).exec }).show("at-1")).rejects.toThrow("non-JSON output (exit 1): oops");
    await expect(ataskCli({ exec: machine(() => new Error("ENOENT")).exec }).show("at-1")).rejects.toThrow("atask CLI is not runnable: ENOENT");
    await expect(ataskCli({ exec: machine(() => envelope({})).exec }).show("at-1")).rejects.toThrow("no title and outcome");
  });
});

// ---------------------------------------------------------------- git and gh

const ROOT = "/repos/app";
const DIR = "/repos/.worktrees/app-ticket-at-x1";
const NO_WORKTREE = fail("fatal: not a git repository", "", 128);

describe("repoPort", () => {
  const port = (handler: Parameters<typeof machine>[0], extra: { testCommand?: string[]; gateTimeoutMs?: number } = {}) => {
    const m = machine(handler);
    return { ...m, repo: repoPort({ exec: m.exec, root: ROOT, worktreesDir: "/repos/.worktrees", testCommand: extra.testCommand ?? ["mise", "run", "test"], gateTimeoutMs: extra.gateTimeoutMs }) };
  };

  it("opens the ticket's worktree as <repo>-ticket-<id> off the default branch origin/HEAD names", async () => {
    const { repo, calls } = port((line) => {
      if (line === "git rev-parse --show-toplevel" || line === "git rev-parse --verify ticket/at-x1") return NO_WORKTREE;
      if (line === "git symbolic-ref --short refs/remotes/origin/HEAD") return ok("origin/main\n");
      if (line === `git worktree add -b ticket/at-x1 ${DIR} main`) return ok();
      return undefined;
    });
    expect(await repo.worktree({ identifier: "AT-X1" })).toBe(DIR);
    expect(calls.at(-1)).toBe(`git worktree add -b ticket/at-x1 ${DIR} main`);
  });

  it("reuses a worktree a previous run left, and checks out an existing branch without -b", async () => {
    const reused = port((line, cwd) => (line === "git rev-parse --show-toplevel" && cwd === DIR ? ok(DIR) : undefined));
    expect(await reused.repo.worktree({ identifier: "at-x1" })).toBe(DIR);
    expect(reused.calls.some((c) => c.includes("worktree add"))).toBe(false);
    const existing = port((line) => {
      if (line === "git rev-parse --show-toplevel") return NO_WORKTREE;
      if (line === "git rev-parse --verify ticket/at-x1") return ok("sha");
      if (line === `git worktree add ${DIR} ticket/at-x1`) return ok();
      return undefined;
    });
    expect(await existing.repo.worktree({ identifier: "at-x1" })).toBe(DIR);
  });

  it("refuses to guess a base branch when origin/HEAD is unset", async () => {
    const { repo } = port((line) => {
      if (line.startsWith("git rev-parse")) return NO_WORKTREE;
      if (line.startsWith("git symbolic-ref")) return fail("not a symbolic ref", "", 1);
      return undefined;
    });
    await expect(repo.worktree({ identifier: "at-x1" })).rejects.toThrow("git remote set-head origin -a");
  });

  it("removes the worktree and its new branch when a setup hook fails the add", async () => {
    const { repo, calls } = port((line) => {
      if (line.startsWith("git rev-parse")) return NO_WORKTREE;
      if (line.startsWith("git symbolic-ref")) return ok("origin/main");
      if (line.startsWith("git worktree add")) return fail("pre-start bootstrap failed");
      if (line.startsWith("git worktree remove") || line.startsWith("git branch -D")) return ok();
      return undefined;
    });
    await expect(repo.worktree({ identifier: "at-x1" })).rejects.toThrow("open worktree");
    expect(calls).toContain(`git worktree remove --force ${DIR}`);
    expect(calls).toContain("git branch -D ticket/at-x1");
  });

  it("shows a file the implementer created: it is marked intent-to-add before the diff", async () => {
    const { repo, calls } = port((line) => (line.startsWith("git add --intent-to-add") ? ok() : line === "git diff HEAD" ? ok("+new file") : undefined));
    expect(await repo.diff(DIR)).toBe("+new file");
    expect(calls).toEqual(["git add --intent-to-add -- .", "git diff HEAD"]);
  });

  it("diffs the branch against the default branch with three dots", async () => {
    const { repo, calls } = port((line) => {
      if (line.startsWith("git symbolic-ref")) return ok("origin/trunk");
      if (line === "git diff trunk...HEAD") return ok("the branch");
      return undefined;
    });
    expect(await repo.branchDiff(DIR)).toBe("the branch");
    expect(calls).toContain("git diff trunk...HEAD");
  });

  it("commits everything, refuses an empty diff, and answers a hook's refusal instead of throwing", async () => {
    const hooks = (committed: boolean, diff = "+x") => (line: string) => {
      if (line.startsWith("git add --intent-to-add")) return ok();
      if (line === "git diff HEAD") return ok(diff);
      if (line === "git add -A") return ok();
      if (line.startsWith("git commit -m")) return committed ? ok("[branch abc] msg\n") : fail("dprint: bad indent", "lint out");
      return undefined;
    };
    expect(await port(hooks(true)).repo.commit(DIR, "msg")).toEqual({ committed: true, sha: "[branch abc] msg" });
    expect(await port(hooks(false)).repo.commit(DIR, "msg")).toEqual({ committed: false, refusal: "lint out\ndprint: bad indent" });
    await expect(port(hooks(true, " \n")).repo.commit(DIR, "msg")).rejects.toThrow("nothing to commit");
  });

  it("pushes the branch and opens the pull request against the default branch", async () => {
    const { repo, calls } = port((line) => {
      if (line === "git rev-parse --abbrev-ref HEAD") return ok("ticket/at-x1\n");
      if (line === "git push -u origin ticket/at-x1") return ok();
      if (line.startsWith("git symbolic-ref")) return ok("origin/main");
      if (line.startsWith("gh pr create")) return ok("https://github.com/o/r/pull/9\n");
      return undefined;
    });
    expect(await repo.pullRequest(DIR, "Title", "Body")).toBe("https://github.com/o/r/pull/9");
    expect(calls.at(-1)).toBe("gh pr create --title Title --body Body --base main");
  });

  it("runs the gate as an argument array in the worktree and reports a red gate with both streams", async () => {
    const green = port((line, cwd) => (line === "mise run test" && cwd === DIR ? ok("all passed") : undefined));
    expect(await green.repo.runTests(DIR)).toEqual({ ok: true, output: "all passed" });
    const red = port(() => fail("FAIL src/a.test.ts", "12 passed"));
    expect(await red.repo.runTests(DIR)).toEqual({ ok: false, output: "12 passed\nFAIL src/a.test.ts" });
  });

  it("reports a gate that ran past its timeout, and throws when the gate cannot start", async () => {
    const slow = port(() => ({ ...ok(), killed: true }), { gateTimeoutMs: 120_000 });
    expect(await slow.repo.runTests(DIR)).toEqual({ ok: false, output: "the gate ran past 2 minutes and was stopped" });
    const missing = port(() => new Error("spawn mise ENOENT"));
    await expect(missing.repo.runTests(DIR)).rejects.toThrow("ENOENT");
  });

  it("carries only the tail of a very long failure", async () => {
    const { repo } = port(() => fail("x".repeat(20_000)));
    expect((await repo.runTests(DIR)).output).toHaveLength(6000);
  });

  it("stops with the caller's cancellation instead of reporting a failed command", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const m = machine(() => ({ ...ok(), killed: true }));
    const repo = repoPort({ exec: m.exec, root: ROOT, worktreesDir: "/w", testCommand: ["true"], signal: controller.signal });
    await expect(repo.diff(DIR)).rejects.toThrow("cancelled");
    expect(new CommandError("m", "o", "e", false).stdout).toBe("o");
  });
});

// ---------------------------------------------------------------- the whole tool, with fakes for every outside thing

describe("runExecuteTicket", () => {
  /** A repo whose every git, gh, atask and gate command is scripted; omp is reached through the model/agent seams. */
  function world(options: { gate?: ExecResult; commit?: ExecResult[] } = {}) {
    const commits = [...(options.commit ?? [ok("[b abc] ok")])];
    const m = machine((line, cwd) => {
      if (line === "atask --json show at-x1 --full") {
        return ok(JSON.stringify({ ok: true, result: { title: "Do x", outcome: "x is done", acceptance: [{ description: "x works" }], constraints: [] } }));
      }
      if (line === "git rev-parse --show-toplevel") return cwd === DIR ? ok(DIR) : NO_WORKTREE;
      if (line.startsWith("git rev-parse --verify")) return NO_WORKTREE;
      if (line.startsWith("git symbolic-ref")) return ok("origin/main");
      if (line.startsWith("git worktree add")) return ok();
      if (line.startsWith("git add")) return ok();
      if (line === "git diff HEAD") return ok("+change");
      if (line.startsWith("git commit -m")) return commits.shift() ?? ok("[b abc] ok");
      if (line === "git diff main...HEAD") return ok("+++ b/src/a.ts\n+change");
      if (line === "mise run test") return options.gate ?? ok("suite ok");
      if (line === "git rev-parse --abbrev-ref HEAD") return ok("ticket/at-x1");
      if (line.startsWith("git push")) return ok();
      if (line.startsWith("gh pr create")) return ok("https://github.com/o/app/pull/5\n");
      return undefined;
    });
    const prompts: { cwd: string; prompt: string }[] = [];
    const phases: string[] = [];
    const improved: string[] = [];
    const deps = {
      exec: m.exec,
      cwd: ROOT,
      env: {},
      onPhase: (name: string) => phases.push(name),
      agent: async (input: { cwd: string; prompt: string }) => void prompts.push(input),
      model: async () => '{"findings":[]}',
      improve: async (url: string) => {
        improved.push(url);
        return { status: "complete" as const, ciStatus: "green", reviewStatus: "complete", unresolvedThreads: 0, requiresAnotherPass: false, finalHeadSha: "h" };
      },
    };
    return { m, deps, prompts, phases, improved };
  }

  it("takes an atask objective from resolution to an open pull request", async () => {
    const { deps, prompts, phases, improved, m } = world();
    const out = await runExecuteTicket({ ataskId: "at-x1" }, deps);
    expect(out).toMatchObject({ status: "landed", prUrl: "https://github.com/o/app/pull/5", ataskIds: ["at-x1"], worktree: DIR, blockers: [] });
    expect(out.rounds).toEqual([{ round: 1, commit: "committed", codeFindings: 0, securityFindings: 0, blocking: 0, testsOk: true }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cwd).toBe(DIR);
    expect(prompts[0]!.prompt).toContain("x works");
    expect(improved).toEqual(["https://github.com/o/app/pull/5"]);
    expect(phases).toEqual(["resolve", "implement-1", "review-1", "land", "improve-pr"]);
    expect(m.calls.filter((c) => c.startsWith("git commit"))).toEqual([
      "git commit -m chore(execute-ticket): implement round 1 of at-x1\n\nDo x",
    ]);
  });

  it("runs the repo gate named by EXECUTE_TICKET_TEST_COMMAND, split into an argument array", async () => {
    const w = world();
    const seen: string[] = [];
    const exec: Exec = async (command, args, options) => {
      const line = [command, ...args].join(" ");
      seen.push(line);
      return line === "bun test --bail" ? ok("fine") : w.m.exec(command, args, options);
    };
    const out = await runExecuteTicket({ ataskId: "at-x1" }, { ...w.deps, exec, env: { [TEST_COMMAND_ENV]: "bun test --bail" } });
    expect(out.status).toBe("landed");
    expect(seen).toContain("bun test --bail");
    expect(seen).not.toContain(DEFAULT_TEST_COMMAND.join(" "));
  });

  it("exhausts without opening a pull request when the gate stays red, listing the gate output", async () => {
    const { deps, improved, m } = world({ gate: fail("1 failed", "ran 9") });
    const out = await runExecuteTicket({ ataskId: "at-x1", maxRounds: 2 }, deps);
    expect(out.status).toBe("exhausted");
    expect(out.blockers).toEqual([expect.stringContaining("The repo's test gate failed")]);
    expect(out.rounds).toHaveLength(2);
    expect(improved).toEqual([]);
    expect(m.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  });

  it("reports a failed improve-pass beside the open PR, not as a failed landing", async () => {
    const { deps } = world();
    const out = await runExecuteTicket({ ataskId: "at-x1" }, { ...deps, improve: async () => ({ status: "failed", error: "ocr is missing" }) });
    expect(out.status).toBe("landed");
    expect(out.improvePr).toEqual({ status: "failed", error: "ocr is missing" });
  });

  it("refuses a bad call before running any command", async () => {
    const { deps, m } = world();
    await expect(runExecuteTicket({}, deps)).rejects.toThrow("name an atask id");
    await expect(runExecuteTicket({ linearTicket: "ENG-1" }, deps)).rejects.toThrow("unknown prefix ENG");
    expect(m.calls.filter((c) => c.startsWith("git") || c.startsWith("gh"))).toEqual([]);
  });

  it("stops at the first phase when cancelled", async () => {
    const { deps, m } = world();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(runExecuteTicket({ ataskId: "at-x1" }, { ...deps, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(m.calls).toEqual([]);
  });
});
