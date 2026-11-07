import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLedger, nextRound, PR_BUDGET, type SpendLedger } from "./budget.js";
import { checkoutDir, checkoutRoot, pullRequestCheckout } from "./checkout.js";
import { type CheckRollupEntry, ciVerdict, type CiReading, settledCiVerdict } from "./ci_verdict.js";
import { parsePaginatedPages } from "./decode.js";
import { command, type RunOptions, type Runner, type RunResult, sleep, spawnRunner } from "./exec.js";
import { unresolvedReviewThreads } from "./github.js";
import { ompAgent } from "./live_ports.js";
import { parsePullRequestUrl } from "./parse_url.js";
import type { ImprovePorts } from "./ports.js";
import { improvePr, outcomeText } from "./workflow.js";

const sha = (digit: string | number): string => String(digit).repeat(40);
const PR_URL = "https://github.com/zachbornheimer/portal-builder/pull/9";

class MemoryLedger implements SpendLedger {
  readonly totals = new Map<string, number>();
  spent = async (owner: string): Promise<number> => this.totals.get(owner) ?? 0;
  charge = async (owner: string, usd: number): Promise<number> => {
    const total = (this.totals.get(owner) ?? 0) + usd;
    this.totals.set(owner, total);
    return total;
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", killed: false });

/**
 * What `gh`, `git` and `ocr` would answer, and what was asked of them and of the code improver. Nothing here touches the
 * network, a process or a real repository.
 */
class World {
  commands: string[] = [];
  asks: string[] = [];
  ciFixAsks = 0;
  ocrBroken = false;
  /** CI stays red on the same head, whatever the agent does. */
  stuckRed = false;
  threadsAnswered = false;
  clockMs = 0;
  slept: number[] = [];
  readonly ledger = new MemoryLedger();

  private get reportedHead(): string {
    return sha(this.stuckRed ? 0 : this.ciFixAsks);
  }

  run: Runner = async (program: string, args: readonly string[], _options?: RunOptions) => {
    this.commands.push([program, ...args].join(" "));
    if (program === "gh" && args[0] === "pr" && args.includes("url,title,body,baseRefName,baseRefOid,headRefOid,state")) {
      return ok(JSON.stringify({
        url: PR_URL,
        title: "Add x",
        body: null,
        baseRefName: "main",
        baseRefOid: sha("b"),
        headRefOid: sha(0),
        state: "OPEN",
      }));
    }
    if (program === "gh" && args[0] === "pr") {
      const red = this.stuckRed || this.ciFixAsks === 0;
      return ok(JSON.stringify({
        headRefOid: this.reportedHead,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: red ? "FAILURE" : "SUCCESS" }],
      }));
    }
    if (program === "gh" && args[0] === "api") {
      const comment = { body: "rename x", path: "a.ts", author: { login: "reviewer" } };
      return ok(JSON.stringify([{
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  id: "thread-1",
                  isResolved: this.threadsAnswered,
                  initial: { nodes: [comment] },
                  latest: { nodes: [comment] },
                }],
              },
            },
          },
        },
      }]));
    }
    if (program === "git" && args.includes("rev-parse")) {
      const ref = args.at(-1);
      if (ref === "refs/remotes/origin/review-base") return ok(`${sha("b")}\n`);
      if (ref === "refs/remotes/origin/review-head") return ok(`${sha(0)}\n`);
      return ok(`${sha(0)}\n`);
    }
    if (program === "ocr") {
      if (this.ocrBroken) return { code: 1, stdout: "", stderr: "ocr: no provider configured", killed: false };
      return ok(JSON.stringify({ status: "complete", comments: [{ path: "a.ts", content: "x is unclear" }] }));
    }
    return ok("");
  };

  ports(): ImprovePorts {
    return {
      run: this.run,
      checkout: async () => "/tmp/pr-worktree",
      agent: async ({ prompt }) => {
        this.asks.push(prompt);
        if (prompt.includes("Investigate review thread")) this.threadsAnswered = true;
        if (prompt.includes("CI failures")) {
          this.ciFixAsks += 1;
        }
      },
      ledger: this.ledger,
      now: () => this.clockMs,
      sleep: async (ms) => {
        this.slept.push(ms);
        this.clockMs += ms;
      },
      progress: () => {},
    };
  }
}

const check = (conclusion: string, status = "COMPLETED"): CheckRollupEntry => ({
  __typename: "CheckRun",
  status,
  conclusion,
});

describe("parsePullRequestUrl", () => {
  it("accepts a canonical PR URL and a trailing slash", () => {
    expect(parsePullRequestUrl("https://github.com/Acme/code-improver/pull/123")).toEqual({
      owner: "Acme",
      repo: "code-improver",
      number: 123,
    });
    expect(parsePullRequestUrl("https://github.com/Acme/repo/pull/1/").number).toBe(1);
  });

  it("rejects lookalike hosts, unexpected routes, and credentials", () => {
    const credentialed = new URL("https://github.com/Acme/repo/pull/1");
    credentialed.username = "user";
    for (
      const url of [
        "https://github.com.attacker.example/Acme/repo/pull/1",
        "https://evil.example/github.com/Acme/repo/pull/1",
        "https://github.com/Acme/repo/pull/1/files",
        "https://github.com/Acme/repo/pull/1?diff=1",
        credentialed.href,
        "http://github.com/Acme/repo/pull/1",
        "https://github.com/Acme/repo/pull/0",
        "https://github.com/Acme/repo/pull/99999999999999999999",
        "not a url",
      ]
    ) expect(() => parsePullRequestUrl(url)).toThrow();
  });
});

describe("ciVerdict", () => {
  it("is green only when every check passed, skipped or was neutral", () => {
    expect(ciVerdict([check("SUCCESS"), check("SKIPPED"), check("NEUTRAL")])).toBe("green");
  });
  it("never mistakes an empty check list for green", () => {
    expect(ciVerdict([])).toBe("no-checks");
  });
  it("is red once every check is terminal and one failed", () => {
    expect(ciVerdict([check("SUCCESS"), check("FAILURE")])).toBe("red");
  });
  it("is pending while any check runs, even if another has already failed", () => {
    expect(ciVerdict([check("FAILURE"), check("", "IN_PROGRESS")])).toBe("pending");
  });
  it("fails closed on unknown check types and missing conclusions", () => {
    expect(ciVerdict([{ __typename: "Other", state: "SUCCESS" }])).toBe("red");
    expect(ciVerdict([{ __typename: "CheckRun", status: "COMPLETED" }])).toBe("red");
    expect(ciVerdict([{ __typename: "StatusContext", state: "SUCCESS" }])).toBe("green");
  });
});

describe("settledCiVerdict", () => {
  const headA = sha("a");
  const headB = sha("c");
  const running = check("", "IN_PROGRESS");
  function observations(...readings: CiReading[]) {
    let index = 0;
    let waits = 0;
    return {
      read: async () => readings[Math.min(index++, readings.length - 1)]!,
      wait: async () => {
        waits++;
      },
      waits: () => waits,
    };
  }

  it("waits for delayed registration and succeeds when checks appear", async () => {
    const poller = observations(
      { headSha: headA, rollup: [] },
      { headSha: headA, rollup: [] },
      { headSha: headA, rollup: [running] },
      { headSha: headA, rollup: [check("SUCCESS")] },
    );
    expect((await settledCiVerdict(poller.read, poller.wait, 5)).verdict).toBe("green");
    expect(poller.waits()).toBe(3);
  });

  it("reports no-checks, not green, once a head has stayed empty past the registration grace", async () => {
    const poller = observations({ headSha: headA, rollup: [] });
    expect((await settledCiVerdict(poller.read, poller.wait, 5)).verdict).toBe("no-checks");
  });

  it("restarts the registration grace period for a new head", async () => {
    const poller = observations(
      { headSha: headA, rollup: [] },
      { headSha: headA, rollup: [] },
      { headSha: headB, rollup: [] },
      { headSha: headB, rollup: [check("SUCCESS")] },
    );
    const result = await settledCiVerdict(poller.read, poller.wait, 5);
    expect(result.headSha).toBe(headB);
    expect(result.verdict).toBe("green");
  });

  it("reports timed-out, not red, when checks never leave pending", async () => {
    const poller = observations({ headSha: headA, rollup: [running] });
    expect((await settledCiVerdict(poller.read, poller.wait, 3)).verdict).toBe("timed-out");
  });

  it("rejects invalid polling budgets", async () => {
    const poller = observations({ headSha: headA, rollup: [] });
    await expect(settledCiVerdict(poller.read, poller.wait, 0)).rejects.toThrow(/Invalid CI/);
  });
});

describe("parsePaginatedPages", () => {
  it("reads a single page, a --slurp array, and concatenated pages without --slurp", () => {
    expect(parsePaginatedPages("{\"data\":{\"page\":1}}")).toEqual([{ data: { page: 1 } }]);
    expect(parsePaginatedPages("[{\"data\":{\"page\":1}}]")).toEqual([{ data: { page: 1 } }]);
    expect(parsePaginatedPages("{\"data\":{\"note\":\"a {b} c\"}}\n{\"data\":{\"page\":2}}")).toEqual([
      { data: { note: "a {b} c" } },
      { data: { page: 2 } },
    ]);
    expect(parsePaginatedPages("")).toEqual([]);
  });
  it("refuses output it cannot split into pages", () => {
    expect(() => parsePaginatedPages("{\"data\":{\"page\":1}")).toThrow(/unparseable/);
  });
});

describe("unresolvedReviewThreads", () => {
  const page = (...threads: { id: string; resolved: boolean }[]) => ({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((thread) => ({
              id: thread.id,
              isResolved: thread.resolved,
              initial: { nodes: [{ body: "b", path: "a.ts", author: { login: "r" } }] },
              latest: { nodes: [{ body: "b", path: "a.ts", author: null }] },
            })),
          },
        },
      },
    },
  });
  const pr = {
    owner: "o",
    repo: "r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "t",
    description: "",
    baseRef: "main",
    baseSha: sha(1),
    headSha: sha(2),
  };

  it("returns every unresolved thread across pages, and does not pass --slurp", async () => {
    const seen: string[][] = [];
    const run: Runner = async (_program, args) => {
      seen.push([...args]);
      return ok(`${JSON.stringify(page({ id: "A", resolved: false }, { id: "B", resolved: true }))}\n${JSON.stringify(page({ id: "C", resolved: false }))}`);
    };
    const threads = await unresolvedReviewThreads(run, pr);
    expect(threads.map((thread) => thread.id)).toEqual(["A", "C"]);
    expect(seen[0]).toContain("--paginate");
    expect(seen[0]).not.toContain("--slurp");
  });

  it("rejects an answer of the wrong shape, naming where", async () => {
    const run: Runner = async () => ok("{\"data\":{\"repository\":null}}");
    await expect(unresolvedReviewThreads(run, pr)).rejects.toThrow(/review threads page 0.*repository/);
  });
});

describe("command and spawnRunner", () => {
  // The runner starts only gh, git, ocr and omp, so these tests put a stand-in `git` first on the child's PATH.
  let standInEnv: NodeJS.ProcessEnv;
  beforeEach(async () => {
    const bin = await mkdtemp(join(tmpdir(), "stand-in-git-"));
    const script = join(bin, "git");
    await writeFile(
      script,
      "#!/bin/sh\nPATH=/bin:/usr/bin:$PATH\ncase \"$1\" in\n  say) printf hi;;\n  fail) echo 'HTTP 502' >&2; exit 3;;\n  hang) exec sleep 60;;\nesac\n",
    );
    await chmod(script, 0o755);
    standInEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  });

  it("returns stdout, and on failure names the program and carries stderr last", async () => {
    const run: Runner = (program, args, options) => spawnRunner()(program, args, { ...options, env: standInEnv });
    expect((await command(run, "git", ["say"])).trim()).toBe("hi");
    await expect(command(run, "git", ["fail"])).rejects.toThrow(/Command failed: git fail \(exit 3\)\nHTTP 502/s);
  });

  // A real child and a real 100 ms timer: the timeout is the platform behavior under test, no fake clock reaches it.
  it("stops a process at its timeout and reports it as killed", async () => {
    const result = await spawnRunner()("git", ["hang"], { timeoutMs: 100, graceMs: 100, env: standInEnv });
    expect(result.killed).toBe(true);
  });

  it("stops a process when the signal aborts, and refuses to start under an aborted signal", async () => {
    const controller = new AbortController();
    const running = spawnRunner({ signal: controller.signal })("git", ["hang"], { env: standInEnv });
    controller.abort();
    expect((await running).killed).toBe(true);
    await expect(spawnRunner({ signal: controller.signal })("git", ["say"], { env: standInEnv })).rejects.toThrow(/cancelled/);
    await expect(sleep(10, controller.signal)).rejects.toThrow(/cancelled/);
  });

  it("reports an absent program as a start failure, not a silent success", async () => {
    await expect(spawnRunner()("git", ["say"], { env: { PATH: "/nonexistent-dir" } })).rejects.toThrow(/failed to start/);
  });

  it("refuses a program outside the allowlist", async () => {
    await expect(spawnRunner()("node", ["-e", "0"])).rejects.toThrow(/refusing to run "node"/);
    await expect(command(spawnRunner(), "rm", ["-rf", "x"])).rejects.toThrow(/refusing to run "rm"/);
  });
});

describe("budget", () => {
  it("names the first limit reached", () => {
    expect(nextRound([{ key: "a" }, { key: "a" }, { key: "a" }], "a", 0, PR_BUDGET, 0)).toEqual({
      go: false,
      spent: "3 rounds already started on a (limit 3 per key)",
    });
    expect(nextRound([], "a", 24, PR_BUDGET, 0)).toMatchObject({ go: false });
    expect(nextRound([], "a", 23, PR_BUDGET, 0)).toEqual({ go: true });
  });

  it("keeps the lifetime spend in one JSON file per owner, so a rerun cannot reset it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "improve-pr-ledger-"));
    try {
      const ledger = fileLedger(directory);
      expect(await ledger.spent(PR_URL)).toBe(0);
      expect(await ledger.charge(PR_URL, 2)).toBe(2);
      expect(await fileLedger(directory).spent(PR_URL)).toBe(2);
      expect(await fileLedger(directory).charge(PR_URL, 2)).toBe(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("pullRequestCheckout", () => {
  const URL = "https://github.com/zachbornheimer/capabilities/pull/3";
  const SHA = "a".repeat(40);
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "improve-pr-checkout-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function git(options: { head?: string; status?: string } = {}) {
    const calls: string[][] = [];
    const run: Runner = async (program, args) => {
      calls.push([program, ...args]);
      if (program === "gh" && args.includes("headRefOid")) return ok(JSON.stringify({ headRefOid: SHA }));
      if (program === "git" && args.includes("rev-parse")) return ok(`${options.head ?? SHA}\n`);
      if (program === "git" && args.includes("status")) return ok(options.status ?? "");
      if (program === "git" && (args.includes("--abort") || args.includes("--unset-all"))) {
        return { code: 1, stdout: "", stderr: "nothing to abort", killed: false };
      }
      return ok("");
    };
    return { run, calls };
  }

  it("clones through gh and checks out refs/pull/N/head, not the base branch", async () => {
    const { run, calls } = git();
    const dir = await pullRequestCheckout(run, root, URL);
    expect(dir).toBe(checkoutDir(root, URL));
    expect(dir).toContain("zachbornheimer-capabilities-3");
    expect(calls.map((call) => call.join(" "))).toEqual([
      `gh pr view ${URL} --json headRefOid`,
      `gh repo clone zachbornheimer/capabilities ${dir} -- --filter=blob:none --no-checkout`,
      `git -C ${dir} merge --abort`,
      `git -C ${dir} rebase --abort`,
      `git -C ${dir} cherry-pick --abort`,
      `git -C ${dir} config --unset-all remote.origin.pushurl`,
      `git -C ${dir} fetch --no-tags origin refs/pull/3/head`,
      `git -C ${dir} checkout --detach --force ${SHA}`,
      `git -C ${dir} reset --hard ${SHA}`,
      `git -C ${dir} clean -ffdx`,
      `git -C ${dir} rev-parse HEAD`,
      `git -C ${dir} status --porcelain`,
    ]);
  });

  it("updates an existing clone instead of cloning again, and resets it before it moves", async () => {
    await mkdir(checkoutDir(root, URL), { recursive: true });
    const { run, calls } = git();
    await pullRequestCheckout(run, root, URL);
    expect(calls.some((call) => call[1] === "repo")).toBe(false);
    const steps = calls.map((call) => call.slice(3).join(" "));
    expect(steps.indexOf("merge --abort")).toBeLessThan(steps.findIndex((step) => step.startsWith("checkout")));
    expect(steps.findIndex((step) => step.startsWith("reset --hard"))).toBeLessThan(steps.indexOf("clean -ffdx"));
  });

  it("refuses a checkout that is still dirty after the reset", async () => {
    await mkdir(checkoutDir(root, URL), { recursive: true });
    await expect(pullRequestCheckout(git({ status: " M src/a.ts\n" }).run, root, URL)).rejects.toThrow(
      /not clean after the reset/,
    );
  });

  it("refuses a checkout whose HEAD is not the pull request head", async () => {
    const other = "b".repeat(40);
    await expect(pullRequestCheckout(git({ head: other }).run, root, URL)).rejects.toThrow(
      `checkout is ${other}, pull request head is ${SHA}`,
    );
  });

  it("keeps checkouts under the platform's cache directory", () => {
    expect(checkoutRoot("darwin", {}, "/home/u")).toBe("/home/u/Library/Caches/make-pr-mergable");
    expect(checkoutRoot("linux", {}, "/home/u")).toBe("/home/u/.cache/make-pr-mergable");
    expect(checkoutRoot("linux", { XDG_CACHE_HOME: "/x" }, "/home/u")).toBe("/x/make-pr-mergable");
  });
});

describe("ompAgent", () => {
  it("hands omp the prompt as a private file, pins the default role, and cleans up", async () => {
    let seen: { program: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    let promptText = "";
    const run: Runner = async (program, args, options) => {
      seen = { program, args, env: options?.env };
      promptText = await Bun.file(String(args[1]).slice(1)).text();
      return ok("");
    };
    await ompAgent(run)({ cwd: "/work", prompt: "do the thing" });
    expect(seen?.program).toBe("omp");
    expect(seen?.args.slice(0, 2)[0]).toBe("-p");
    expect(String(seen?.args[1]).startsWith("@")).toBe(true);
    expect(promptText).toBe("do the thing");
    expect(seen?.args).toContain("--no-session");
    expect(seen?.args.join(" ")).toContain("--model @default");
    expect(seen?.args.join(" ")).toContain("--cwd /work");
    expect(seen?.args).not.toContain("do the thing");
    expect(await Bun.file(String(seen?.args[1]).slice(1)).exists()).toBe(false);
  });

  it("fails on a non-zero exit and on a stopped process", async () => {
    await expect(ompAgent(async () => ({ code: 2, stdout: "", stderr: "boom", killed: false }))({ cwd: "/w", prompt: "p" }))
      .rejects.toThrow(/omp exited 2: boom/);
    await expect(ompAgent(async () => ({ code: -1, stdout: "", stderr: "", killed: true }))({ cwd: "/w", prompt: "p" }))
      .rejects.toThrow(/stopped/);
  });
});

describe("improve_pr", () => {
  let world: World;
  beforeEach(() => {
    world = new World();
  });

  it("reviews, fixes, answers comments and fixes CI until green, in that order", async () => {
    const outcome = await improvePr(world.ports(), PR_URL);
    expect(outcome).toEqual({
      improvedPrUrl: PR_URL,
      ciStatus: "green",
      reviewStatus: "complete",
      reviewedHeadSha: sha(0),
      finalHeadSha: sha(1),
      requiresAnotherPass: true, // the CI fix pushed a head the review never saw
      unresolvedThreads: 0,
    });
    expect(world.asks).toHaveLength(3);
    expect(world.asks[0]).toContain("x is unclear");
    expect(world.asks[0]).toContain("OpenCodeReview");
    expect(world.asks[1]).toContain("rename x");
    expect(world.asks[2]).toContain("CI failures");
    expect(world.commands.some((c) => c.includes("refs/pull/9/head:refs/remotes/origin/review-head"))).toBe(true);
    expect(outcomeText(outcome).split("\n")[0]).toBe(
      `${PR_URL}: CI green, review complete, 0 unresolved threads, another pass required`,
    );
  });

  it("stops fixing CI after the per-head cap of rounds, and reports it red", async () => {
    world.stuckRed = true;
    const outcome = await improvePr(world.ports(), PR_URL);
    expect(outcome).toMatchObject({ ciStatus: "red", requiresAnotherPass: true });
    expect(world.asks.filter((ask) => ask.includes("CI failures"))).toHaveLength(PR_BUDGET.perKey);
  });

  it("makes no CI fix when earlier runs already spent the pull request's lifetime budget", async () => {
    world.stuckRed = true;
    await world.ledger.charge(PR_URL, PR_BUDGET.costUsd - PR_BUDGET.reserveUsd + 0.5);
    const outcome = await improvePr(world.ports(), PR_URL);
    expect(outcome.ciStatus).toBe("red");
    expect(world.asks.filter((ask) => ask.includes("CI failures"))).toEqual([]);
  });

  it("charges each CI fix round to the pull request's ledger", async () => {
    await improvePr(world.ports(), PR_URL);
    expect(await world.ledger.spent(PR_URL)).toBe(PR_BUDGET.reserveUsd);
  });

  it("fails without spending a code change when OpenCodeReview cannot run", async () => {
    world.ocrBroken = true;
    await expect(improvePr(world.ports(), PR_URL)).rejects.toThrow(/ocr/);
    expect(world.asks).toEqual([]);
  });

  it("refuses a pull request that is not open before anything else runs", async () => {
    const closed = world.ports();
    const inner = closed.run;
    closed.run = async (program, args, options) => {
      const result = await inner(program, args, options);
      return args.includes("url,title,body,baseRefName,baseRefOid,headRefOid,state")
        ? ok(result.stdout.replace("OPEN", "MERGED"))
        : result;
    };
    await expect(improvePr(closed, PR_URL)).rejects.toThrow(/not open/);
    expect(world.asks).toEqual([]);
  });

  it("refuses findings when the head moved between the review and the fix", async () => {
    const ports = world.ports();
    const inner = ports.run;
    ports.run = async (program, args, options) => {
      // The CI read that guards the fix step reports a head the review never saw.
      if (program === "gh" && args.includes("headRefOid,statusCheckRollup")) {
        return ok(JSON.stringify({ headRefOid: sha(9), statusCheckRollup: [] }));
      }
      return inner(program, args, options);
    };
    await expect(improvePr(ports, PR_URL)).rejects.toThrow(/head changed after review/);
    expect(world.asks).toEqual([]);
  });
});
