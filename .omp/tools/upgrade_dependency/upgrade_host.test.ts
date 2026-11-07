import { describe, expect, it } from "bun:test";
import type { ProcessResult } from "./lib/host_machine.js";
import { ISSUE_BODY_CAP, PUSH_HOOK_BUDGET_MS, PUSH_VISIBLE_BUDGET_MS, SETTLE_POLL_MS } from "./loop/constants.js";
import type { RunOptions, Runner, RunResult } from "./loop/exec.js";
import {
  createUpgradeHost,
  type HostRun,
  liveUpgradeHost,
  runThrough,
  type UpgradeHost,
  type UpgradeHostOptions,
} from "./upgrade_host.js";

const PR = "https://github.com/acme/widgets/pull/7";
const DIR = "/work/acme-widgets-7";
const PUSH = "git push origin HEAD:refs/heads/fix/widget";
const sha = (digit: string | number): string => String(digit).repeat(40);
const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string, code = 1): ProcessResult => ({ code, stdout: "", stderr });

interface Call {
  readonly cwd: string;
  readonly line: string;
  readonly env: Readonly<Record<string, string>> | undefined;
}

/**
 * One pull request, its checkout directory, GitHub and the clock as a deterministic world. `run` and `gh` answer what
 * the host asks and record it; a command that is not scripted to fail succeeds with no output.
 */
class World {
  readonly repo: string;
  readonly number: number;
  runs: Call[] = [];
  ghCalls: string[] = [];
  checkouts: string[] = [];
  checkoutFailure: string | undefined;
  /** Absolute paths that are files in the checkout. */
  files = new Set<string>();
  /** The result of a command line, when it is not a plain success. */
  results = new Map<string, ProcessResult>();
  /** The file a successful command line writes. */
  creates = new Map<string, string>();
  /** Lockfiles `git status` reports as modified. */
  modified = new Set<string>();
  /** Programs that are not installed. */
  missing = new Set<string>();
  /** `gh` calls that fail: a prefix of the call line and the message. */
  ghFailures = new Map<string, string>();
  localHead = sha(1);
  githubHead = sha(1);
  previousHead = sha(1);
  /** How many head reads after a push still answer the head from before it. */
  lagReads = 0;
  /** The head GitHub reports after a push, when a bot committed on top of it. */
  visibleAs: string | undefined;
  ahead = new Set<string>();
  canPush = true;
  viewer = "zach";
  view: Record<string, unknown> = {
    state: "OPEN",
    headRefName: "fix/widget",
    isCrossRepository: false,
    headRepository: null,
    headRepositoryOwner: { login: "acme" },
    author: { login: "renovate" },
  };
  titleBody: Record<string, unknown> = { title: "", body: "" };
  filesJson = "[]";
  mergeOutput = "will be automatically merged when requirements are met\n";
  clock = 1_000_000;
  sleeps: number[] = [];

  constructor(readonly url = PR, readonly dir = DIR, readonly headRef = "fix/widget") {
    const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)!;
    this.repo = match[1]!;
    this.number = Number(match[2]);
    this.view = { ...this.view, headRefName: headRef };
  }

  file(path: string): this {
    this.files.add(`${this.dir}/${path}`);
    return this;
  }

  lines(): string[] {
    return this.runs.map((call) => call.line);
  }

  run: HostRun = async (cwd, program, args, env) => {
    const line = [program, ...args].join(" ");
    this.runs.push({ cwd, line, env });
    if (this.missing.has(program)) return failed(`${program} failed to start: spawn ${program} ENOENT`, -1);
    const scripted = this.results.get(line);
    if (scripted !== undefined && scripted.code !== 0) return scripted;
    if (line === "git rev-parse HEAD") return ok(`${this.localHead}\n`);
    if (line.startsWith("git status --porcelain -- ")) {
      const path = line.slice("git status --porcelain -- ".length);
      return ok(this.modified.has(path) ? ` M ${path}\n` : "");
    }
    if (line.startsWith("git commit -m ")) {
      this.localHead = sha(Number(this.localHead[0]) + 1);
      return ok("");
    }
    if (line.startsWith("git push ")) {
      this.previousHead = this.githubHead;
      this.githubHead = this.visibleAs ?? this.localHead;
      if (this.visibleAs !== undefined) this.ahead.add(this.visibleAs);
      return ok("");
    }
    const created = this.creates.get(line);
    if (created !== undefined) this.files.add(created);
    return scripted ?? ok("");
  };

  private reportedHead(): string {
    if (this.lagReads > 0) {
      this.lagReads -= 1;
      return this.previousHead;
    }
    return this.githubHead;
  }

  gh = async (args: readonly string[]): Promise<string> => {
    const line = args.join(" ");
    this.ghCalls.push(line);
    for (const [prefix, message] of this.ghFailures) {
      if (line.startsWith(prefix)) throw new Error(message);
    }
    const view = `pr view ${this.number} --repo ${this.repo} --json`;
    if (line.startsWith(`${view} state,`)) return JSON.stringify(this.view);
    if (line === `${view} headRefOid --jq .headRefOid`) return `${this.reportedHead()}\n`;
    if (line === `${view} title,body`) return JSON.stringify(this.titleBody);
    if (line.startsWith(`api repos/${this.repo} --jq `)) return `${this.canPush}\n`;
    if (line === "api user --jq .login") return `${this.viewer}\n`;
    if (line.startsWith(`api repos/${this.repo}/compare/`)) {
      const head = line.slice(line.lastIndexOf("...") + 3);
      return JSON.stringify({ status: this.ahead.has(head) ? "ahead" : "behind" });
    }
    if (line === `api repos/${this.repo}/pulls/${this.number}/files --paginate`) return this.filesJson;
    if (line.startsWith("pr merge ")) return this.mergeOutput;
    if (line.startsWith("label create ") || line.startsWith("pr edit ")) return "";
    throw new Error(`unexpected gh call: ${line}`);
  };

  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.clock += ms;
  };

  host(extra: Partial<UpgradeHostOptions> = {}): UpgradeHost {
    return createUpgradeHost({
      prUrl: this.url,
      checkout: async (url) => {
        this.checkouts.push(url);
        if (this.checkoutFailure !== undefined) throw new Error(this.checkoutFailure);
        return this.dir;
      },
      run: this.run,
      gh: this.gh,
      isFile: async (path) => this.files.has(path),
      sleep: this.sleep,
      now: () => this.clock,
      ...extra,
    });
  }
}

/** A `Runner` that answers from `handler` and records each call; an `Error` it returns is thrown. */
function fakeRunner(handler: (command: string, args: readonly string[], options: RunOptions) => RunResult | Error): {
  runner: Runner;
  calls: { command: string; args: readonly string[]; options: RunOptions }[];
} {
  const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
  const runner: Runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const answer = handler(command, args, options);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runner, calls };
}

const done = (stdout = "", code = 0, stderr = ""): RunResult => ({ code, stdout, stderr, killed: false });

describe("settleLockfiles", () => {
  it("passes a go directive bump whose go.sum tidy leaves unchanged, and finds no lockfile for a mise.toml", async () => {
    const world = new World().file("go.sum");
    const state = await world.host().settleLockfiles(["go.mod", "mise.toml"], []);
    expect(state).toEqual({
      head: sha(1),
      statuses: [
        { state: "unchanged", lockfile: "go.sum", via: "go mod tidy" },
        { state: "absent", manifest: "mise.toml", lockfiles: ["mise.lock"] },
      ],
    });
    expect(world.lines()).toEqual([`go -C ${DIR} mod tidy`, "git status --porcelain -- go.sum", "git rev-parse HEAD"]);
    expect(world.runs[0]).toMatchObject({ cwd: DIR, env: { CI: "true" } });
    expect(world.ghCalls).toEqual([]);
  });

  it("takes a clean checkout of the pull request, and the commit it settled is the head it reports", async () => {
    const world = new World().file("go.sum");
    world.localHead = sha(4);
    const state = await world.host().settleLockfiles(["go.mod"], []);
    expect(world.checkouts).toEqual([PR]);
    expect(state.head).toBe(sha(4));
  });

  it("rewrites a stale go.sum in the module directory, commits only it, and pushes the head branch", async () => {
    const world = new World().file("api/go.sum");
    world.modified.add("api/go.sum");
    const state = await world.host().settleLockfiles(["api/go.mod"], []);
    expect(world.lines()).toEqual([
      `go -C ${DIR}/api mod tidy`,
      "git status --porcelain -- api/go.sum",
      "git add -- api/go.sum",
      "git commit -m chore(deps): refresh api/go.sum",
      PUSH,
      "git rev-parse HEAD",
      "git rev-parse HEAD",
    ]);
    expect(state).toEqual({
      head: sha(2),
      statuses: [{ state: "rewritten", lockfile: "api/go.sum", via: "go mod tidy" }],
    });
    expect(world.ghCalls).toHaveLength(3);
    expect(world.ghCalls[0]).toContain("headRefName");
    expect(world.ghCalls[2]).toBe("pr view 7 --repo acme/widgets --json headRefOid --jq .headRefOid");
  });

  it("rewrites an existing mise.lock with mise lock", async () => {
    const world = new World().file("mise.lock");
    world.modified.add("mise.lock");
    const state = await world.host().settleLockfiles(["mise.toml"], []);
    expect(world.lines()).toContain(`mise --cd ${DIR} --yes lock`);
    expect(world.lines()).toContain("git commit -m chore(deps): refresh mise.lock");
    expect(state.statuses).toEqual([{ state: "rewritten", lockfile: "mise.lock", via: "mise lock" }]);
  });

  it.each(
    [
      ["aube-lock.yaml", "aube", ["-C", DIR, "install", "--lockfile-only", "--ignore-scripts"], "aube install"],
      ["pnpm-lock.yaml", "pnpm", ["-C", DIR, "install", "--lockfile-only", "--ignore-scripts"], "pnpm install"],
      ["package-lock.json", "npm", ["--prefix", DIR, "install", "--package-lock-only", "--ignore-scripts"], "npm install"],
    ] as const,
  )("settles a package.json's %s with its own tool, leaving it alone when the bump touched nothing it locks", async (
    lockfile,
    program,
    args,
    label,
  ) => {
    const world = new World().file(lockfile);
    const state = await world.host().settleLockfiles(["package.json"], []);
    expect(world.lines()[0]).toBe([program, ...args].join(" "));
    expect(world.runs[0]).toMatchObject({ cwd: DIR, env: { CI: "true" } });
    expect(state.statuses).toEqual([{ state: "unchanged", lockfile, via: label }]);
    expect(world.lines().some((line) => line.startsWith("git add") || line.startsWith("git push"))).toBe(false);
  });

  it("uses the first lockfile a manifest's rule names that is present", async () => {
    const world = new World().file("package-lock.json").file("aube-lock.yaml");
    const state = await world.host().settleLockfiles(["package.json"], []);
    expect(state.statuses).toEqual([{ state: "unchanged", lockfile: "aube-lock.yaml", via: "aube install" }]);
    expect(world.lines().filter((line) => line.includes("install"))).toHaveLength(1);
  });

  it("takes a workspace root's lockfile for a package.json below it, and the nearest one when a package has its own", async () => {
    const root = new World().file("pnpm-lock.yaml");
    const fromRoot = await root.host().settleLockfiles(["packages/app/package.json"], []);
    expect(fromRoot.statuses).toEqual([{ state: "unchanged", lockfile: "pnpm-lock.yaml", via: "pnpm install" }]);
    expect(root.lines()[0]).toBe(`pnpm -C ${DIR} install --lockfile-only --ignore-scripts`);

    const nested = new World().file("pnpm-lock.yaml").file("packages/app/pnpm-lock.yaml");
    const fromNearest = await nested.host().settleLockfiles(["packages/app/package.json"], []);
    expect(fromNearest.statuses).toEqual([
      { state: "unchanged", lockfile: "packages/app/pnpm-lock.yaml", via: "pnpm install" },
    ]);
    expect(nested.lines()[0]).toBe(`pnpm -C ${DIR}/packages/app install --lockfile-only --ignore-scripts`);
  });

  it("does not take a parent directory's go.sum for a go.mod, and finds none when tidy writes none", async () => {
    const world = new World().file("go.sum");
    const state = await world.host().settleLockfiles(["api/go.mod"], []);
    expect(world.lines()[0]).toBe(`go -C ${DIR}/api mod tidy`);
    expect(state.statuses).toEqual([{ state: "absent", manifest: "api/go.mod", lockfiles: ["go.sum"] }]);
  });

  it("commits a go.sum that tidy creates", async () => {
    const world = new World();
    world.creates.set(`go -C ${DIR} mod tidy`, `${DIR}/go.sum`);
    world.modified.add("go.sum");
    const state = await world.host().settleLockfiles(["go.mod"], []);
    expect(state.statuses).toEqual([{ state: "rewritten", lockfile: "go.sum", via: "go mod tidy" }]);
    expect(world.lines()).toContain("git commit -m chore(deps): refresh go.sum");
  });

  it("counts a lockfile the pull request already carries as in the pull request, and runs nothing for it", async () => {
    const world = new World();
    const state = await world.host().settleLockfiles(["package.json"], ["package-lock.json"]);
    expect(state.statuses).toEqual([{ state: "in_pull_request", lockfile: "package-lock.json" }]);
    expect(world.lines()).toEqual(["git rev-parse HEAD"]);
  });

  it("settles a lockfile shared by two manifests once", async () => {
    const world = new World().file("pnpm-lock.yaml");
    const state = await world.host().settleLockfiles(["a/package.json", "b/package.json"], []);
    expect(state.statuses).toEqual([{ state: "unchanged", lockfile: "pnpm-lock.yaml", via: "pnpm install" }]);
    expect(world.lines().filter((line) => line.startsWith("pnpm"))).toHaveLength(1);
  });

  it("reports a manifest with no installer as unsupported and one with no lockfile as absent, running nothing", async () => {
    const world = new World();
    const state = await world.host().settleLockfiles(["Cargo.toml", "package.json"], []);
    expect(state.statuses).toEqual([
      { state: "unsupported", manifest: "Cargo.toml" },
      { state: "absent", manifest: "package.json", lockfiles: ["aube-lock.yaml", "pnpm-lock.yaml", "package-lock.json"] },
    ]);
    expect(world.lines()).toEqual(["git rev-parse HEAD"]);
  });

  it("commits every rewritten lockfile in one commit, and a lockfile left alone is not in it", async () => {
    const world = new World().file("package-lock.json").file("go.sum").file("mise.lock");
    world.modified.add("package-lock.json").add("go.sum");
    const state = await world.host().settleLockfiles(["package.json", "go.mod", "mise.toml"], []);
    expect(world.lines()).toContain("git add -- package-lock.json go.sum");
    expect(world.lines()).toContain("git commit -m chore(deps): refresh package-lock.json, go.sum");
    expect(world.lines().filter((line) => line.startsWith("git push"))).toEqual([PUSH]);
    expect(state.statuses.map((status) => status.state)).toEqual(["rewritten", "rewritten", "unchanged"]);
  });

  describe("when a lockfile cannot be settled", () => {
    it("reports it stale with what the tool said, and commits and pushes nothing", async () => {
      const world = new World().file("go.sum");
      world.results.set(`go -C ${DIR} mod tidy`, failed("go: module not found"));
      const state = await world.host().settleLockfiles(["go.mod"], []);
      expect(state.statuses).toEqual([{ state: "stale", lockfile: "go.sum", reason: "go: module not found" }]);
      expect(world.lines().some((line) => line.startsWith("git add") || line.startsWith("git push"))).toBe(false);
      expect(world.ghCalls).toEqual([]);
    });

    it("names the install when it said nothing", async () => {
      const world = new World().file("mise.lock");
      world.results.set(`mise --cd ${DIR} --yes lock`, failed("", 2));
      const state = await world.host().settleLockfiles(["mise.toml"], []);
      expect(state.statuses).toEqual([{ state: "stale", lockfile: "mise.lock", reason: "mise lock failed" }]);
    });

    it("keeps the tail of a long failure, where the cause is", async () => {
      const world = new World().file("go.sum");
      world.results.set(`go -C ${DIR} mod tidy`, failed(`${"noise\n".repeat(5_000)}the real cause`));
      const state = await world.host().settleLockfiles(["go.mod"], []);
      const reason = (state.statuses[0] as { reason: string }).reason;
      expect(reason.length).toBeLessThanOrEqual(ISSUE_BODY_CAP);
      expect(reason.endsWith("the real cause")).toBe(true);
    });

    it("reports a tool that is not installed as stale, never as current", async () => {
      const world = new World().file("aube-lock.yaml");
      world.missing.add("aube");
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([
        { state: "stale", lockfile: "aube-lock.yaml", reason: "aube failed to start: spawn aube ENOENT" },
      ]);
      expect(world.lines().some((line) => line.startsWith("git add") || line.startsWith("git push"))).toBe(false);
    });

    it("reports a lockfile as stale when git cannot say whether the install changed it", async () => {
      const world = new World().file("go.sum");
      world.results.set("git status --porcelain -- go.sum", failed("fatal: not a git repository", 128));
      const state = await world.host().settleLockfiles(["go.mod"], []);
      expect(state.statuses).toEqual([
        {
          state: "stale",
          lockfile: "go.sum",
          reason: "could not tell whether go mod tidy changed it: fatal: not a git repository",
        },
      ]);
    });

    it("rejects when the checkout fails, instead of reporting statuses of a copy it could not take", async () => {
      const world = new World().file("go.sum");
      world.checkoutFailure = "checkout is not clean";
      await expect(world.host().settleLockfiles(["go.mod"], [])).rejects.toThrow("checkout is not clean");
      expect(world.runs).toEqual([]);
    });

    it("rejects when the working copy's HEAD cannot be read", async () => {
      const world = new World().file("go.sum");
      world.results.set("git rev-parse HEAD", failed("fatal: bad revision"));
      await expect(world.host().settleLockfiles(["go.mod"], [])).rejects.toThrow(
        "could not read the working copy's HEAD: fatal: bad revision",
      );
    });
  });

  describe("when a rewritten lockfile cannot be pushed", () => {
    function rewrittenWorld(): World {
      const world = new World().file("go.sum").file("package-lock.json");
      world.modified.add("package-lock.json");
      return world;
    }

    it("reports the pushed-refused lockfile as stale with git's output, and leaves the others as they were", async () => {
      const world = rewrittenWorld();
      world.results.set(PUSH, failed("pre-push hook failed: zizmor dangerous-triggers"));
      const state = await world.host().settleLockfiles(["go.mod", "package.json"], []);
      expect(state.statuses).toEqual([
        { state: "unchanged", lockfile: "go.sum", via: "go mod tidy" },
        {
          state: "stale",
          lockfile: "package-lock.json",
          reason: "rewritten but not pushed: pre-push hook failed: zizmor dangerous-triggers",
        },
      ]);
      expect(state.head).toBe(sha(2));
      expect(world.ghCalls.some((call) => call.includes("headRefOid"))).toBe(false);
    });

    it("reports the lockfile as stale when the commit is refused, and does not push", async () => {
      const world = rewrittenWorld();
      world.results.set("git commit -m chore(deps): refresh package-lock.json", failed("hook failed"));
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([
        { state: "stale", lockfile: "package-lock.json", reason: "rewritten but not pushed: hook failed" },
      ]);
      expect(world.lines().some((line) => line.startsWith("git push"))).toBe(false);
    });

    it("reports the lockfile as stale when it cannot be staged", async () => {
      const world = rewrittenWorld();
      world.results.set("git add -- package-lock.json", failed("fatal: pathspec did not match", 128));
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([
        {
          state: "stale",
          lockfile: "package-lock.json",
          reason: "rewritten but not pushed: fatal: pathspec did not match",
        },
      ]);
      expect(world.lines().some((line) => line.startsWith("git commit"))).toBe(false);
    });

    it("reports the lockfile as stale when where to push cannot be read, before committing", async () => {
      const world = rewrittenWorld();
      world.ghFailures.set("pr view 7 --repo acme/widgets --json state", "gh: HTTP 502");
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([
        {
          state: "stale",
          lockfile: "package-lock.json",
          reason: "rewritten but not pushed: could not read where to push: gh: HTTP 502",
        },
      ]);
      expect(world.lines().some((line) => line.startsWith("git add"))).toBe(false);
    });

    it("rethrows a cancelled run instead of reporting the lockfile as stale", async () => {
      const world = rewrittenWorld();
      const controller = new AbortController();
      world.ghFailures.set("pr view 7 --repo acme/widgets --json state", "cancelled");
      controller.abort();
      await expect(world.host({ signal: controller.signal }).settleLockfiles(["package.json"], [])).rejects.toThrow(
        "cancelled",
      );
    });
  });

  describe("where a push goes", () => {
    function rewrittenWorld(): World {
      const world = new World().file("package-lock.json");
      world.modified.add("package-lock.json");
      return world;
    }
    const pushes = (world: World): string[] => world.lines().filter((line) => line.startsWith("git push"));
    const staleReason = (status: unknown): string => (status as { reason: string }).reason;

    it("pushes a branch of the base repository to origin, never forced and never past a hook", async () => {
      const world = rewrittenWorld();
      await world.host().settleLockfiles(["package.json"], []);
      expect(pushes(world)).toEqual([PUSH]);
    });

    it("refuses to push to a closed pull request, and commits nothing", async () => {
      const world = rewrittenWorld();
      world.view = { ...world.view, state: "CLOSED" };
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(staleReason(state.statuses[0])).toBe("rewritten but not pushed: the pull request is closed");
      expect(world.lines().some((line) => line.startsWith("git add"))).toBe(false);
    });

    it("refuses when the viewer has no push access to the repository", async () => {
      const world = rewrittenWorld();
      world.canPush = false;
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(staleReason(state.statuses[0])).toBe(
        "rewritten but not pushed: the viewer has no push access to acme/widgets",
      );
      expect(world.lines().some((line) => line.startsWith("git add"))).toBe(false);
    });

    it("pushes to the fork's URL when the head is on a fork the viewer may push to", async () => {
      const world = rewrittenWorld();
      world.view = {
        ...world.view,
        isCrossRepository: true,
        headRepository: { name: "widgets" },
        headRepositoryOwner: { login: "renovate-fork" },
      };
      await world.host().settleLockfiles(["package.json"], []);
      expect(pushes(world)).toEqual(["git push https://github.com/renovate-fork/widgets.git HEAD:refs/heads/fix/widget"]);
      expect(world.ghCalls).not.toContain("api user --jq .login");
    });

    it("pushes to a fork the viewer owns when the viewer cannot push to the base repository", async () => {
      const world = rewrittenWorld();
      world.canPush = false;
      world.view = {
        ...world.view,
        isCrossRepository: true,
        headRepository: { name: "widgets" },
        headRepositoryOwner: { login: "zach" },
      };
      await world.host().settleLockfiles(["package.json"], []);
      expect(pushes(world)).toEqual(["git push https://github.com/zach/widgets.git HEAD:refs/heads/fix/widget"]);
    });

    it("refuses a fork the viewer neither owns nor may maintain, and commits nothing", async () => {
      const world = rewrittenWorld();
      world.canPush = false;
      world.view = {
        ...world.view,
        isCrossRepository: true,
        headRepository: { name: "widgets" },
        headRepositoryOwner: { login: "someone-else" },
      };
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(staleReason(state.statuses[0])).toBe(
        "rewritten but not pushed: the head branch is on the fork someone-else/widgets; this run pushes only to a fork the viewer owns",
      );
      expect(pushes(world)).toEqual([]);
      expect(world.lines().some((line) => line.startsWith("git add"))).toBe(false);
    });
  });

  describe("after a push", () => {
    function rewrittenWorld(): World {
      const world = new World().file("package-lock.json");
      world.modified.add("package-lock.json");
      return world;
    }
    const headReads = (world: World): number => world.ghCalls.filter((call) => call.includes("headRefOid")).length;

    it("waits until GitHub reports the pushed commit as the head before calling the lockfile rewritten", async () => {
      const world = rewrittenWorld();
      world.lagReads = 2;
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([{ state: "rewritten", lockfile: "package-lock.json", via: "npm install" }]);
      expect(world.sleeps).toEqual([SETTLE_POLL_MS, SETTLE_POLL_MS]);
      expect(headReads(world)).toBe(3);
    });

    it("accepts a head a bot committed on top of the push", async () => {
      const world = rewrittenWorld();
      world.visibleAs = sha(9);
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses[0]).toMatchObject({ state: "rewritten" });
      expect(world.ghCalls.some((call) => call === `api repos/acme/widgets/compare/${sha(2)}...${sha(9)}`)).toBe(true);
      expect(world.sleeps).toEqual([]);
    });

    it("reports the lockfile as stale, not rewritten, when GitHub never reports the pushed head in time", async () => {
      const world = rewrittenWorld();
      world.lagReads = Number.POSITIVE_INFINITY;
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([
        {
          state: "stale",
          lockfile: "package-lock.json",
          reason: `rewritten but not pushed: could not confirm the push of ${sha(2)}: GitHub still reports the head as ${
            sha(1)
          } ${PUSH_VISIBLE_BUDGET_MS / 60_000} minutes after it`,
        },
      ]);
      const slept = world.sleeps.reduce((sum, ms) => sum + ms, 0);
      expect(slept).toBeLessThanOrEqual(PUSH_VISIBLE_BUDGET_MS);
      expect(slept).toBeGreaterThan(PUSH_VISIBLE_BUDGET_MS - 2 * SETTLE_POLL_MS);
    });

    it("reports the lockfile as stale when GitHub's head cannot be read after the push", async () => {
      const world = rewrittenWorld();
      world.ghFailures.set("pr view 7 --repo acme/widgets --json headRefOid", "gh: HTTP 500");
      const state = await world.host().settleLockfiles(["package.json"], []);
      expect(state.statuses).toEqual([
        {
          state: "stale",
          lockfile: "package-lock.json",
          reason: `rewritten but not pushed: could not confirm the push of ${sha(2)}: GitHub's head could not be read: gh: HTTP 500`,
        },
      ]);
    });
  });
});

describe("resettleLockfiles", () => {
  it("takes the checkout again so the pull request's head a fix round pushed is what is settled", async () => {
    const world = new World().file("go.sum");
    const host = world.host();
    const first = await host.settleLockfiles(["go.mod"], []);
    expect(first.statuses[0]).toMatchObject({ state: "unchanged" });
    world.localHead = sha(5);
    world.modified.add("go.sum");
    const second = await host.resettleLockfiles(["go.mod"], []);
    expect(world.checkouts).toEqual([PR, PR]);
    expect(second).toEqual({
      head: sha(6),
      statuses: [{ state: "rewritten", lockfile: "go.sum", via: "go mod tidy" }],
    });
    expect(world.lines().filter((line) => line.startsWith("git push"))).toEqual([PUSH]);
  });

  it("rejects when the checkout of the pushed head fails", async () => {
    const world = new World().file("go.sum");
    const host = world.host();
    await host.settleLockfiles(["go.mod"], []);
    world.checkoutFailure = "checkout is abc, pull request head is def";
    await expect(host.resettleLockfiles(["go.mod"], [])).rejects.toThrow("checkout is abc, pull request head is def");
  });
});

describe("one host per run", () => {
  it("settles and pushes each pull request in its own checkout, whatever order the hosts interleave in", async () => {
    const a = new World(PR, "/work/a", "fix/a").file("package-lock.json");
    const b = new World("https://github.com/acme/gadgets/pull/9", "/work/b", "fix/b").file("go.sum");
    a.modified.add("package-lock.json");
    b.modified.add("go.sum");
    const [settledA, settledB] = await Promise.all([
      a.host().settleLockfiles(["package.json"], []),
      b.host().settleLockfiles(["go.mod"], []),
    ]);
    expect(settledA.statuses).toEqual([{ state: "rewritten", lockfile: "package-lock.json", via: "npm install" }]);
    expect(settledB.statuses).toEqual([{ state: "rewritten", lockfile: "go.sum", via: "go mod tidy" }]);
    expect(a.runs.every((call) => call.cwd === "/work/a")).toBe(true);
    expect(b.runs.every((call) => call.cwd === "/work/b")).toBe(true);
    expect(a.lines().filter((line) => line.startsWith("git push"))).toEqual(["git push origin HEAD:refs/heads/fix/a"]);
    expect(b.lines().filter((line) => line.startsWith("git push"))).toEqual(["git push origin HEAD:refs/heads/fix/b"]);
    expect(a.checkouts).toEqual([PR]);
    expect(b.checkouts).toEqual(["https://github.com/acme/gadgets/pull/9"]);
  });

  it("refuses a URL that is not a pull request when the host is created, not when it first runs", () => {
    const world = new World();
    expect(() => world.host({ prUrl: "https://example.com/not-a-pull" })).toThrow("invalid GitHub pull URL");
  });

  it("hands the checkout the pull request's canonical URL, whatever spelling the host was created with", async () => {
    const world = new World().file("go.sum");
    await world.host({ prUrl: "acme/widgets#7" }).settleLockfiles(["go.mod"], []);
    expect(world.checkouts).toEqual([PR]);
  });

  it("builds the live host without running anything", () => {
    const host = liveUpgradeHost(PR);
    expect(Object.keys(host).sort()).toEqual([
      "armPullRequest",
      "currentChangedFiles",
      "currentHeadUnits",
      "resettleLockfiles",
      "settleLockfiles",
    ]);
  });
});

describe("armPullRequest", () => {
  const MERGE_AUTO = "pr merge 7 --repo acme/widgets --auto --squash";
  const MERGE_NOW = "pr merge 7 --repo acme/widgets --squash";
  const LABEL_CREATE =
    "label create ai:dependencies-checked --repo acme/widgets --description Dependency upgrade checked by upgrade_dependency --color 0E8A16 --force";
  const LABEL_ADD = "pr edit 7 --repo acme/widgets --add-label ai:dependencies-checked";

  it("arms squash automerge, then creates the label and adds it", async () => {
    const world = new World();
    const armed = await world.host().armPullRequest();
    expect(armed).toEqual({ armed: true, reason: "will be automatically merged when requirements are met" });
    expect(world.ghCalls).toEqual([MERGE_AUTO, LABEL_CREATE, LABEL_ADD]);
  });

  it("merges with a plain squash when automerge is refused, then labels", async () => {
    const world = new World();
    world.ghFailures.set(MERGE_AUTO, "Pull request is in clean status");
    const armed = await world.host().armPullRequest();
    expect(armed.armed).toBe(true);
    expect(world.ghCalls).toEqual([MERGE_AUTO, MERGE_NOW, LABEL_CREATE, LABEL_ADD]);
  });

  it("reports why neither merge worked, and does not label", async () => {
    const world = new World();
    world.ghFailures.set(MERGE_AUTO, "auto merge is not allowed");
    world.ghFailures.set(MERGE_NOW, "merge refused");
    const armed = await world.host().armPullRequest();
    expect(armed).toEqual({ armed: false, reason: "merge refused" });
    expect(world.ghCalls).toEqual([MERGE_AUTO, MERGE_NOW]);
  });

  it("does not report armed when the label cannot be created", async () => {
    const world = new World();
    world.ghFailures.set("label create", "label failed");
    const armed = await world.host().armPullRequest();
    expect(armed).toEqual({ armed: false, reason: "label failed" });
    expect(world.ghCalls).toEqual([MERGE_AUTO, LABEL_CREATE]);
  });

  it("does not report armed when the label cannot be added", async () => {
    const world = new World();
    world.ghFailures.set("pr edit", "label not added");
    const armed = await world.host().armPullRequest();
    expect(armed).toEqual({ armed: false, reason: "label not added" });
  });

  it("rethrows a cancelled run instead of reporting a refused merge", async () => {
    const world = new World();
    const controller = new AbortController();
    world.ghFailures.set("pr merge", "gh was cancelled");
    controller.abort();
    await expect(world.host({ signal: controller.signal }).armPullRequest()).rejects.toThrow("gh was cancelled");
  });
});

describe("currentChangedFiles", () => {
  it("returns the files and the patch GitHub reports for each", async () => {
    const world = new World();
    world.filesJson = JSON.stringify([{ filename: "package.json", patch: "@@ -1 +1 @@" }, { filename: "bun.lock" }]);
    expect(await world.host().currentChangedFiles("acme/widgets", 7)).toEqual([
      { path: "package.json", patch: "@@ -1 +1 @@" },
      { path: "bun.lock", patch: "" },
    ]);
  });

  it("reads every page of a paginated answer", async () => {
    const world = new World();
    world.filesJson = `${JSON.stringify([{ filename: "a.ts", patch: "p" }])}${JSON.stringify([{ filename: "b.ts" }])}`;
    const files = await world.host().currentChangedFiles("acme/widgets", 7);
    expect(files?.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("asks for the repository and pull request it is given", async () => {
    const world = new World();
    world.ghFailures.set("api repos/other/repo/pulls/9/files --paginate", "gh: HTTP 404");
    expect(await world.host().currentChangedFiles("other/repo", 9)).toBeUndefined();
    expect(world.ghCalls).toEqual(["api repos/other/repo/pulls/9/files --paginate"]);
  });

  it("returns an empty list for a pull request that changes no files", async () => {
    const world = new World();
    expect(await world.host().currentChangedFiles("acme/widgets", 7)).toEqual([]);
  });

  it("returns undefined, not an empty diff, when GitHub cannot be read or answers with no list", async () => {
    const failing = new World();
    failing.ghFailures.set("api repos/acme/widgets/pulls/7/files", "gh: HTTP 502");
    expect(await failing.host().currentChangedFiles("acme/widgets", 7)).toBeUndefined();

    const garbled = new World();
    garbled.filesJson = "<html>Bad gateway</html>";
    expect(await garbled.host().currentChangedFiles("acme/widgets", 7)).toBeUndefined();

    const truncated = new World();
    truncated.filesJson = `[{"filename": "a.ts", "patch": `;
    const files = await truncated.host().currentChangedFiles("acme/widgets", 7);
    expect(files === undefined || files.length === 0).toBe(true);
  });

  it("rethrows a cancelled run", async () => {
    const world = new World();
    const controller = new AbortController();
    world.ghFailures.set("api repos", "gh was cancelled");
    controller.abort();
    await expect(world.host({ signal: controller.signal }).currentChangedFiles("acme/widgets", 7)).rejects.toThrow(
      "gh was cancelled",
    );
  });
});

describe("currentHeadUnits", () => {
  const REACT_BODY = "| Package | Change |\n|---|---|\n"
    + "| [react](https://react.dev/) | [`19.2.4` \u2192 `19.3.1`](https://renovatebot.com/diffs/npm/react/19.2.4/19.3.1) |\n"
    + "| [react-dom](https://react.dev/) | [`19.2.4` \u2192 `19.3.1`](https://renovatebot.com/diffs/npm/react-dom/19.2.4/19.3.1) |";

  it("groups the packages the head's body names by their peer edges, reading npm in the working copy", async () => {
    const world = new World();
    world.titleBody = { title: "update react monorepo", body: REACT_BODY };
    world.results.set("npm view react-dom@19.3.1 peerDependencies --json", ok('{"react":"^19.3.1"}'));
    const units = await world.host().currentHeadUnits("acme/widgets", 7, "npm");
    expect(units).toEqual([["react", "react-dom"]]);
    expect(world.checkouts).toEqual([PR]);
    const npm = world.runs.filter((call) => call.line.startsWith("npm view"));
    expect(npm.map((call) => call.line)).toEqual([
      "npm view react@19.3.1 peerDependencies --json",
      "npm view react-dom@19.3.1 peerDependencies --json",
    ]);
    expect(npm.every((call) => call.cwd === DIR)).toBe(true);
  });

  it("keeps packages with no peer edge in separate units", async () => {
    const world = new World();
    world.titleBody = { title: "update react monorepo", body: REACT_BODY };
    expect(await world.host().currentHeadUnits("acme/widgets", 7, "npm")).toEqual([["react"], ["react-dom"]]);
  });

  it("reuses the working copy the last settle took instead of taking another", async () => {
    const world = new World().file("go.sum");
    world.titleBody = { title: "update react monorepo", body: REACT_BODY };
    const host = world.host();
    await host.settleLockfiles(["go.mod"], []);
    await host.currentHeadUnits("acme/widgets", 7, "npm");
    expect(world.checkouts).toEqual([PR]);
  });

  it("reads the package from the title when the body names none", async () => {
    const world = new World();
    world.titleBody = { title: "Update dependency lodash to v4.17.21", body: "nothing to see" };
    expect(await world.host().currentHeadUnits("acme/widgets", 7, "npm")).toEqual([["lodash"]]);
    expect(world.lines()).toContain("npm view lodash@4.17.21 peerDependencies --json");
  });

  it("asks npm nothing for an ecosystem without peer dependencies", async () => {
    const world = new World();
    world.titleBody = { title: "update react monorepo", body: REACT_BODY };
    expect(await world.host().currentHeadUnits("acme/widgets", 7, "go")).toEqual([["react"], ["react-dom"]]);
    expect(world.lines().some((line) => line.startsWith("npm"))).toBe(false);
  });

  it("returns undefined when the head names no package", async () => {
    const world = new World();
    world.titleBody = { title: "Configure Renovate", body: "Welcome to Renovate!" };
    expect(await world.host().currentHeadUnits("acme/widgets", 7, "npm")).toBeUndefined();
    expect(world.checkouts).toEqual([]);
  });

  it("returns undefined when a package's peers cannot be resolved, so the caller keeps its units", async () => {
    const world = new World();
    world.titleBody = { title: "update react monorepo", body: REACT_BODY };
    world.results.set("npm view react@19.3.1 peerDependencies --json", failed("npm error 404 Not Found"));
    expect(await world.host().currentHeadUnits("acme/widgets", 7, "npm")).toBeUndefined();
  });

  it("returns undefined when GitHub cannot be read or answers with something that is not JSON", async () => {
    const failing = new World();
    failing.ghFailures.set("pr view 7 --repo acme/widgets --json title,body", "gh: HTTP 502");
    expect(await failing.host().currentHeadUnits("acme/widgets", 7, "npm")).toBeUndefined();

    const garbled = new World();
    garbled.gh = async () => "<html>Bad gateway</html>";
    expect(await garbled.host({ gh: garbled.gh }).currentHeadUnits("acme/widgets", 7, "npm")).toBeUndefined();
  });

  it("rethrows a cancelled run", async () => {
    const world = new World();
    const controller = new AbortController();
    world.ghFailures.set("pr view", "gh was cancelled");
    controller.abort();
    await expect(world.host({ signal: controller.signal }).currentHeadUnits("acme/widgets", 7, "npm")).rejects.toThrow(
      "gh was cancelled",
    );
  });
});

describe("runThrough", () => {
  it("runs a program in its directory with the environment it was given added to this process's", async () => {
    const { runner, calls } = fakeRunner(() => done("out", 3, "err"));
    const result = await runThrough(runner)("/work/x", "go", ["mod", "tidy"], { CI: "true" });
    expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("go");
    expect(calls[0]!.args).toEqual(["mod", "tidy"]);
    expect(calls[0]!.options.cwd).toBe("/work/x");
    expect(calls[0]!.options.env?.CI).toBe("true");
    expect(calls[0]!.options.env?.PATH).toBe(process.env.PATH);
    expect(calls[0]!.options.timeoutMs).toBe(10 * 60_000);
  });

  it("leaves the environment alone when none is added", async () => {
    const { runner, calls } = fakeRunner(() => done());
    await runThrough(runner)("/work/x", "git", ["status"]);
    expect(calls[0]!.options.env).toBe(process.env);
  });

  it("runs a push with the gh login's token for the pre-push hooks and the hook budget", async () => {
    const { runner, calls } = fakeRunner((command, args) =>
      command === "gh" && args[0] === "auth" ? done("tok-123\n") : done("", 0, "remote: ok")
    );
    const result = await runThrough(runner)("/work/x", "git", ["push", "origin", "HEAD:refs/heads/fix/widget"]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "remote: ok" });
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "gh auth token",
      "git push origin HEAD:refs/heads/fix/widget",
    ]);
    expect(calls[1]!.options.env?.GH_TOKEN).toBe("tok-123");
    expect(calls[1]!.options.env?.GITHUB_TOKEN).toBe("tok-123");
    expect(calls[1]!.options.timeoutMs).toBe(PUSH_HOOK_BUDGET_MS);
    expect(calls[1]!.options.cwd).toBe("/work/x");
  });

  it("runs a push without a token when gh has no login", async () => {
    const { runner, calls } = fakeRunner((command, args) =>
      command === "gh" && args[0] === "auth" ? done("", 1, "not logged in") : done()
    );
    await runThrough(runner)("/work/x", "git", ["push", "origin", "HEAD:refs/heads/b"]);
    expect(calls[1]!.options.env).toBe(process.env);
  });

  it("reports a program that cannot start as code -1 with the reason", async () => {
    const { runner } = fakeRunner(() => new Error("aube failed to start: spawn aube ENOENT"));
    expect(await runThrough(runner)("/work/x", "aube", ["install"])).toEqual({
      code: -1,
      stdout: "",
      stderr: "aube failed to start: spawn aube ENOENT",
    });
  });

  it("reports a program killed at its timeout as code -1 with what it printed", async () => {
    const { runner } = fakeRunner(() => ({ code: -1, stdout: "half", stderr: "slow", killed: true }));
    const result = await runThrough(runner)("/work/x", "pnpm", ["install"]);
    expect(result.code).toBe(-1);
    expect(result.stdout).toBe("half");
    expect(result.stderr).toBe(`slow\npnpm timed out after ${10 * 60_000} ms`);
  });

  it("throws when the run is cancelled, however the runner reports it", async () => {
    const controller = new AbortController();
    controller.abort();
    const killed = fakeRunner(() => ({ code: -1, stdout: "", stderr: "", killed: true }));
    await expect(runThrough(killed.runner, controller.signal)("/work/x", "go", ["mod", "tidy"])).rejects.toThrow(
      "go was cancelled",
    );
    const refused = fakeRunner(() => new Error("go was cancelled before it started"));
    await expect(runThrough(refused.runner, controller.signal)("/work/x", "go", ["mod", "tidy"])).rejects.toThrow(
      "go was cancelled before it started",
    );
  });

  it("makes a missing package tool a stale lockfile in a host that runs through it", async () => {
    const { runner } = fakeRunner((command) =>
      command === "aube" ? new Error("aube failed to start: spawn aube ENOENT") : done(`${sha(1)}\n`)
    );
    const world = new World().file("aube-lock.yaml");
    const state = await world.host({ run: runThrough(runner) }).settleLockfiles(["package.json"], []);
    expect(state.statuses).toEqual([
      { state: "stale", lockfile: "aube-lock.yaml", reason: "aube failed to start: spawn aube ENOENT" },
    ]);
    expect(state.head).toBe(sha(1));
  });
});
