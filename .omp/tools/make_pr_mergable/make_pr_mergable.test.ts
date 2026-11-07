import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLedger, nextRound, PR_BUDGET, type SpendLedger } from "./budget.js";
import { checkoutDir, checkoutRoot, pullRequestCheckout } from "./checkout.js";
import { type CheckRollupEntry, ciVerdict } from "./ci_verdict.js";
import {
  AGENT_PUSH_URL,
  PUSH_VISIBLE_BUDGET_MS,
  REVIEWER_REREVIEW_WAIT_MS,
  ROUND_AGENT_BUDGET_MS,
  ROUND_BUDGET_EXIT,
  SETTLE_BUDGET_MS,
  SETTLE_POLL_MS,
  roleOfRound,
} from "./constants.js";
import { parsePaginatedPages } from "./decode.js";
import { command, type RunResult, type Runner, sleep, spawnRunner } from "./exec.js";
import { fixOpenPrIssuesOneCommitEachWithOmp, fixRoundPrompt } from "./fix_round.js";
import { ghRead, retryDelayMs } from "./gh_read.js";
import { headContains } from "./head_contains.js";
import { ompRoundStatus, pushEnv } from "./live_ports.js";
import { awaitMergedSettledApprovedPr, mergeSettledApprovedPr } from "./merge.js";
import { parsePullRequestUrl } from "./parse_url.js";
import type { PrPorts } from "./ports.js";
import { pushPrFixRoundToHeadBranch } from "./push_round.js";
import { readFacts } from "./read_facts.js";
import { assess, canPushHead, judgePrSettled, openIssues } from "./settled.js";
import type { Facts, Issue } from "./types.js";
import { waitUntilPrHeadSettled } from "./wait_settled.js";
import { makePrMergable, stateText } from "./workflow.js";

const sha = (digit: string | number): string => String(digit).repeat(40);
const PR_URL = "https://github.com/acme/widgets/pull/7";
const REPO = "acme/widgets";
const T0 = Date.parse("2026-03-01T12:00:00Z");

class MemoryLedger implements SpendLedger {
  readonly totals = new Map<string, number>();
  spent = async (owner: string): Promise<number> => this.totals.get(owner) ?? 0;
  charge = async (owner: string, usd: number): Promise<number> => {
    const total = (this.totals.get(owner) ?? 0) + usd;
    this.totals.set(owner, total);
    return total;
  };
}

interface FakeComment {
  id: string;
  body: string;
  createdAt: string;
  assoc: string;
  login: string;
  type?: string;
}
interface FakeReview {
  id: string;
  body: string;
  state: string;
  submittedAt: string;
  assoc: string;
  commit: string;
  login: string;
}
interface FakeThread {
  id: string;
  resolved: boolean;
  body: string;
  path: string;
  login: string;
}

/**
 * GitHub, git, omp and the clock as one deterministic world. `gh` answers what the real read paths ask; `git` keeps a
 * checkout whose HEAD the "agent" moves; sleeping advances the clock. Nothing here touches a process, the network or a
 * real repository.
 */
class World {
  clock = T0;
  ghCalls: string[] = [];
  gitCalls: string[] = [];
  agentPrompts: string[] = [];
  agentRoles: string[] = [];
  progress: string[] = [];
  merges: string[][] = [];
  readonly ledger = new MemoryLedger();

  // GitHub side
  state = "OPEN";
  isDraft = false;
  baseRef = "main";
  headRef = "fix/x";
  head = sha(1);
  headPushedMs = T0 - 3_600_000;
  cross = false;
  author = "alice";
  viewer = "zach";
  canPush = true;
  reviewDecision = "";
  mergeState = "CLEAN";
  checks: unknown[] = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
  threads: FakeThread[] = [];
  comments: FakeComment[] = [];
  reviews: FakeReview[] = [];
  /** `gh pr merge` behaviour: merge at once, enter a queue (stays OPEN), or refuse. */
  mergeMode: "merge" | "queue" | "refuse" = "merge";
  /** After a push, GitHub keeps reporting the old head for this many reads. */
  lagReads = 0;
  private lagLeft = 0;
  private lagHead = "";
  /** Raised by `gh` for the next N calls, to exercise retries. */
  ghFailures: string[] = [];

  // Checkout side
  localHead = sha(1);
  log = [sha(1)];
  midMerge = false;
  dirty = false;
  rewritten = false;
  baseMerge: "clean" | "conflict" | "unchanged" | "fail" = "clean";
  pushRefusal: string | undefined;
  nextSha = 2;
  /** What one agent run does to the checkout and GitHub. Default: one commit, and the fix lands on GitHub after the push. */
  agent: (world: World, prompt: string, role: string) => number | Promise<number> = (world) => {
    world.commit();
    return 0;
  };
  /** What a successful push changes on GitHub. Default: the threads are resolved and CI is green on the new head. */
  afterPush: (world: World) => void = (world) => {
    for (const thread of world.threads) thread.resolved = true;
    world.comments = [];
    world.checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
    world.mergeState = "CLEAN";
  };

  commit(): string {
    const next = sha(this.nextSha++);
    this.localHead = next;
    this.log.push(next);
    return next;
  }

  private reportedHead(): string {
    if (this.lagLeft > 0) {
      this.lagLeft -= 1;
      return this.lagHead;
    }
    return this.head;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private graphql(query: string): unknown {
    const wrap = (connection: string, nodes: unknown[]) => ({
      data: { repository: { pullRequest: { [connection]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } },
    });
    if (query.includes("PrThreads")) {
      return wrap(
        "reviewThreads",
        this.threads.map((thread) => ({
          id: thread.id,
          isResolved: thread.resolved,
          comments: {
            nodes: [{
              body: thread.body,
              path: thread.path,
              url: `${PR_URL}#${thread.id}`,
              author: { login: thread.login },
              authorAssociation: "MEMBER",
            }],
          },
        })),
      );
    }
    if (query.includes("PrComments")) {
      return wrap(
        "comments",
        this.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          authorAssociation: comment.assoc,
          author: { __typename: comment.type ?? "User", login: comment.login },
        })),
      );
    }
    return wrap(
      "reviews",
      this.reviews.map((review) => ({
        id: review.id,
        body: review.body,
        state: review.state,
        submittedAt: review.submittedAt,
        authorAssociation: review.assoc,
        commit: { oid: review.commit },
        author: { __typename: "User", login: review.login },
      })),
    );
  }

  gh = async (args: readonly string[]): Promise<string> => {
    const line = args.join(" ");
    this.ghCalls.push(line.replace(/query=[\s\S]*?(?= -f| -F|$)/, "query=…"));
    const failure = this.ghFailures.shift();
    if (failure !== undefined) throw new Error(failure);
    if (args[0] === "pr" && args[1] === "view") {
      if (args.at(-1) === "headRefOid") return JSON.stringify({ headRefOid: this.reportedHead() });
      return JSON.stringify({
        url: PR_URL,
        state: this.state,
        isDraft: this.isDraft,
        baseRefName: this.baseRef,
        headRefName: this.headRef,
        headRefOid: this.reportedHead(),
        isCrossRepository: this.cross,
        headRepository: this.cross ? { name: "widgets", nameWithOwner: "alice/widgets" } : null,
        headRepositoryOwner: { login: this.cross ? "alice" : "acme" },
        reviewDecision: this.reviewDecision === "" ? null : this.reviewDecision,
        mergeStateStatus: this.mergeState,
        author: { login: this.author },
        statusCheckRollup: this.checks,
      });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      this.merges.push([...args]);
      if (this.mergeMode === "refuse") throw new Error("Command failed: gh pr merge\nPull request is not mergeable");
      if (this.mergeMode === "merge") this.state = "MERGED";
      return "";
    }
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: this.viewer });
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify(this.graphql(args.find((arg) => arg.startsWith("query=")) ?? ""));
    }
    if (args[0] === "api" && args[1] === `repos/${REPO}`) {
      return JSON.stringify({ permissions: { push: this.canPush, admin: false } });
    }
    if (args[0] === "api" && args[1]?.endsWith("/check-suites")) {
      return JSON.stringify({ check_suites: [{ created_at: this.iso(this.headPushedMs) }] });
    }
    if (args[0] === "api" && args[1]?.includes("/compare/")) {
      const [from, to] = args[1].split("/compare/")[1]!.split("...");
      const fromAt = this.log.indexOf(from!);
      const toAt = this.log.indexOf(to!);
      return JSON.stringify({ status: from === to ? "identical" : fromAt !== -1 && toAt > fromAt ? "ahead" : "diverged" });
    }
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/commits/`)) {
      return JSON.stringify({ commit: { committer: { date: this.iso(this.headPushedMs - 1000) } } });
    }
    throw new Error(`unexpected gh call: ${line}`);
  };

  git = async (args: readonly string[], _cwd: string): Promise<string> => {
    const line = args.join(" ");
    this.gitCalls.push(line);
    if (line === "rev-parse HEAD") return `${this.localHead}\n`;
    if (args[0] === "rev-parse" && args[1] === "-q") {
      const ref = args[3];
      if (ref === "MERGE_HEAD" && this.midMerge) return "x\n";
      throw new Error("not a ref");
    }
    if (args[0] === "remote" || args[0] === "config") return "";
    if (args[0] === "fetch") {
      if (this.baseMerge === "fail" && line.includes("refs/heads/")) throw new Error("fatal: could not read from remote");
      return "";
    }
    if (args[0] === "merge" && args[1] === "--no-edit") {
      if (this.baseMerge === "conflict") {
        this.midMerge = true;
        throw new Error("CONFLICT (content): Merge conflict in a.ts");
      }
      if (this.baseMerge === "fail") throw new Error("fatal: refusing to merge unrelated histories");
      if (this.baseMerge === "clean") this.commit();
      return "";
    }
    if (args[0] === "merge" && args[1] === "--abort") return "";
    if (args[0] === "diff") return this.midMerge ? "a.ts\nb.ts\n" : "";
    if (args[0] === "status") return this.dirty ? " M src/a.ts\n?? tmp.log\n" : "";
    if (args[0] === "rev-list") {
      const from = args[3]!.split("..")[0]!;
      const at = this.log.indexOf(from);
      return `${at === -1 ? 0 : this.log.length - 1 - at}\n`;
    }
    if (args[0] === "merge-base") {
      if (this.rewritten) throw new Error("not ancestor");
      return "";
    }
    if (args[0] === "push") {
      if (this.pushRefusal !== undefined) throw new Error(`Command failed: git push\n${this.pushRefusal}`);
      this.head = this.localHead;
      this.headPushedMs = this.clock;
      this.lagLeft = this.lagReads;
      this.lagHead = sha(1);
      this.afterPush(this);
      return "";
    }
    throw new Error(`unexpected git call: ${line}`);
  };

  ports(): PrPorts {
    return {
      gh: this.gh,
      git: this.git,
      checkout: async () => {
        this.localHead = this.head;
        this.log = [this.head];
        this.midMerge = false;
        this.dirty = false;
        this.rewritten = false;
        return "/work";
      },
      runAgent: async ({ prompt, role }) => {
        this.agentPrompts.push(prompt);
        this.agentRoles.push(role);
        return this.agent(this, prompt, role);
      },
      ledger: this.ledger,
      now: () => new Date(this.clock),
      sleep: async (ms) => {
        this.clock += ms;
      },
      progress: (message) => {
        this.progress.push(message);
      },
    };
  }
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", killed: false });
const iso = (ms: number): string => new Date(ms).toISOString();

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    prUrl: PR_URL,
    repo: REPO,
    number: 7,
    baseRef: "main",
    state: "OPEN",
    isDraft: false,
    headRef: "fix/x",
    headSha: sha(1),
    headPushedAt: iso(T0 - 3_600_000),
    observedAt: iso(T0),
    author: "alice",
    viewer: "zach",
    viewerCanPush: true,
    isCrossRepository: false,
    reviewDecision: "",
    mergeStateStatus: "CLEAN",
    unresolvedThreads: [],
    openComments: [],
    reviewers: [],
    checks: { verdict: "green", failed: [], pending: [] },
    ...overrides,
  };
}

const thread = { id: "T1", path: "a.ts", url: "u", author: "bob", body: "rename x" };
const note = (overrides: Partial<Facts["openComments"][number]> = {}): Facts["openComments"][number] => ({
  id: "C1",
  source: "comment",
  author: "bob",
  trusted: true,
  body: "please fix",
  at: iso(T0 - 1000),
  ...overrides,
});

describe("parsePullRequestUrl", () => {
  it("accepts a canonical PR URL and rejects look-alikes", () => {
    expect(parsePullRequestUrl(PR_URL)).toEqual({ owner: "acme", repo: "widgets", number: 7 });
    for (
      const url of [
        "https://github.com.evil.example/acme/widgets/pull/7",
        "https://github.com/acme/widgets/pull/7/files",
        "http://github.com/acme/widgets/pull/7",
        "https://github.com/acme/widgets/pull/0",
        "https://github.com/acme/widgets/pull/7?x=1",
        "nope",
      ]
    ) expect(() => parsePullRequestUrl(url)).toThrow();
  });
});

describe("judgePrSettled", () => {
  it("is settled for approved when every criterion holds", () => {
    expect(judgePrSettled(facts({ reviewers: [{ login: "bob", state: "APPROVED", commitSha: sha(1), submittedAt: iso(T0) }] })))
      .toEqual({ kind: "settled", headSha: sha(1), reasons: [] });
  });

  it("takes merged and closed ahead of everything else", () => {
    const stuff = { unresolvedThreads: [thread], checks: { verdict: "red" as const, failed: ["ci"], pending: [] } };
    expect(judgePrSettled(facts({ ...stuff, state: "MERGED" })).kind).toBe("merged");
    expect(judgePrSettled(facts({ ...stuff, state: "CLOSED" }))).toMatchObject({
      kind: "closed",
      reasons: ["the pull request is closed"],
    });
  });

  it("is working while checks are pending, and a pending reason wins over a blocking one", () => {
    const verdict = judgePrSettled(facts({
      checks: { verdict: "pending", failed: [], pending: ["lint"] },
      unresolvedThreads: [thread],
    }));
    expect(verdict.kind).toBe("working");
    expect(verdict.reasons).toEqual(["checks pending: lint", "1 unresolved review thread"]);
  });

  it("is blocked on red checks, threads and comments, naming each", () => {
    const verdict = judgePrSettled(facts({
      checks: { verdict: "red", failed: ["ci"], pending: [] },
      unresolvedThreads: [thread, { ...thread, id: "T2" }],
      openComments: [note()],
    }));
    expect(verdict.kind).toBe("blocked");
    expect(verdict.reasons).toEqual([
      "checks red: ci",
      "2 unresolved review threads",
      "1 comment without a fix pushed after",
    ]);
  });

  it("waits for a stale reviewer only within the re-review window since the push", () => {
    const reviewer = { login: "bob", state: "APPROVED", commitSha: sha(9), submittedAt: iso(T0 - 7_200_000) };
    const fresh = facts({ headPushedAt: iso(T0 - REVIEWER_REREVIEW_WAIT_MS + 1000), reviewers: [reviewer] });
    expect(judgePrSettled(fresh)).toMatchObject({ kind: "working", reasons: ["awaiting re-review of the head from bob"] });
    const late = facts({ headPushedAt: iso(T0 - REVIEWER_REREVIEW_WAIT_MS - 1000), reviewers: [reviewer] });
    expect(judgePrSettled(late).kind).toBe("settled");
  });

  it("blocks approved on CHANGES_REQUESTED, REVIEW_REQUIRED and a merge state other than CLEAN, but not mergeable", () => {
    const changes = { login: "bob", state: "CHANGES_REQUESTED", commitSha: sha(1), submittedAt: iso(T0) };
    expect(judgePrSettled(facts({ reviewers: [changes] })).reasons).toEqual(["CHANGES_REQUESTED by bob"]);
    expect(judgePrSettled(facts({ reviewDecision: "REVIEW_REQUIRED" })).reasons).toEqual(["reviewDecision is REVIEW_REQUIRED"]);
    expect(judgePrSettled(facts({ mergeStateStatus: "BLOCKED" })).reasons).toEqual(["mergeStateStatus is BLOCKED"]);
    expect(judgePrSettled(facts({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }), "mergeable").kind)
      .toBe("settled");
    expect(judgePrSettled(facts({ mergeStateStatus: "DIRTY" }), "mergeable").reasons).toEqual(["mergeStateStatus is DIRTY"]);
  });

  it("treats an uncomputed merge state as working", () => {
    expect(judgePrSettled(facts({ mergeStateStatus: "UNKNOWN" }))).toMatchObject({
      kind: "working",
      reasons: ["GitHub has not computed mergeStateStatus"],
    });
  });

  it("waits for checks to register on a fresh push, then blocks; a fork is never held to them", () => {
    const empty = { verdict: "no-checks" as const, failed: [], pending: [] };
    expect(judgePrSettled(facts({ checks: empty, headPushedAt: iso(T0 - 1000) })).kind).toBe("working");
    expect(judgePrSettled(facts({ checks: empty })).reasons).toEqual(["no checks reported on the head"]);
    expect(judgePrSettled(facts({ checks: empty, isCrossRepository: true, viewerCanPush: true })).kind).toBe("settled");
  });

  it("reports a draft with nothing to fix as impossible, but works a draft's issues first", () => {
    const draft = facts({ isDraft: true });
    expect(assess(draft, "approved").impossible).toBe("the pull request is a draft");
    expect(judgePrSettled(draft).reasons).toEqual(["the pull request is a draft"]);
    expect(assess({ ...draft, unresolvedThreads: [thread] }, "approved").impossible).toBeUndefined();
  });

  it("is impossible with work left and no push access, and not otherwise", () => {
    const readOnly = facts({ viewerCanPush: false, unresolvedThreads: [thread] });
    expect(assess(readOnly, "approved").impossible).toBe("zach has no push access to acme/widgets, so nothing can be fixed");
    expect(assess(facts({ viewerCanPush: false }), "approved").impossible).toBeUndefined();
  });
});

describe("openIssues and canPushHead", () => {
  it("lists a base merge, each thread, each failed check and each trusted comment, in that order", () => {
    const issues = openIssues(
      facts({
        mergeStateStatus: "DIRTY",
        unresolvedThreads: [{ ...thread, body: "<b>bold</b> &lt;x&gt;" }],
        checks: { verdict: "red", failed: ["ci", "lint"], pending: [] },
        openComments: [note(), note({ id: "C2", trusted: false })],
      }),
      "approved",
    );
    expect(issues).toEqual([
      { kind: "merge-base", baseRef: "main", why: "the branch conflicts with its base" },
      { kind: "thread", id: "T1", path: "a.ts", author: "bob", body: "bold <x>" },
      { kind: "failed-check", name: "ci" },
      { kind: "failed-check", name: "lint" },
      { kind: "comment", id: "C1", author: "bob", body: "please fix" },
    ]);
  });

  it("merges a behind branch only for approved", () => {
    expect(openIssues(facts({ mergeStateStatus: "BEHIND" }), "approved")).toHaveLength(1);
    expect(openIssues(facts({ mergeStateStatus: "BEHIND" }), "mergeable")).toEqual([]);
  });

  it("lets a fork's own author push to the fork when the viewer cannot push to the base", () => {
    expect(canPushHead(facts({ viewerCanPush: false }))).toBe(false);
    expect(canPushHead(facts({ viewerCanPush: false, isCrossRepository: true, author: "zach", viewer: "zach" }))).toBe(true);
    expect(canPushHead(facts({ viewerCanPush: false, isCrossRepository: true, headRepo: "zach/widgets" }))).toBe(true);
    expect(canPushHead(facts({ viewerCanPush: false, isCrossRepository: true, headRepo: "alice/widgets" }))).toBe(false);
  });
});

describe("ciVerdict", () => {
  const check = (conclusion: string, status = "COMPLETED"): CheckRollupEntry => ({ __typename: "CheckRun", status, conclusion });
  it("is green only when every check is terminal and passing, never for an empty list", () => {
    expect(ciVerdict([check("SUCCESS"), check("SKIPPED")])).toBe("green");
    expect(ciVerdict([])).toBe("no-checks");
    expect(ciVerdict([check("FAILURE"), check("", "IN_PROGRESS")])).toBe("pending");
    expect(ciVerdict([check("FAILURE")])).toBe("red");
    expect(ciVerdict([{ __typename: "Mystery" }])).toBe("red");
  });
});

describe("ghRead", () => {
  const ports = (failures: string[]) => {
    const slept: number[] = [];
    let calls = 0;
    return {
      gh: async () => {
        calls += 1;
        const failure = failures.shift();
        if (failure !== undefined) throw new Error(failure);
        return "ok";
      },
      now: () => new Date(T0),
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      slept,
      calls: () => calls,
    };
  };

  it("retries a 5xx and a network failure with backoff, then succeeds", async () => {
    const p = ports(["gh: HTTP 502", "dial tcp: i/o timeout"]);
    expect(await ghRead(p, ["api", "user"], () => 0)).toBe("ok");
    expect(p.calls()).toBe(3);
    expect(p.slept).toEqual([1000, 2000]);
  });

  it("never retries a 4xx", async () => {
    const p = ports(["gh: Not Found (HTTP 404)"]);
    await expect(ghRead(p, ["api", "user"])).rejects.toThrow(/404/);
    expect(p.calls()).toBe(1);
  });

  it("gives up after four attempts naming the endpoint and the status", async () => {
    const p = ports(Array(10).fill("gh: HTTP 503"));
    await expect(ghRead(p, ["api", "repos/a/b"], () => 0)).rejects.toThrow(/gh api repos\/a\/b failed after 4 attempts: HTTP 503/);
    expect(p.calls()).toBe(4);
  });

  it("doubles the delay up to the cap and jitters upward by at most a quarter", () => {
    expect(retryDelayMs(1, () => 0)).toBe(1000);
    expect(retryDelayMs(3, () => 0)).toBe(4000);
    expect(retryDelayMs(9, () => 1)).toBe(10_000);
  });
});

describe("readFacts", () => {
  it("reads every fact from GitHub's answers and judges nothing", async () => {
    const world = new World();
    world.threads = [{ id: "T1", resolved: false, body: "rename", path: "a.ts", login: "bob" }, { id: "T2", resolved: true, body: "x", path: "b.ts", login: "bob" }];
    world.reviews = [{ id: "R1", body: "", state: "APPROVED", submittedAt: iso(T0 - 5000), assoc: "MEMBER", commit: sha(1), login: "bob" }];
    const read = await readFacts(world.ports(), PR_URL);
    expect(read).toMatchObject({
      repo: REPO,
      number: 7,
      state: "OPEN",
      headSha: sha(1),
      viewer: "zach",
      viewerCanPush: true,
      isCrossRepository: false,
      reviewDecision: "",
      mergeStateStatus: "CLEAN",
      checks: { verdict: "green", failed: [], pending: [] },
    });
    expect(read.unresolvedThreads.map((t) => t.id)).toEqual(["T1"]);
    expect(read.reviewers).toEqual([{ login: "bob", state: "APPROVED", commitSha: sha(1), submittedAt: iso(T0 - 5000) }]);
    expect(read.headPushedAt).toBe(iso(T0 - 3_600_000));
    expect(read.observedAt).toBe(iso(T0));
  });

  it("opens a comment only for a human after the push; bots, the author and the viewer are not asked", async () => {
    const world = new World();
    const after = iso(world.headPushedMs + 60_000);
    world.comments = [
      { id: "H", body: "please fix", createdAt: after, assoc: "MEMBER", login: "bob" },
      { id: "B", body: "bot says", createdAt: after, assoc: "NONE", login: "ci-bot", type: "Bot" },
      { id: "D", body: "bot says", createdAt: after, assoc: "NONE", login: "dependabot[bot]" },
      { id: "A", body: "author reply", createdAt: after, assoc: "OWNER", login: "alice" },
      { id: "V", body: "my reply", createdAt: after, assoc: "OWNER", login: "zach" },
      { id: "O", body: "old", createdAt: iso(world.headPushedMs - 60_000), assoc: "MEMBER", login: "bob" },
      { id: "E", body: "   ", createdAt: after, assoc: "MEMBER", login: "bob" },
      { id: "U", body: "drive-by", createdAt: iso(world.headPushedMs + 120_000), assoc: "NONE", login: "stranger" },
    ];
    world.reviews = [
      { id: "R1", body: "changes needed", state: "CHANGES_REQUESTED", submittedAt: after, assoc: "MEMBER", commit: sha(1), login: "carol" },
      { id: "R2", body: "lgtm", state: "APPROVED", submittedAt: after, assoc: "MEMBER", commit: sha(1), login: "dave" },
    ];
    const read = await readFacts(world.ports(), PR_URL);
    expect(read.openComments.map((n) => [n.id, n.trusted])).toEqual([
      ["H", true],
      ["R1", true],
      ["U", false],
    ]);
    expect(read.reviewers.map((r) => r.login).sort()).toEqual(["carol", "dave"]);
  });

  it("keeps each reviewer's latest review and skips pending ones", async () => {
    const world = new World();
    const review = (id: string, state: string, at: number): FakeReview => ({
      id, body: "", state, submittedAt: iso(at), assoc: "MEMBER", commit: sha(1), login: "bob",
    });
    world.reviews = [review("1", "CHANGES_REQUESTED", T0 - 3000), review("2", "APPROVED", T0 - 2000), review("3", "PENDING", T0 - 1000)];
    const read = await readFacts(world.ports(), PR_URL);
    expect(read.reviewers).toEqual([{ login: "bob", state: "APPROVED", commitSha: sha(1), submittedAt: iso(T0 - 2000) }]);
  });

  it("names the failed and pending checks and the head repository of a fork", async () => {
    const world = new World();
    world.cross = true;
    world.checks = [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "legacy", state: "PENDING" },
    ];
    const read = await readFacts(world.ports(), PR_URL);
    expect(read.checks).toEqual({ verdict: "pending", failed: ["build"], pending: ["legacy"] });
    expect(read.isCrossRepository).toBe(true);
    expect(read.headRepo).toBe("alice/widgets");
  });

  it("falls back to the commit date for the push time when no check suite exists", async () => {
    const world = new World();
    const inner = world.gh;
    world.gh = async (args) => args[1]?.endsWith("/check-suites") ? JSON.stringify({ check_suites: [] }) : inner(args);
    const read = await readFacts(world.ports(), PR_URL);
    expect(read.headPushedAt).toBe(iso(world.headPushedMs - 1000));
  });

  it("fails naming where the answer was the wrong shape", async () => {
    const world = new World();
    const inner = world.gh;
    world.gh = async (args) => args[1] === "user" ? JSON.stringify({ nope: true }) : inner(args);
    await expect(readFacts(world.ports(), PR_URL)).rejects.toThrow(/gh api user login/);
  });

  it("reads every GraphQL page, with or without --slurp", () => {
    expect(parsePaginatedPages("{\"a\":1}\n{\"a\":2}")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parsePaginatedPages("[{\"a\":1}]")).toEqual([{ a: 1 }]);
    expect(() => parsePaginatedPages("{\"a\":")).toThrow(/unparseable/);
  });
});

describe("headContains", () => {
  it("is true for the pushed head or a descendant, false otherwise or when compare fails", async () => {
    const world = new World();
    world.log = [sha(1), sha(2), sha(3)];
    expect(await headContains(world, REPO, sha(2), sha(2))).toBe(true);
    expect(await headContains(world, REPO, sha(2), sha(3))).toBe(true);
    expect(await headContains(world, REPO, sha(2), sha(9))).toBe(false);
    expect(await headContains({ gh: async () => { throw new Error("HTTP 404"); } }, REPO, sha(2), sha(3))).toBe(false);
  });
});

describe("waitUntilPrHeadSettled", () => {
  it("polls every 30 seconds until the head settles", async () => {
    const world = new World();
    world.checks = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }];
    let reads = 0;
    const inner = world.gh;
    world.gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view" && args.at(-1) !== "headRefOid" && ++reads === 3) {
        world.checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
      }
      return inner(args);
    };
    const start = world.clock;
    const reading = await waitUntilPrHeadSettled(world.ports(), PR_URL);
    expect(reading.verdict.kind).toBe("settled");
    expect(world.clock - start).toBe(2 * SETTLE_POLL_MS);
  });

  it("gives up as blocked, timed out, after the settle budget", async () => {
    const world = new World();
    world.checks = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }];
    const reading = await waitUntilPrHeadSettled(world.ports(), PR_URL);
    expect(reading).toMatchObject({ timedOut: true, verdict: { kind: "blocked" } });
    expect(reading.verdict.reasons.at(-1)).toBe(`did not settle within ${SETTLE_BUDGET_MS / 60_000} minutes`);
    expect(world.clock - T0).toBeLessThanOrEqual(SETTLE_BUDGET_MS);
  });

  it("treats a head that does not yet contain the pushed commit as working, never as a verdict on it", async () => {
    const world = new World();
    world.log = [sha(1), sha(2)];
    world.head = sha(1);
    const inner = world.gh;
    let reads = 0;
    world.gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view" && args.at(-1) !== "headRefOid" && ++reads === 3) world.head = sha(2);
      return inner(args);
    };
    const reading = await waitUntilPrHeadSettled(world.ports(), PR_URL, { expectedHead: sha(2) });
    expect(reading.facts.headSha).toBe(sha(2));
    expect(reading.verdict.kind).toBe("settled");
  });

  it("ends the wait at once for a merged or closed pull request", async () => {
    const world = new World();
    world.state = "MERGED";
    expect((await waitUntilPrHeadSettled(world.ports(), PR_URL, { expectedHead: sha(9) })).verdict.kind).toBe("merged");
  });
});

describe("mergeSettledApprovedPr and awaitMerged", () => {
  const settledFacts = facts();
  const verdict = judgePrSettled(settledFacts);
  const merger = (overrides: Partial<Parameters<typeof mergeSettledApprovedPr>[1]> = {}) => {
    const calls: string[][] = [];
    const ports = { gh: async (args: readonly string[]) => { calls.push([...args]); return ""; } };
    return { calls, run: () => mergeSettledApprovedPr(ports, { facts: settledFacts, verdict, merge: true, ...overrides }) };
  };

  it("squash-merges the judged head and nothing else", async () => {
    const m = merger();
    expect(await m.run()).toEqual({ merged: true, refused: false, reason: "" });
    expect(m.calls).toEqual([["pr", "merge", "7", "--repo", REPO, "--squash", "--match-head-commit", sha(1)]]);
  });

  it("does nothing, and says why, in every other case", async () => {
    const cases: [Partial<Parameters<typeof mergeSettledApprovedPr>[1]>, string][] = [
      [{ merge: false }, ""],
      [{ facts: facts({ state: "CLOSED" }) }, "not merged: the pull request is closed"],
      [{ target: "mergeable" }, "not merged: only a pull request settled for the approved target is merged"],
      [{ verdict: { kind: "blocked", headSha: sha(1), reasons: ["x"] } }, "not merged: the verdict is blocked"],
      [{ verdict: { kind: "settled", headSha: sha(2), reasons: [] } }, "not merged: the verdict is for a different head than the facts"],
      [{ facts: facts({ viewerCanPush: false }) }, "not merged: zach has no push access to acme/widgets"],
    ];
    for (const [overrides, reason] of cases) {
      const m = merger(overrides);
      expect(await m.run()).toEqual({ merged: false, refused: false, reason });
      expect(m.calls).toEqual([]);
    }
  });

  it("reports a refused merge as refused with gh's first line", async () => {
    const result = await mergeSettledApprovedPr(
      { gh: async () => { throw new Error("Head branch was modified\nretry"); } },
      { facts: settledFacts, verdict, merge: true },
    );
    expect(result).toEqual({ merged: false, refused: true, reason: `not merged: gh pr merge refused ${sha(1)}: Head branch was modified` });
  });

  it("observes merged, queued after the settle budget, and stuck", async () => {
    const merged = new World();
    merged.state = "MERGED";
    expect(await awaitMergedSettledApprovedPr(merged.ports(), { prUrl: PR_URL })).toEqual({ state: "merged", reason: "" });
    const closed = new World();
    closed.state = "CLOSED";
    expect(await awaitMergedSettledApprovedPr(closed.ports(), { prUrl: PR_URL })).toMatchObject({ state: "stuck" });
    const queued = new World();
    const result = await awaitMergedSettledApprovedPr(queued.ports(), { prUrl: PR_URL });
    expect(result.state).toBe("queued");
    expect(result.reason).toContain("the queue, not this run, merges it");
    expect(queued.clock - T0).toBeLessThanOrEqual(SETTLE_BUDGET_MS);
  });
});

describe("fixOpenPrIssuesOneCommitEachWithOmp", () => {
  const threadIssue: Issue = { kind: "thread", id: "T1", path: "a.ts", author: "bob", body: "rename x" };
  const run = (world: World, issues: Issue[], number = 1, f: Facts = facts()) =>
    fixOpenPrIssuesOneCommitEachWithOmp(world.ports(), { facts: f, issues, number });

  it("runs the round's role in a clean checkout, points the push URL nowhere, and restores it", async () => {
    const world = new World();
    const attempt = await run(world, [threadIssue]);
    expect(attempt).toEqual({ number: 1, role: "@task", cwd: "/work", fromSha: sha(1), commits: 1, agentStatus: 0, problem: "" });
    expect(world.agentRoles).toEqual(["@task"]);
    expect(world.gitCalls).toContain(`remote set-url --push origin ${AGENT_PUSH_URL}`);
    expect(world.gitCalls.at(-1)).toBe("config --unset-all remote.origin.pushurl");
    expect(world.agentPrompts[0]).toContain(PR_URL);
    expect(world.agentPrompts[0]).toContain("\"kind\": \"thread\"");
    expect(world.agentPrompts[0]).not.toContain("{{");
    expect((await run(new World(), [threadIssue], 2)).role).toBe("@slow");
    expect(roleOfRound(3)).toBe("@slow");
  });

  it("refuses a round number outside the budget", async () => {
    await expect(run(new World(), [threadIssue], 0)).rejects.toThrow(/there is no fix round 0/);
    await expect(run(new World(), [threadIssue], PR_BUDGET.rounds + 1)).rejects.toThrow(/there is no fix round 21/);
  });

  it("fails without running the agent when the pull request is not open or the head moved", async () => {
    const closed = new World();
    expect(await run(closed, [threadIssue], 1, facts({ state: "CLOSED" }))).toMatchObject({ problem: "the pull request is closed", agentStatus: -1 });
    expect(closed.agentPrompts).toEqual([]);
    const moved = new World();
    expect((await run(moved, [threadIssue], 1, facts({ headSha: sha(5) }))).problem).toBe(
      `the head moved since it was judged: checked out ${sha(1)}, judged ${sha(5)}`,
    );
    expect(moved.agentPrompts).toEqual([]);
  });

  it("merges the base itself and runs no agent when the merge is clean", async () => {
    const world = new World();
    const attempt = await run(world, [{ kind: "merge-base", baseRef: "main", why: "behind" }]);
    expect(attempt).toMatchObject({ commits: 1, agentStatus: -1, problem: "" });
    expect(world.agentPrompts).toEqual([]);
    expect(world.gitCalls).toContain("merge --no-edit origin/main");
  });

  it("hands the agent only the conflicts git reports", async () => {
    const world = new World();
    world.baseMerge = "conflict";
    world.agent = (w) => {
      w.midMerge = false;
      w.commit();
      return 0;
    };
    const attempt = await run(world, [{ kind: "merge-base", baseRef: "main", why: "conflicts" }]);
    expect(attempt.problem).toBe("");
    expect(world.agentPrompts[0]).toContain("\"kind\": \"conflict\"");
    expect(world.agentPrompts[0]).toContain("a.ts");
    expect(world.agentPrompts[0]).not.toContain("\"kind\": \"merge-base\"");
  });

  it("fails when the base cannot be fetched or merged, and when the merge changed nothing", async () => {
    const world = new World();
    world.baseMerge = "fail";
    expect((await run(world, [{ kind: "merge-base", baseRef: "main", why: "x" }])).problem).toMatch(/^fetching origin\/main failed/);
    const unchanged = new World();
    unchanged.baseMerge = "unchanged";
    expect((await run(unchanged, [{ kind: "merge-base", baseRef: "main", why: "x" }])).problem).toBe(
      "merging origin/main changed nothing: the head already contains it",
    );
  });

  it("reports an agent that crashed, exited non-zero, was stopped at its budget, or made no commit", async () => {
    const crash = new World();
    crash.agent = () => { throw new Error("spawn failed\nmore"); };
    expect((await run(crash, [threadIssue])).problem).toBe("omp @task crashed: spawn failed");
    const bad = new World();
    bad.agent = () => 3;
    expect((await run(bad, [threadIssue])).problem).toBe("omp @task exited 3");
    const slow = new World();
    slow.agent = () => ROUND_BUDGET_EXIT;
    expect((await run(slow, [threadIssue])).problem).toContain(`stopped at the ${ROUND_AGENT_BUDGET_MS / 60_000}-minute round budget`);
    const idle = new World();
    idle.agent = () => 0;
    expect((await run(idle, [threadIssue])).problem).toBe("omp @task made no commit");
  });

  it("refuses a tree left dirty or mid-merge, and rewritten history", async () => {
    const dirty = new World();
    dirty.agent = (w) => { w.commit(); w.dirty = true; return 0; };
    expect((await run(dirty, [threadIssue])).problem).toBe("the tree was left with uncommitted changes: src/a.ts, tmp.log");
    const merging = new World();
    merging.agent = (w) => { w.commit(); w.midMerge = true; return 0; };
    expect((await run(merging, [threadIssue])).problem).toBe("the tree was left mid-merge");
    const rewritten = new World();
    rewritten.agent = (w) => { w.commit(); w.rewritten = true; return 0; };
    expect((await run(rewritten, [threadIssue])).problem).toBe("the agent rewrote history: the judged head is not an ancestor");
  });

  it("fills the prompt with the pull request, base, round budget and issues", () => {
    const prompt = fixRoundPrompt(facts(), [threadIssue]);
    expect(prompt).toContain(`You are fixing pull request ${PR_URL}`);
    expect(prompt).toContain("merge of `origin/main`");
    expect(prompt).toContain(`bounded at ${ROUND_AGENT_BUDGET_MS / 60_000} minutes`);
    expect(prompt.endsWith(`${JSON.stringify([threadIssue], null, 2)}\n`)).toBe(true);
  });
});

describe("pushPrFixRoundToHeadBranch", () => {
  async function attemptOf(world: World, f: Facts = facts()) {
    return fixOpenPrIssuesOneCommitEachWithOmp(world.ports(), {
      facts: f,
      issues: [{ kind: "thread", id: "T1", path: "a.ts", author: "bob", body: "x" }],
      number: 1,
    });
  }

  it("pushes once to the head branch and reports pushed when GitHub shows the new head", async () => {
    const world = new World();
    const f = facts();
    const attempt = await attemptOf(world, f);
    const round = await pushPrFixRoundToHeadBranch(world.ports(), { facts: f, attempt });
    expect(round).toEqual({ number: 1, role: "@task", fromSha: sha(1), commits: 1, status: "pushed", reason: "", toSha: world.localHead, refusal: "" });
    expect(world.gitCalls.filter((c) => c.startsWith("push"))).toEqual(["push origin HEAD:refs/heads/fix/x"]);
    expect(world.progress.some((m) => m.includes("pre-push gate"))).toBe(true);
  });

  it("waits through a lagging head and fails, naming the pushed SHA, when it never appears", async () => {
    const lagging = new World();
    lagging.lagReads = 2;
    const f = facts();
    const attempt = await attemptOf(lagging, f);
    const start = lagging.clock;
    expect((await pushPrFixRoundToHeadBranch(lagging.ports(), { facts: f, attempt })).status).toBe("pushed");
    expect(lagging.clock - start).toBe(2 * SETTLE_POLL_MS);
    const never = new World();
    never.lagReads = 10_000;
    const attempt2 = await attemptOf(never, f);
    const round = await pushPrFixRoundToHeadBranch(never.ports(), { facts: f, attempt: attempt2 });
    expect(round).toMatchObject({ status: "failed", toSha: never.localHead });
    expect(round.reason).toContain(`minutes after the push of ${never.localHead}`);
    expect(never.clock - T0).toBeLessThanOrEqual(PUSH_VISIBLE_BUDGET_MS);
  });

  it("records a refused push with git's output so the next round can fix it", async () => {
    const world = new World();
    world.pushRefusal = "hk: pre-push failed: pin comment missing";
    const f = facts();
    const round = await pushPrFixRoundToHeadBranch(world.ports(), { facts: f, attempt: await attemptOf(world, f) });
    expect(round.status).toBe("failed");
    expect(round.reason).toStartWith("push refused:");
    expect(round.refusal).toContain("pin comment missing");
    expect(round.toSha).toBeNull();
  });

  it("does not push a failed attempt, a closed pull request, an unchanged head, or a fork it cannot push to", async () => {
    const world = new World();
    const f = facts();
    const base = { number: 1, role: "@task" as const, cwd: "/work", fromSha: sha(1), commits: 0, agentStatus: 0 };
    const push = (attempt: typeof base & { problem: string }, forFacts: Facts = f) =>
      pushPrFixRoundToHeadBranch(world.ports(), { facts: forFacts, attempt });
    expect((await push({ ...base, problem: "omp @task made no commit" })).reason).toBe("omp @task made no commit");
    expect((await push({ ...base, problem: "" }, facts({ state: "MERGED" }))).reason).toBe("the pull request is merged");
    expect((await push({ ...base, problem: "" })).reason).toBe(`the head SHA is unchanged: the checkout is still at ${sha(1)}`);
    world.commit();
    expect((await push({ ...base, problem: "" }, facts({ isCrossRepository: true, viewerCanPush: false, headRepo: "alice/widgets" }))).reason)
      .toBe("the head branch is on a fork; this run pushes only to a fork the viewer owns");
    expect(world.gitCalls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("pushes to the fork's own URL when the viewer owns the fork", async () => {
    const world = new World();
    world.commit();
    const f = facts({ isCrossRepository: true, viewerCanPush: false, author: "zach", viewer: "zach", headRepo: "zach/widgets" });
    const attempt = { number: 1, role: "@task" as const, cwd: "/work", fromSha: sha(1), commits: 1, agentStatus: 0, problem: "" };
    await pushPrFixRoundToHeadBranch(world.ports(), { facts: f, attempt });
    expect(world.gitCalls).toContain("push https://github.com/zach/widgets.git HEAD:refs/heads/fix/x");
  });
});

describe("makePrMergable", () => {
  let world: World;
  beforeEach(() => {
    world = new World();
  });

  it("reports done for a pull request that is already settled, merging nothing", async () => {
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state).toMatchObject({ status: "done", reasons: [], rounds: [] });
    expect(world.agentPrompts).toEqual([]);
    expect(world.merges).toEqual([]);
  });

  it("merges a settled approved pull request on request, naming the judged head, and reports merged", async () => {
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true });
    expect(state.status).toBe("merged");
    expect(world.merges).toEqual([["pr", "merge", "7", "--repo", REPO, "--squash", "--match-head-commit", sha(1)]]);
  });

  it("reports queued when the merge only entered a merge queue", async () => {
    world.mergeMode = "queue";
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true });
    expect(state.status).toBe("queued");
    expect(state.reasons.at(-1)).toContain("the queue, not this run, merges it");
  });

  it("reports impossible when GitHub refuses the merge", async () => {
    world.mergeMode = "refuse";
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true });
    expect(state).toMatchObject({ status: "impossible" });
    expect(state.reasons[0]).toContain("gh pr merge refused");
  });

  it("never merges for the mergeable target", async () => {
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true, target: "mergeable" });
    expect(state.status).toBe("done");
    expect(state.reasons).toEqual(["not merged: only a pull request settled for the approved target is merged"]);
    expect(world.merges).toEqual([]);
  });

  it("reports an already merged pull request as merged without a round, and a closed one as impossible", async () => {
    world.state = "MERGED";
    expect((await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true })).status).toBe("merged");
    expect(world.merges).toEqual([]);
    const closed = new World();
    closed.state = "CLOSED";
    expect(await makePrMergable(closed.ports(), { prUrl: PR_URL })).toMatchObject({ status: "impossible", reasons: ["the pull request is closed"] });
  });

  it("fixes an unresolved thread in one round, pushes once, and ends done", async () => {
    world.threads = [{ id: "T1", resolved: false, body: "rename x", path: "a.ts", login: "bob" }];
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("done");
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]).toMatchObject({ number: 1, role: "@task", status: "pushed", commits: 1 });
    expect(world.agentPrompts).toHaveLength(1);
    expect(world.gitCalls.filter((c) => c.startsWith("push"))).toHaveLength(1);
    expect(await world.ledger.spent(PR_URL)).toBe(PR_BUDGET.reserveUsd);
    expect(stateText(state)).toContain("round 1 (@task): pushed, 1 commit");
  });

  it("works round 2 on @slow after a first round that left the check red", async () => {
    world.checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
    let pushes = 0;
    world.afterPush = (w) => {
      pushes += 1;
      if (pushes === 2) w.checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
    };
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("done");
    expect(world.agentRoles).toEqual(["@task", "@slow"]);
    expect(state.rounds.map((round) => round.status)).toEqual(["pushed", "pushed"]);
  });

  it("stops at the per-head cap when a round makes no commit, and reports spent with the head named", async () => {
    world.threads = [{ id: "T1", resolved: false, body: "rename x", path: "a.ts", login: "bob" }];
    world.agent = () => 0;
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("spent");
    expect(state.rounds).toHaveLength(PR_BUDGET.perKey);
    expect(state.reasons.at(-1)).toBe(`the run spent its budget: 3 rounds already started on ${sha(1)} (limit 3 per key)`);
    expect(state.reasons).toContain("round 1 (@task) failed: omp @task made no commit");
    expect(world.gitCalls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("starts no round when the pull request's lifetime spend leaves no headroom", async () => {
    world.threads = [{ id: "T1", resolved: false, body: "rename x", path: "a.ts", login: "bob" }];
    await world.ledger.charge(PR_URL, PR_BUDGET.costUsd - PR_BUDGET.reserveUsd + 0.01);
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("spent");
    expect(world.agentPrompts).toEqual([]);
  });

  it("hands a refused push to the next round as an issue", async () => {
    world.threads = [{ id: "T1", resolved: false, body: "rename x", path: "a.ts", login: "bob" }];
    world.pushRefusal = "hk: pre-push failed: pin comment missing";
    let refusedOnce = false;
    const inner = world.git;
    world.git = async (args, cwd) => {
      if (args[0] === "push" && !refusedOnce) {
        refusedOnce = true;
        return inner(args, cwd);
      }
      if (args[0] === "push") world.pushRefusal = undefined;
      return inner(args, cwd);
    };
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("done");
    expect(world.agentPrompts[1]).toContain("\"kind\": \"push-refused\"");
    expect(world.agentPrompts[1]).toContain("pin comment missing");
  });

  it("reports a dry run's findings as working without editing, pushing or merging", async () => {
    world.threads = [{ id: "T1", resolved: false, body: "rename x", path: "a.ts", login: "bob" }];
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, dryRun: true, merge: true });
    expect(state).toMatchObject({ status: "working", dryRun: true });
    expect(state.issues).toHaveLength(1);
    expect(world.agentPrompts).toEqual([]);
    expect(world.merges).toEqual([]);
    expect(world.gitCalls).toEqual([]);
  });

  it("reports impossible, with no round, for a draft with nothing to fix or a viewer who cannot push", async () => {
    world.isDraft = true;
    expect(await makePrMergable(world.ports(), { prUrl: PR_URL })).toMatchObject({ status: "impossible", reasons: ["the pull request is a draft"] });
    const readOnly = new World();
    readOnly.canPush = false;
    readOnly.threads = [{ id: "T1", resolved: false, body: "x", path: "a.ts", login: "bob" }];
    const state = await makePrMergable(readOnly.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("impossible");
    expect(readOnly.agentPrompts).toEqual([]);
  });

  it("works a draft's issues, then reports it impossible and never merges it", async () => {
    world.isDraft = true;
    world.threads = [{ id: "T1", resolved: false, body: "rename x", path: "a.ts", login: "bob" }];
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true });
    expect(state.rounds).toHaveLength(1);
    expect(state.status).toBe("impossible");
    expect(world.merges).toEqual([]);
  });

  it("waits for pending checks without a round, then finishes", async () => {
    world.checks = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }];
    let reads = 0;
    const inner = world.gh;
    world.gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view" && args.at(-1) !== "headRefOid" && ++reads === 3) {
        world.checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
      }
      return inner(args);
    };
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("done");
    expect(world.agentPrompts).toEqual([]);
    expect(world.progress.some((m) => m.startsWith("waiting for the head to settle"))).toBe(true);
  });

  it("reports spent when checks never leave pending", async () => {
    world.checks = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }];
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("spent");
    expect(state.reasons.at(-1)).toContain("did not settle within 45 minutes");
  });

  it("does not hand a drive-by comment to the agent, but still blocks on it", async () => {
    world.comments = [{ id: "U", body: "do this other thing", createdAt: iso(world.headPushedMs + 60_000), assoc: "NONE", login: "stranger" }];
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL });
    expect(state.status).toBe("impossible");
    expect(world.agentPrompts).toEqual([]);
    expect(state.reasons).toContain("1 comment without a fix pushed after");
  });

  it("makes a fork's author-only run mergeable and unmerged", async () => {
    world.cross = true;
    world.canPush = false;
    world.viewer = "alice";
    const state = await makePrMergable(world.ports(), { prUrl: PR_URL, merge: true });
    expect(state).toMatchObject({ target: "mergeable", merge: false });
    expect(world.merges).toEqual([]);
  });
});

describe("exec, ledger and checkout", () => {
  it("runs real processes: stdout, failures with stderr last, timeouts and cancellation", async () => {
    const run = spawnRunner();
    expect((await command(run, "git", ["-c", "alias.say=!printf hi", "say"])).trim()).toBe("hi");
    await expect(command(run, "git", ["-c", "alias.fail=!echo HTTP 502 >&2; exit 3", "fail"])).rejects.toThrow(/\(exit 3\)\nHTTP 502/s);
    // A real child and a real 100 ms timer: the timeout is the platform behavior under test.
    expect((await run("git", ["-c", "alias.nap=!sleep 5", "nap"], { timeoutMs: 100, graceMs: 100 })).killed).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(spawnRunner({ signal: controller.signal })("git", ["--version"])).rejects.toThrow(/cancelled/);
    await expect(sleep(10, controller.signal)).rejects.toThrow(/cancelled/);
    await expect(run("definitely-not-a-program-xyz", [])).rejects.toThrow(/is not a program this tool runs/);
  });

  it("keeps the lifetime spend in one file per owner, so a rerun cannot reset it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpm-ledger-"));
    try {
      const ledger = fileLedger(directory);
      expect(await ledger.spent(PR_URL)).toBe(0);
      expect(await ledger.charge(PR_URL, 2)).toBe(2);
      expect(await fileLedger(directory).charge(PR_URL, 2)).toBe(4);
      expect(JSON.parse(await readFile(join(directory, `${encodeURIComponent(PR_URL)}.json`), "utf8"))).toEqual({ owner: PR_URL, usd: 4 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("names the first limit the budget reaches", () => {
    expect(nextRound([{ key: "a" }, { key: "a" }, { key: "a" }], "a", 0, PR_BUDGET, 0)).toMatchObject({ go: false });
    expect(nextRound([], "a", 0, PR_BUDGET, PR_BUDGET.wallMs)).toMatchObject({ go: false });
    expect(nextRound(Array.from({ length: 20 }, (_, i) => ({ key: String(i) })), "z", 0, PR_BUDGET, 0)).toMatchObject({ go: false });
    expect(nextRound([], "a", 23, PR_BUDGET, 0)).toEqual({ go: true });
  });

  describe("pullRequestCheckout", () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "mpm-checkout-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const SHA = "a".repeat(40);
    function git(head = SHA, status = "") {
      const calls: string[] = [];
      const runner: Runner = async (program, args) => {
        calls.push([program, ...args].join(" "));
        if (program === "gh" && args.includes("headRefOid")) return ok(JSON.stringify({ headRefOid: SHA }));
        if (args.includes("rev-parse")) return ok(`${head}\n`);
        if (args.includes("status")) return ok(status);
        if (args.includes("--abort") || args.includes("--unset-all")) return { code: 1, stdout: "", stderr: "none", killed: false };
        return ok("");
      };
      return { runner, calls };
    }

    it("clones, fetches refs/pull/N/head, resets and cleans; reuses an existing clone", async () => {
      const first = git();
      const dir = await pullRequestCheckout(first.runner, root, PR_URL);
      expect(dir).toBe(checkoutDir(root, PR_URL));
      expect(first.calls).toContain(`gh repo clone acme/widgets ${dir} -- --filter=blob:none --no-checkout`);
      expect(first.calls).toContain(`git -C ${dir} fetch --no-tags origin refs/pull/7/head`);
      expect(first.calls).toContain(`git -C ${dir} clean -ffdx`);
      await mkdir(dir, { recursive: true });
      const second = git();
      await pullRequestCheckout(second.runner, root, PR_URL);
      expect(second.calls.some((c) => c.startsWith("gh repo clone"))).toBe(false);
    });

    it("refuses a dirty tree or a HEAD that is not the pull request head", async () => {
      await mkdir(checkoutDir(root, PR_URL), { recursive: true });
      await expect(pullRequestCheckout(git(SHA, " M a.ts\n").runner, root, PR_URL)).rejects.toThrow(/not clean/);
      await expect(pullRequestCheckout(git("b".repeat(40)).runner, root, PR_URL)).rejects.toThrow(/pull request head is/);
    });

    it("keeps checkouts under the platform cache directory", () => {
      expect(checkoutRoot("darwin", {}, "/h")).toBe("/h/Library/Caches/make-pr-mergable");
      expect(checkoutRoot("linux", {}, "/h")).toBe("/h/.cache/make-pr-mergable");
    });
  });
});

describe("ompRoundStatus and pushEnv", () => {
  it("hands omp the prompt as a private file with the round's role, and removes it", async () => {
    let seen: { program: string; args: readonly string[] } | undefined;
    let text = "";
    const runner: Runner = async (program, args) => {
      seen = { program, args };
      text = await readFile(String(args[1]).slice(1), "utf8");
      return ok("");
    };
    expect(await ompRoundStatus(runner, { cwd: "/w", prompt: "do it", role: "@slow", budgetMs: 1000 })).toBe(0);
    expect(seen?.program).toBe("omp");
    expect(seen?.args.slice(2)).toEqual(["--cwd", "/w", "--model", "@slow"]);
    expect(text).toBe("do it");
    expect(await Bun.file(String(seen?.args[1]).slice(1)).exists()).toBe(false);
  });

  it("returns omp's exit code, 124 when stopped at its budget, and throws when cancelled", async () => {
    expect(await ompRoundStatus(async () => ({ code: 5, stdout: "", stderr: "", killed: false }), { cwd: "/w", prompt: "p", role: "@task", budgetMs: 1 })).toBe(5);
    expect(await ompRoundStatus(async () => ({ code: -1, stdout: "", stderr: "", killed: true }), { cwd: "/w", prompt: "p", role: "@task", budgetMs: 1 })).toBe(ROUND_BUDGET_EXIT);
    const controller = new AbortController();
    controller.abort();
    await expect(
      ompRoundStatus(async () => ({ code: -1, stdout: "", stderr: "", killed: true }), { cwd: "/w", prompt: "p", role: "@task", budgetMs: 1, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it("gives the push the gh login's token when there is one, and the plain environment when not", async () => {
    const withToken = await pushEnv(async () => ok("tok123\n"));
    expect(withToken.GITHUB_TOKEN).toBe("tok123");
    expect(withToken.GH_TOKEN).toBe("tok123");
    expect(await pushEnv(async () => ({ code: 1, stdout: "", stderr: "not logged in", killed: false }))).toBe(process.env);
  });
});
