import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpendLedger } from "./budget.js";
import { checkoutRoot } from "./checkout.js";
import { fixRedCi, outputText, toOutput } from "./fix.js";
import { applyUniqueEdits, commitSubject, fixOneRound, fixPrompt, validateReply } from "./fix_round.js";
import factory from "./index.js";
import { ompModelStep } from "./omp_model.js";
import type { PrPorts } from "./ports.js";

const sha = (digit: string | number): string => String(digit).repeat(40);
const PR_URL = "https://github.com/acme/widgets/pull/7";
const REPO = "acme/widgets";
const T0 = Date.parse("2026-03-01T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const FAILING = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const PASSING = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];

class MemoryLedger implements SpendLedger {
  readonly totals = new Map<string, number>();
  spent = async (owner: string): Promise<number> => this.totals.get(owner) ?? 0;
  charge = async (owner: string, usd: number): Promise<number> => {
    const total = (this.totals.get(owner) ?? 0) + usd;
    this.totals.set(owner, total);
    return total;
  };
}

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fix-red-ci-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * GitHub, git, the model and the clock as one deterministic world. The checkout is a real temporary directory, so edits
 * hit a real filesystem; `gh` and `git` answer what the real read and push paths ask; sleeping advances the clock.
 */
class World {
  clock = T0;
  ghCalls: string[] = [];
  gitCalls: string[] = [];
  prompts: string[] = [];
  progress: string[] = [];
  readonly ledger = new MemoryLedger();
  state = "OPEN";
  head = sha(1);
  headPushedMs = T0 - 3_600_000;
  mergeState = "CLEAN";
  checks: unknown[] = FAILING;
  localHead = sha(1);
  log = [sha(1)];
  nextSha = 2;
  pushRefusal: string | undefined;
  /** Whether a successful push turns CI green. */
  pushFixes = true;
  files = new Map<string, string>([["src/a.ts", "export const value = 1;\n"]]);
  /** The model's replies, in order; the last repeats. */
  replies: string[] = [];
  private repliesGiven = 0;
  dir = "";

  async init(): Promise<this> {
    this.dir = await tempDir();
    return this;
  }

  private graphql(query: string): unknown {
    const wrap = (connection: string) => ({
      data: { repository: { pullRequest: { [connection]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } },
    });
    if (query.includes("PrThreads")) return wrap("reviewThreads");
    if (query.includes("PrComments")) return wrap("comments");
    return wrap("reviews");
  }

  gh = async (args: readonly string[]): Promise<string> => {
    const line = args.join(" ");
    this.ghCalls.push(line.replace(/query=[\s\S]*?(?= -f| -F|$)/, "query=…"));
    if (args[0] === "pr" && args[1] === "view") {
      if (args.at(-1) === "headRefOid") return JSON.stringify({ headRefOid: this.head });
      return JSON.stringify({
        url: PR_URL,
        state: this.state,
        isDraft: false,
        baseRefName: "main",
        headRefName: "fix/x",
        headRefOid: this.head,
        isCrossRepository: false,
        headRepository: null,
        headRepositoryOwner: { login: "acme" },
        reviewDecision: null,
        mergeStateStatus: this.mergeState,
        author: { login: "alice" },
        statusCheckRollup: this.checks,
      });
    }
    if (args[0] === "pr" && args[1] === "checks") {
      return JSON.stringify([{ name: "ci", link: "https://github.com/acme/widgets/actions/runs/99/job/1" }]);
    }
    if (args[0] === "run" && args[1] === "view") return "LOG-FROM-RUN: expected 2 but got 1";
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "zach" });
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify(this.graphql(args.find((arg) => arg.startsWith("query=")) ?? ""));
    }
    if (args[0] === "api" && args[1] === `repos/${REPO}`) return JSON.stringify({ permissions: { push: true, admin: false } });
    if (args[0] === "api" && args[1]?.endsWith("/check-suites")) {
      return JSON.stringify({ check_suites: [{ created_at: iso(this.headPushedMs) }] });
    }
    if (args[0] === "api" && args[1]?.includes("/compare/")) {
      const [from, to] = args[1].split("/compare/")[1]!.split("...");
      const fromAt = this.log.indexOf(from!);
      const toAt = this.log.indexOf(to!);
      return JSON.stringify({ status: from === to ? "identical" : fromAt !== -1 && toAt > fromAt ? "ahead" : "diverged" });
    }
    if (args[0] === "api" && args[1]?.startsWith(`repos/${REPO}/commits/`)) {
      return JSON.stringify({ commit: { committer: { date: iso(this.headPushedMs - 1000) } } });
    }
    throw new Error(`unexpected gh call: ${line}`);
  };

  git = async (args: readonly string[], _cwd: string): Promise<string> => {
    const line = args.join(" ");
    this.gitCalls.push(line);
    if (line === "rev-parse HEAD") return `${this.localHead}\n`;
    if (args[0] === "add") return "";
    if (args[0] === "commit") {
      const next = sha(this.nextSha++);
      this.localHead = next;
      this.log.push(next);
      return "";
    }
    if (args[0] === "rev-list") {
      const from = args[3]!.split("..")[0]!;
      const at = this.log.indexOf(from);
      return `${at === -1 ? 0 : this.log.length - 1 - at}\n`;
    }
    if (args[0] === "push") {
      if (this.pushRefusal !== undefined) throw new Error(`Command failed: git push\n${this.pushRefusal}`);
      this.head = this.localHead;
      this.headPushedMs = this.clock;
      if (this.pushFixes) {
        this.checks = PASSING;
      }
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
        for (const [path, text] of this.files) {
          await mkdir(join(this.dir, path, ".."), { recursive: true });
          await writeFile(join(this.dir, path), text);
        }
        return this.dir;
      },
      model: async (prompt) => {
        this.prompts.push(prompt);
        const reply = this.replies[Math.min(this.repliesGiven, this.replies.length - 1)];
        this.repliesGiven += 1;
        if (reply === undefined) throw new Error("the fake model has no reply");
        return reply;
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

const reply = (edits: { path: string; old: string; new: string }[], summary = "bump value to 2"): string =>
  JSON.stringify({ can_fix: true, summary, edits });
const FIX = reply([{ path: "src/a.ts", old: "value = 1", new: "value = 2" }]);
const CHECK = { check: "ci", log: "expected 2 but got 1 in src/a.ts" };

describe("validateReply", () => {
  const good = { can_fix: true, summary: "s", edits: [{ path: "a.ts", old: "x", new: "y" }] };

  it("accepts a well-formed fix and normalizes a can_fix false reply to no edits", () => {
    expect(validateReply(good)).toEqual(good);
    expect(validateReply({ can_fix: false, summary: "outside", edits: [{ path: "/etc/x", old: "a", new: "b" }] })).toEqual({
      can_fix: false,
      summary: "outside",
      edits: [],
    });
  });

  it("refuses every malformed reply with a reason the model can act on", () => {
    expect(() => validateReply("x")).toThrow("expected an object");
    expect(() => validateReply({ ...good, can_fix: "yes" })).toThrow("can_fix");
    expect(() => validateReply({ ...good, summary: "  " })).toThrow("say what you changed");
    expect(() => validateReply({ ...good, edits: [] })).toThrow("exact text");
    expect(() => validateReply({ ...good, edits: [{ path: "a.ts", old: "", new: "y" }] })).toThrow("needs the text");
    expect(() => validateReply({ ...good, edits: [{ path: "a.ts", old: "x" }] })).toThrow("edits[0].new");
  });

  it("refuses paths that leave the worktree or touch .git, but not a name that merely contains two dots", () => {
    for (const path of ["/etc/passwd", "../x.ts", "a/../../x.ts", "a\\..\\x.ts", ".git/config", "sub/.git/hooks/pre-push", "C:\\x", ""]) {
      expect(() => validateReply({ ...good, edits: [{ path, old: "x", new: "y" }] })).toThrow("refuse path");
    }
    expect(() => validateReply({ ...good, edits: [{ path: "docs/a..b.md", old: "x", new: "y" }] })).not.toThrow();
  });

  it("never lets a test be weakened to go green", () => {
    const weakened = { ...good, edits: [{ path: "a.test.ts", old: "expect(a).toBe(2);", new: "// ok" }] };
    expect(() => validateReply(weakened)).toThrow("do not weaken a test");
    const kept = { ...good, edits: [{ path: "a.test.ts", old: "expect(a).toBe(2);", new: "expect(a).toBe(3);" }] };
    expect(() => validateReply(kept)).not.toThrow();
  });
});

describe("applyUniqueEdits", () => {
  it("replaces each old text once", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.ts"), "one two three");
    expect(await applyUniqueEdits(dir, [{ path: "a.ts", old: "two", new: "2" }])).toEqual(["a.ts"]);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("one 2 three");
  });

  it("FIXED: replacement text is literal, never a `$&`, `$1` or `$$` replacement pattern", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.ts"), "const price = 1;");
    await applyUniqueEdits(dir, [{ path: "a.ts", old: "1", new: "`$&-$1-$$-${x}`" }]);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("const price = `$&-$1-$$-${x}`;");
  });

  it("FIXED: writes nothing when any edit fails, and applies several edits to one file in order", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.ts"), "alpha beta");
    await writeFile(join(dir, "b.ts"), "same same");
    await expect(
      applyUniqueEdits(dir, [
        { path: "a.ts", old: "alpha", new: "ALPHA" },
        { path: "b.ts", old: "same", new: "x" },
      ]),
    ).rejects.toThrow("b.ts: expected one match, found 2");
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("alpha beta");
    await applyUniqueEdits(dir, [
      { path: "a.ts", old: "alpha", new: "ALPHA" },
      { path: "a.ts", old: "beta", new: "BETA" },
    ]);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("ALPHA BETA");
  });

  it("refuses a missing file and an old text that is not there", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.ts"), "x");
    await expect(applyUniqueEdits(dir, [{ path: "nope.ts", old: "x", new: "y" }])).rejects.toThrow("missing nope.ts");
    await expect(applyUniqueEdits(dir, [{ path: "a.ts", old: "zzz", new: "y" }])).rejects.toThrow("found 0");
  });

  it("FIXED: refuses a file that resolves outside the worktree through a symlink", async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(dir, "link.txt"));
    await expect(applyUniqueEdits(dir, [{ path: "link.txt", old: "secret", new: "x" }])).rejects.toThrow(
      "resolves outside the worktree",
    );
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("refuses an absolute or `..` path even when called directly", async () => {
    const dir = await tempDir();
    await expect(applyUniqueEdits(dir, [{ path: "../x", old: "a", new: "b" }])).rejects.toThrow("refuse path");
    await expect(applyUniqueEdits(dir, [{ path: "/tmp/x", old: "a", new: "b" }])).rejects.toThrow("refuse path");
  });
});

describe("commitSubject, fixPrompt", () => {
  it("caps the subject and keeps only the summary's first line", () => {
    expect(commitSubject("bump value\nmore detail")).toBe("fix(ci): bump value");
    const long = commitSubject("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });

  it("carries the log, the earlier attempt and the reply schema", () => {
    const prompt = fixPrompt(PR_URL, "check: ci\n\nboom", "it did a thing");
    expect(prompt).toContain("Never weaken a test");
    expect(prompt).toContain(`url: ${PR_URL}`);
    expect(prompt).toContain("An earlier attempt on this pull request: it did a thing");
    expect(prompt).toContain('"required":["can_fix","summary","edits"]');
    expect(fixPrompt(PR_URL, "x", "")).not.toContain("An earlier attempt");
  });
});

describe("fixOneRound", () => {
  const facts = (head = sha(1)) => ({
    prUrl: PR_URL,
    repo: REPO,
    number: 7,
    baseRef: "main",
    state: "OPEN" as const,
    isDraft: false,
    headRef: "fix/x",
    headSha: head,
    headPushedAt: iso(T0),
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
    checks: { verdict: "red" as const, failed: ["ci"], pending: [] },
  });
  const input = (number = 1, head = sha(1)) => ({ facts: facts(head), check: CHECK, issues: [], number, earlier: "" });

  it("a reply that cannot fix touches no checkout", async () => {
    const world = await new World().init();
    world.replies = [JSON.stringify({ can_fix: false, summary: "missing token in a platform job", edits: [] })];
    const ports = { ...world.ports(), checkout: async () => { throw new Error("must not check out"); } };
    const result = await fixOneRound(ports, input());
    expect(result).toMatchObject({ impossible: true, summary: "missing token in a platform job", attempt: null });
  });

  it("applies and commits, then asks again with the reason when a reply is invalid", async () => {
    const world = await new World().init();
    world.replies = ["not json at all", FIX];
    const result = await fixOneRound(world.ports(), input());
    expect(result.attempt).toMatchObject({ commits: 1, problem: "", fromSha: sha(1), role: "@task" });
    expect(result.changed).toEqual(["src/a.ts"]);
    expect(await readFile(join(world.dir, "src/a.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(world.prompts).toHaveLength(2);
    expect(world.prompts[1]).toContain("Your previous reply was rejected");
    expect(world.gitCalls).toContain("add -- src/a.ts");
    expect(world.gitCalls).toContain("commit -m fix(ci): bump value to 2");
  });

  it("an edit that does not apply is a problem on the attempt, not a throw", async () => {
    const world = await new World().init();
    world.replies = [reply([{ path: "src/a.ts", old: "no such text", new: "x" }])];
    const result = await fixOneRound(world.ports(), input());
    expect(result.attempt?.problem).toContain("the edits could not be applied: src/a.ts: expected one match, found 0");
    expect(world.gitCalls.some((call) => call.startsWith("commit"))).toBe(false);
  });

  it("a commit that fails (a hook) is a problem on the attempt", async () => {
    const world = await new World().init();
    world.replies = [FIX];
    const ports = world.ports();
    const result = await fixOneRound(
      { ...ports, git: async (args, cwd) => (args[0] === "commit" ? Promise.reject(new Error("pre-commit failed\nlint")) : ports.git(args, cwd)) },
      input(),
    );
    expect(result.attempt?.problem).toBe("the commit failed: pre-commit failed");
  });

  it("refuses to edit a head that moved since it was judged", async () => {
    const world = await new World().init();
    world.replies = [FIX];
    const result = await fixOneRound(world.ports(), input(1, sha(9)));
    expect(result.attempt?.problem).toContain("the head moved since it was judged");
  });

  it("later rounds describe what is still open with each red check's failed log", async () => {
    const world = await new World().init();
    world.replies = [FIX];
    await fixOneRound(world.ports(), {
      ...input(2),
      issues: [
        { kind: "failed-check", name: "ci" },
        { kind: "thread", id: "T", path: "a.ts", author: "bob", body: "rename" },
        { kind: "push-refused", output: "hook said no" },
      ],
      earlier: "last time: bumped it",
    });
    const prompt = world.prompts[0]!;
    expect(prompt).toContain("check ci is red:\nLOG-FROM-RUN: expected 2 but got 1");
    expect(prompt).toContain("review thread by bob on a.ts: rename");
    expect(prompt).toContain("the last push was refused: hook said no");
    expect(prompt).toContain("An earlier attempt on this pull request: last time: bumped it");
    expect(prompt).not.toContain(CHECK.log);
    expect(world.ghCalls).toContain("pr checks 7 --repo acme/widgets --json name,link");
  });
});

describe("fixRedCi", () => {
  it("a red check, one model fix, one push, green: done with the changed files", async () => {
    const world = await new World().init();
    world.replies = [FIX];
    const state = await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK });
    const output = toOutput(state);
    expect(output).toEqual({
      summary: "bump value to 2",
      green: true,
      changed: ["src/a.ts"],
      status: "done",
      rounds: 1,
      reasons: [],
    });
    expect(world.prompts[0]).toContain(CHECK.log);
    expect(world.gitCalls.filter((call) => call.startsWith("push"))).toEqual(["push origin HEAD:refs/heads/fix/x"]);
    expect(world.ledger.totals.get(PR_URL)).toBe(2);
    expect(outputText(PR_URL, output)).toContain("done (mergeable), 1 round");
  });

  it("an already settled pull request ends done with no model call and no round", async () => {
    const world = await new World().init();
    world.checks = PASSING;
    const output = toOutput(await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }));
    expect(output).toMatchObject({ green: true, status: "done", rounds: 0, summary: "The pull request is mergeable." });
    expect(world.prompts).toEqual([]);
    expect(world.ledger.totals.size).toBe(0);
  });

  it("an already merged pull request is done, never a round", async () => {
    const world = await new World().init();
    world.state = "MERGED";
    const output = toOutput(await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }));
    expect(output).toMatchObject({ green: true, status: "done", rounds: 0, summary: "The pull request is already merged." });
  });

  it("a closed pull request is impossible, and names why", async () => {
    const world = await new World().init();
    world.state = "CLOSED";
    const output = toOutput(await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }));
    expect(output).toMatchObject({ green: false, status: "impossible", rounds: 0 });
    expect(output.reasons).toContain("the pull request is closed");
  });

  it("a failure outside the repository ends impossible with the model's summary and pushes nothing", async () => {
    const world = await new World().init();
    world.replies = [JSON.stringify({ can_fix: false, summary: "needs a token this repo does not own", edits: [] })];
    const output = toOutput(await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }));
    expect(output).toEqual({
      summary: "needs a token this repo does not own",
      green: false,
      changed: [],
      status: "impossible",
      rounds: 1,
      reasons: ["needs a token this repo does not own"],
    });
    expect(world.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
  });

  it("a refused push becomes the next round's issue, and the run still finishes", async () => {
    const world = await new World().init();
    world.replies = [FIX, reply([{ path: "src/a.ts", old: "value = 1", new: "value = 2" }], "retry for the hook")];
    world.pushRefusal = "pre-push: pinact failed";
    const ports = world.ports();
    const originalGit = ports.git;
    let pushes = 0;
    ports.git = async (args, cwd) => {
      if (args[0] === "push") {
        pushes += 1;
        if (pushes === 2) world.pushRefusal = undefined;
      }
      return originalGit(args, cwd);
    };
    const output = toOutput(await fixRedCi(ports, { prUrl: PR_URL, check: CHECK }));
    expect(output).toMatchObject({ green: true, status: "done", rounds: 2, changed: ["src/a.ts"] });
    expect(world.prompts[1]).toContain("the last push was refused: ");
    expect(world.prompts[1]).toContain("pinact failed");
    expect(world.prompts[1]).toContain("Not pushed: push refused");
  });

  it("stops spent after three rounds on the same head, naming the limit", async () => {
    const world = await new World().init();
    world.pushFixes = false;
    // every round fails to apply (the checkout is reset to value = 1 each time but the model edits text that is not there)
    world.replies = [reply([{ path: "src/a.ts", old: "missing", new: "x" }])];
    const output = toOutput(await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }));
    expect(output.status).toBe("spent");
    expect(output.green).toBe(false);
    expect(output.rounds).toBe(3);
    expect(output.reasons.join("\n")).toContain("3 rounds already started on");
    expect(output.reasons.join("\n")).toContain("round 1 failed: the edits could not be applied");
  });

  it("stops spent when the lifetime spend has no headroom for a round", async () => {
    const world = await new World().init();
    await world.ledger.charge(PR_URL, 24);
    world.replies = [FIX];
    const output = toOutput(await fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }));
    expect(output).toMatchObject({ status: "spent", rounds: 0 });
    expect(output.reasons.join("\n")).toContain("exceeds the $25 ceiling");
    expect(world.prompts).toEqual([]);
  });

  it("charges a round that threw, and lets the error through", async () => {
    const world = await new World().init();
    world.replies = [];
    await expect(fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK })).rejects.toThrow("the fake model has no reply");
    expect(world.ledger.totals.get(PR_URL)).toBe(2);
  });

  it("stops at once when the run is cancelled", async () => {
    const world = await new World().init();
    const controller = new AbortController();
    controller.abort();
    await expect(fixRedCi(world.ports(), { prUrl: PR_URL, check: CHECK }, controller.signal)).rejects.toThrow();
    expect(world.prompts).toEqual([]);
  });
});

describe("live pieces", () => {
  it("the bare model step runs omp -p with the role and every tool off, in a private directory", async () => {
    const calls: { command: string; args: string[]; cwd?: string }[] = [];
    const step = ompModelStep(async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { stdout: "  reply  ", stderr: "", code: 0, killed: false };
    }, { model: "@task" });
    expect(await step("hello")).toBe("reply");
    expect(calls[0]!.command).toBe("omp");
    expect(calls[0]!.args.slice(0, 1)).toEqual(["-p"]);
    expect(calls[0]!.args).toContain("--no-tools");
    expect(calls[0]!.args.slice(args2(calls[0]!.args, "--model"), args2(calls[0]!.args, "--model") + 2)).toEqual(["--model", "@task"]);
    expect(calls[0]!.cwd).not.toBe(process.cwd());
  });

  it("the checkout has its own directory, apart from make_pr_mergable's", () => {
    expect(checkoutRoot("darwin", {}, "/home/z")).toBe("/home/z/Library/Caches/fix-red-ci");
    expect(checkoutRoot("linux", { XDG_CACHE_HOME: "/xdg" }, "/home/z")).toBe("/xdg/fix-red-ci");
    expect(checkoutRoot("linux", {}, "/home/z")).toBe("/home/z/.cache/fix-red-ci");
  });
});

function args2(args: string[], flag: string): number {
  return args.indexOf(flag);
}

/** A chainable stand-in for `pi.zod`: every method returns the same proxy. */
function fakeZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}
interface BuiltTool {
  name: string;
  description: string;
  loadMode?: unknown;
  execute(id: string, params: unknown, onUpdate?: unknown, ctx?: unknown, signal?: AbortSignal): Promise<unknown>;
}

describe("tool object", () => {
  const build = (): BuiltTool => (factory as unknown as (pi: unknown) => BuiltTool)({ zod: fakeZod() });

  it("is named and discoverable, with a description in range", () => {
    const tool = build();
    expect(tool.name).toBe("fix_red_ci");
    expect(tool.loadMode).toBeUndefined();
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(400);
  });

  it("rejects a look-alike pull request URL by throwing, before any call", async () => {
    await expect(
      build().execute("id", { url: "https://github.com.evil.example/acme/widgets/pull/7", check: CHECK }),
    ).rejects.toThrow();
  });
});
