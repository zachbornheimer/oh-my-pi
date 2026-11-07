import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GH_BIN, OMP_BIN, REPO_GREEN_CANARY } from "./constants.js";
import type { Ctx } from "./context.js";
import { GATE_HEAD, type Harness, type JobFixture, makeHarness, type PullFixture, type RepoFixture } from "./fake_world.js";
import { shellHost } from "./host.js";
import { billingHoldOwners, decideInclusion } from "./inclusion.js";
import { agentMsToday, readEvents, type Row, type StateFile } from "./ledger.js";
import { agentCapReached, localDay, transitionAllowed } from "./states.js";
import { parseTarget } from "./target.js";
import { buildTool, DESCRIPTION, renderRun } from "./tool.js";
import { classifyJobs, classifyRepository, type JobFact, pullNumber, type RepoFacts } from "./triage.js";
import { classifyDefaultBranchCiState } from "./read_state.js";
import { ompUpgradeRunner, reportOfEvents, UPGRADE_TOOL } from "./upgrade_runner.js";
import { orderRedFirstByLiveRollup, runGreenDefaultBranch, runGreenRepositories } from "./workflow.js";
import { upgradeBotDependencyPrsMissingCheckedLabel } from "./upgrade.js";

let h: Harness;
let ctx: Ctx;

function codeJob(extra: Partial<JobFixture> = {}): JobFixture {
  return {
    type: "check",
    name: "unit",
    conclusion: "FAILURE",
    workflow: "ci",
    runId: 41,
    previous: "failure",
    logUrl: "https://github.com/acme/example/actions/runs/41",
    ...extra,
  };
}

async function loadState(): Promise<StateFile> {
  return JSON.parse(await readFile(join(h.stateDir, "state.json"), "utf8")) as StateFile;
}

function row(state: StateFile, name: string): Row {
  const found = state.repositories.find((item) => item.nameWithOwner === name);
  if (found === undefined) {
    const seen = state.repositories.map((item) => `${item.nameWithOwner}=${item.state}`).join(", ");
    throw new Error(`${name} missing (${seen || "no rows"})`);
  }
  return found;
}

async function seed(rows: Record<string, { state: string; prUrl?: string; at?: string }>): Promise<void> {
  const events = Object.entries(rows).map(([name, item]) => ({
    at: item.at ?? "2026-10-25T15:00:00.000Z",
    runId: "rg-seed",
    nameWithOwner: name,
    from: "",
    to: item.state,
    evidence: "seed",
    defaultBranch: "main",
    prUrl: item.prUrl,
  }));
  await writeFile(join(h.stateDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

const sweep = (dryRun: boolean) => runGreenRepositories(ctx, { kind: "all" }, dryRun);
const lineMatches = (needle: string): boolean => h.lines().some((line) => line.includes(needle));

beforeEach(async () => {
  h = await makeHarness();
  ctx = { host: h.host, progress: () => {}, upgrade: h.upgrade, drive: h.drive };
});

afterEach(async () => {
  await h.cleanup();
});

describe("green_default_branch: the universe", () => {
  it("lists the pushable universe, including forks, with each exclusion and its reason", async () => {
    h.world.orgs = ["acme"];
    h.world.repos = {
      "acme/lib": { org: "acme", push: true, rollup: "SUCCESS", workflows: ["ci"] },
      "octocat/alive": { push: true, rollup: "SUCCESS", workflows: ["ci"] },
      "octocat/forked": { push: true, fork: true, rollup: "SUCCESS", workflows: ["ci"] },
      "octocat/old": { push: true, archived: true, rollup: "SUCCESS", workflows: ["ci"] },
      "octocat/reader": { rollup: "SUCCESS", workflows: ["ci"] },
      "zachbornheimer/hold": { push: true, rollup: "FAILURE", workflows: ["ci"], jobs: [codeJob()] },
      [REPO_GREEN_CANARY]: { push: true, rollup: "FAILURE", workflows: ["ci"], jobs: [codeJob()] },
    };

    const report = await sweep(true);
    const state = await loadState();

    expect(report.exitCode).toBe(0);
    expect(state.repositories.map((item) => item.nameWithOwner).sort()).toEqual([
      "acme/lib",
      "octocat/alive",
      "octocat/forked",
    ]);
    expect(report.text.split("\n")).toEqual([
      "acme/lib: green (statusCheckRollup SUCCESS)",
      "octocat/alive: green (statusCheckRollup SUCCESS)",
      "octocat/forked: green (statusCheckRollup SUCCESS)",
      "octocat/old: excluded (archived)",
      "octocat/reader: excluded (not pushable (READ))",
      "zachbornheimer/hold: excluded (billing hold until reset)",
      `${REPO_GREEN_CANARY}: excluded (canary excluded from an account-wide run)`,
    ]);
    expect(lineMatches("api --paginate user/orgs")).toBe(true);
    expect(lineMatches("api --paginate orgs/acme/repos")).toBe(true);
    expect(lineMatches("affiliation=owner,collaborator")).toBe(true);
  });

  it("the billing hold leaves a held repository out of a sweep and runs it when it is named", async () => {
    h.world.repos = { "zachbornheimer/hold": { push: true, rollup: "SUCCESS", workflows: ["ci"] } };

    const left = await sweep(true);
    expect(left.exitCode).toBe(1);
    expect(left.text).toContain("zachbornheimer/hold: excluded (billing hold until reset)");
    expect(await readEvents(h.host)).toEqual([]);

    await runGreenDefaultBranch(ctx, "zachbornheimer/hold", true);
    expect(row(await loadState(), "zachbornheimer/hold").state).toBe("green");
  });

  it("takes the billing-hold owners from $REPO_GREEN_BILLING_HOLD_OWNERS, empty meaning none", () => {
    expect(billingHoldOwners({})).toEqual(["zachbornheimer"]);
    expect(billingHoldOwners({ REPO_GREEN_BILLING_HOLD_OWNERS: " Acme , beta " })).toEqual(["acme", "beta"]);
    expect(billingHoldOwners({ REPO_GREEN_BILLING_HOLD_OWNERS: "" })).toEqual([]);
    const listing = (nameWithOwner: string) => ({
      nameWithOwner,
      archived: false,
      fork: false,
      viewerPermission: "WRITE" as const,
      defaultBranch: "main",
    });
    const held = decideInclusion([listing("acme/a"), listing("acme/a"), listing("zachbornheimer/z")], ["acme"]);
    expect(held.included.map((repo) => repo.nameWithOwner)).toEqual(["zachbornheimer/z"]);
    expect(held.exclusions).toEqual([{ nameWithOwner: "acme/a", reason: "billing hold until reset" }]);
  });

  it("excludes a single named repository when the viewer cannot push to it", async () => {
    h.world.repos = { "can1357/oh-my-pi": { push: false, rollup: "FAILURE", workflows: ["ci"], jobs: [codeJob()] } };
    const run = await runGreenDefaultBranch(ctx, "can1357/oh-my-pi", false);
    expect(run.exitCode).toBe(0);
    expect(run.state).toBe("excluded");
    expect(run.evidence).toBe("not pushable (READ)");
    expect(await readEvents(h.host)).toEqual([]);
    expect(h.ompRuns()).toEqual([]);
  });

  it("fails a sweep whose repositories cannot be listed instead of reporting success", async () => {
    h.world.listFails = true;
    await expect(sweep(true)).rejects.toThrow("listing repositories failed");
  });
});

describe("green_default_branch: triage", () => {
  const facts = (extra: Partial<RepoFacts>): RepoFacts => ({
    nameWithOwner: "acme/x",
    defaultBranch: "main",
    workflowStatus: 200,
    workflowCount: 1,
    workflowNames: ["ci"],
    rollupStatus: 200,
    rollup: "FAILURE",
    headSha: "abc",
    jobs: [],
    ...extra,
  });
  const job = (extra: Partial<JobFact>): JobFact => ({
    name: "test",
    conclusion: "FAILURE",
    logUrl: "https://x/log",
    actionsRun: true,
    workflowName: "ci",
    runId: 5,
    previousConclusion: "SUCCESS",
    ...extra,
  });

  it("records an empty workflow list as no-ci, and a non-200 read or a pull-request-only workflow is not no-ci", async () => {
    h.world.repos = {
      "acme/noci": { push: true, workflows: [], rollup: "ABSENT" },
      "acme/pronly": { push: true, workflows: ["ci"], rollup: "ABSENT", diff: "" },
      "acme/down": { push: true, workflowsStatus: 503, rollup: "ABSENT" },
    };

    await sweep(false);
    const state = await loadState();

    expect(row(state, "acme/noci").state).toBe("no-ci");
    expect(lineMatches("pr create acme/noci")).toBe(false);
    expect(row(state, "acme/pronly").state).not.toBe("no-ci");
    expect(row(state, "acme/down").state).toBe("api-error");
    expect(row(state, "acme/down").lastEvent).toContain("HTTP 503");
  });

  it("a dry run records infra for a failed deploy and does not rerun it", async () => {
    h.world.repos = {
      "acme/ship": {
        push: true,
        rollup: "FAILURE",
        workflows: ["deploy"],
        jobs: [codeJob({ name: "deploy", workflow: "deploy", previous: "success", runId: 9 })],
      },
    };
    await sweep(true);
    expect(row(await loadState(), "acme/ship").state).toBe("infra");
    expect(lineMatches("run rerun")).toBe(false);
    expect(lineMatches("checkout -B")).toBe(false);
  });

  it("records billing, permissions and a non-Actions check as infra without a rerun or a fixer", async () => {
    h.world.repos = {
      "acme/bill": {
        push: true,
        rollup: "FAILURE",
        workflows: ["billing"],
        jobs: [codeJob({ name: "billing", workflow: "billing", runId: 3 })],
      },
      "acme/perms": {
        push: true,
        rollup: "FAILURE",
        workflows: ["ci"],
        jobs: [codeJob({ name: "permissions", workflow: "ci", runId: 4 })],
      },
      "acme/external": {
        push: true,
        rollup: "FAILURE",
        workflows: ["ci"],
        jobs: [{ type: "status", name: "circleci", conclusion: "FAILURE", logUrl: "https://example.test/circle" }],
      },
    };
    await sweep(false);
    const state = await loadState();
    for (const name of ["acme/bill", "acme/perms", "acme/external"]) expect(row(state, name).state).toBe("infra");
    expect(h.lines().filter((line) => line.includes("run rerun"))).toEqual([]);
    expect(h.ompRuns()).toEqual([]);
  });

  it("classifies flake, infra and code, and a pending rollup as queued", () => {
    expect(classifyJobs([job({})]).kind).toBe("flake");
    expect(classifyJobs([job({ previousConclusion: "FAILURE" })]).kind).toBe("code");
    expect(classifyJobs([job({ conclusion: "CANCELLED", previousConclusion: null })]).kind).toBe("flake");
    expect(classifyJobs([job({ name: "deploy", workflowName: "deploy" })]).kind).toBe("infra");
    expect(classifyJobs([job({ actionsRun: false })]).kind).toBe("infra");
    expect(classifyRepository(facts({ rollup: "PENDING" }), undefined, { dryRun: false, resumed: false })).toEqual({
      action: "record",
      from: "",
      to: "queued",
      evidence: "statusCheckRollup PENDING",
    });
    const rerun = classifyRepository(facts({ jobs: [job({})] }), undefined, { dryRun: false, resumed: false });
    expect(rerun.action).toBe("rerun");
    const dry = classifyRepository(facts({ jobs: [job({})] }), undefined, { dryRun: true, resumed: false });
    expect(dry).toMatchObject({ action: "record", to: "queued" });
    const reread = classifyRepository(
      facts({}),
      { state: "awaiting-merge", prUrl: "https://github.com/acme/x/pull/9" },
      { dryRun: false, resumed: true },
    );
    expect(reread).toMatchObject({ action: "reread", prNumber: 9 });
    expect(pullNumber("https://github.com/acme/x")).toBe(0);
  });

  it("allows green and no-ci only on their proof", () => {
    expect(transitionAllowed("green", { kind: "fresh-rollup-success", rollup: "SUCCESS" })).toBe(true);
    expect(transitionAllowed("green", { kind: "fresh-rollup-success", rollup: "FAILURE" })).toBe(false);
    expect(transitionAllowed("green", { kind: "observed", evidence: "x" })).toBe(false);
    expect(
      transitionAllowed("green", { kind: "squash-merge-success", headSha: "a", mergeCommit: "a", rollup: "SUCCESS" }),
    ).toBe(true);
    expect(
      transitionAllowed("green", { kind: "squash-merge-success", headSha: "a", mergeCommit: "b", rollup: "SUCCESS" }),
    ).toBe(false);
    expect(transitionAllowed("no-ci", { kind: "no-workflows", status: 200, workflowCount: 0 })).toBe(true);
    expect(transitionAllowed("no-ci", { kind: "no-workflows", status: 503, workflowCount: 0 })).toBe(false);
  });

  it("alone reads the default branch itself and writes nothing", async () => {
    h.world.repos = {
      "acme/alone": { push: true, defaultBranch: "trunk", rollup: "FAILURE", workflows: ["ci"], jobs: [codeJob()] },
    };
    const classified = await classifyDefaultBranchCiState(h.host, { nameWithOwner: "acme/alone" });
    expect(classified.classification.action).toBe("fix");
    expect(classified.context.defaultBranch).toBe("trunk");
    expect(lineMatches("repos/acme/alone")).toBe(true);
    expect(await readEvents(h.host)).toEqual([]);
    expect(h.ompRuns()).toEqual([]);
  });

  it("reads open pull requests past gh's default page of 30", async () => {
    h.world.repos = { "acme/many": { push: true, rollup: "SUCCESS", workflows: ["ci"] } };
    await runGreenDefaultBranch(ctx, "acme/many", true);
    const lists = h.world.calls.filter((call) => call.args[0] === "pr" && call.args[1] === "list");
    expect(lists.length).toBeGreaterThan(0);
    for (const call of lists) expect(call.args[call.args.indexOf("--limit") + 1]).toBe("1000");
  });
});

describe("green_default_branch: rerun", () => {
  it("records flaky-rerun only after SUCCESS and rerun-failed when the rerun does not finish or is refused", async () => {
    const flake = (runId: number, extra: Partial<RepoFixture>): RepoFixture => ({
      push: true,
      rollup: "FAILURE",
      workflows: ["ci"],
      jobs: [codeJob({ name: "test", workflow: "ci", previous: "success", runId })],
      ...extra,
    });
    h.world.repos = {
      "acme/hang": flake(51, { rerunConclusion: "PENDING" }),
      "acme/later": flake(52, { rerunConclusion: "SUCCESS" }),
      "acme/refused": flake(53, { rerunStatus: 1 }),
      "acme/zz": { push: true, rollup: "SUCCESS", workflows: ["ci"] },
    };

    await sweep(false);
    const state = await loadState();

    expect(row(state, "acme/later").state).toBe("flaky-rerun");
    expect(row(state, "acme/hang").state).toBe("rerun-failed");
    expect(row(state, "acme/hang").lastEvent).toContain("timeout");
    expect(row(state, "acme/refused").state).toBe("rerun-failed");
    expect(row(state, "acme/refused").lastEvent).toContain("gh run rerun 53 failed");
    expect(row(state, "acme/zz").state).toBe("green");
    expect(h.ompRuns()).toEqual([]);
  });
});

describe("green_default_branch: the fixer", () => {
  const repo = "acme/fix";
  const fixable = (extra: Partial<RepoFixture> = {}) => {
    h.world.repos = {
      [repo]: {
        push: true,
        rollup: "FAILURE",
        workflows: ["ci"],
        jobs: [codeJob()],
        diff: "diff --git a/a.txt b/a.txt\n",
        ...extra,
      },
    };
  };
  const gitCalls = () => h.world.calls.filter((call) => call.bin === "git").map((call) => call.args);
  const pushedBranch = (): boolean =>
    Object.keys(h.world.refs[repo] ?? {}).some((ref) => ref.startsWith("refs/heads/ci-green/"));
  const failures = async (): Promise<string[]> =>
    (await readEvents(h.host)).filter((event) => event.nameWithOwner === repo && event.evidence.includes("failed"))
      .map((event) => event.evidence);
  const leftover = async (files: Record<string, string>): Promise<void> => {
    const path = join(h.worktrees, repo);
    for (const [name, body] of Object.entries(files)) {
      await mkdir(join(path, name, ".."), { recursive: true });
      await writeFile(join(path, name), body);
    }
  };
  const originHead = (branch: string) => ({ status: 0, stdout: `refs/remotes/origin/${branch}\n`, stderr: "" });

  it("runs omp -p /green on the @task role without a config and does not update a forbidden ref", async () => {
    h.world.forbidPush = true;
    h.world.refs[repo] = { "refs/heads/main": "abc111" };
    fixable();
    h.world.omp = {
      kind: "run",
      run: (cwd) => {
        // The agent tries a forbidden ref: the pre-push hook refuses it and records the violation.
        void writeFile(join(cwd, ".repo-green", "push-violation"), "refs/heads/main\n");
        return { status: 0, stdout: "done\n", stderr: "" };
      },
    };

    await sweep(false);
    const invoked = h.ompRuns()[0];

    expect(row(await loadState(), repo).state).toBe("needs-human");
    expect(row(await loadState(), repo).lastEvent).toBe("push refused refs/heads/main");
    expect(lineMatches("pr create")).toBe(false);
    expect(lineMatches("pr merge")).toBe(false);
    expect(invoked?.args[1]?.startsWith("/green")).toBe(true);
    expect(invoked?.args[invoked.args.indexOf("--model") + 1]).toBe("@task");
    expect(invoked?.args).not.toContain("--config");
    expect(h.world.hookCodes).toEqual([1, 1]);
    expect(h.world.refs[repo]?.["refs/heads/main"]).toBe("abc111");
    expect(h.world.refs[repo]?.["refs/tags/v1.2.3"]).toBeUndefined();
  });

  it("replaces a non-empty directory that is not a clone with a fresh clone", async () => {
    fixable();
    await leftover({ "junk.txt": "left by a killed run\n" });
    await sweep(false);
    expect(await failures()).toEqual([]);
    expect(gitCalls().filter((args) => args[0] === "clone")).toHaveLength(1);
    expect(pushedBranch()).toBe(true);
    expect(h.world.originHeadAtPush[repo]).toEqual(originHead("main"));
  });

  it("replaces a clone of a different repository with a fresh clone", async () => {
    fixable();
    await leftover({ ".git/fake-origin": "https://github.com/other/thing.git", "other.txt": "x\n" });
    await sweep(false);
    expect(await failures()).toEqual([]);
    expect(gitCalls().filter((args) => args[0] === "clone")).toHaveLength(1);
    expect(pushedBranch()).toBe(true);
  });

  it("reuses a clone of the same repository left mid-merge: aborts, fetches, resets, cleans, no clone", async () => {
    fixable();
    await leftover({
      ".git/fake-origin": `https://github.com/${repo}.git`,
      ".git/MERGE_HEAD": "e2865ad8\n",
      ".repo-green/push-violation": "refs/heads/main\n",
    });
    await sweep(false);
    const at = (prefix: string[]): number =>
      gitCalls().findIndex((args) => prefix.every((word, index) => args[index] === word));
    expect(await failures()).toEqual([]);
    expect(gitCalls().some((args) => args[0] === "clone")).toBe(false);
    const aborted = at(["merge", "--abort"]);
    const fetched = at(["fetch", "--depth", "1", "origin"]);
    const headSet = at(["remote", "set-head", "origin", "main"]);
    const reset = at(["reset", "--hard"]);
    const cleaned = at(["clean"]);
    const switched = at(["checkout"]);
    expect(aborted).toBeGreaterThanOrEqual(0);
    expect(headSet).toBeGreaterThan(fetched);
    expect(headSet).toBeLessThan(reset);
    expect(Math.max(aborted, fetched)).toBeLessThan(reset);
    expect(reset).toBeLessThan(cleaned);
    expect(cleaned).toBeLessThan(switched);
    expect(h.world.killed).toEqual([]);
    expect(pushedBranch()).toBe(true);
  });

  it("replaces a reused clone with a fresh one when it cannot be fetched", async () => {
    fixable();
    h.world.failFetch = true;
    await leftover({ ".git/fake-origin": `https://github.com/${repo}.git` });
    await sweep(false);
    expect(await failures()).toEqual([]);
    expect(gitCalls().filter((args) => args[0] === "clone")).toHaveLength(1);
    expect(pushedBranch()).toBe(true);
  });

  it("corrects a stale origin/HEAD to a non-main default branch before running the fixer", async () => {
    fixable({ defaultBranch: "trunk" });
    await leftover({
      ".git/fake-origin": `https://github.com/${repo}.git`,
      ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/old-default\n",
    });
    await sweep(false);
    expect(await failures()).toEqual([]);
    expect(h.world.originHeadAtPush[repo]).toEqual(originHead("trunk"));
    expect(gitCalls().some((args) => args[0] === "clone")).toBe(false);
  });

  it("does not run the fixer when origin/HEAD cannot be established after a fresh clone", async () => {
    fixable();
    h.world.failSetHead = true;
    await sweep(false);
    expect((await failures()).join("\n")).toContain("origin/HEAD");
    expect(pushedBranch()).toBe(false);
    expect(h.ompRuns()).toEqual([]);
  });

  it("records unfixed for an empty diff, names a clone that cannot be removed, and charges the agent time once", async () => {
    fixable({ diff: "" });
    h.world.omp = {
      kind: "run",
      run: () => {
        h.world.elapsedMs += 120_000;
        return { status: 0, stdout: "done\n", stderr: "" };
      },
    };
    let removals = 0;
    const clear = h.host.remove;
    h.host.remove = async (path: string) => {
      removals += 1;
      if (removals === 1) return clear(path);
      throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}/.build'`);
    };

    const run = await runGreenDefaultBranch(ctx, repo, false);
    const sticky = row(await loadState(), repo);

    expect(run.state).toBe("unfixed");
    expect(run.exitCode).toBe(1);
    expect(sticky.lastEvent).toContain("empty diff");
    expect(sticky.lastEvent).toContain("ENOTEMPTY");
    // The virtual clock also counts the watch loop's first 60 s poll, so the run is at least the agent's 120 s.
    expect(sticky.elapsedSeconds).toBeGreaterThanOrEqual(120);
    expect(sticky.elapsedSeconds).toBeLessThanOrEqual(180);
    // The agent's time is on one event only, so the daily cap sums it once.
    const charged = (await readEvents(h.host)).filter((event) => (event.elapsedSeconds ?? 0) > 0);
    expect(charged.map((event) => event.to)).toEqual(["fixing"]);
    expect(sticky.attemptsToday).toBe(1);
  });

  it("records timed-out and stops the agent at the limit, then removes the clone", async () => {
    fixable();
    h.world.omp = { kind: "hang" };
    const run = await runGreenDefaultBranch(ctx, repo, false);
    expect(run.state).toBe("timed-out");
    expect(h.world.killed).toHaveLength(1);
    expect(row(await loadState(), repo).elapsedSeconds).toBeGreaterThanOrEqual(45 * 60);
    expect(await h.host.exists(join(h.worktrees, repo))).toBe(false);
  });

  it("defers on exit 75 or a failed exit that says rate limit, but never on words in a clean exit's summary", async () => {
    fixable();
    h.world.omp = { kind: "exit", result: { status: 75, stdout: "", stderr: "" } };
    expect((await runGreenDefaultBranch(ctx, repo, false)).state).toBe("deferred");

    fixable();
    h.world.omp = { kind: "exit", result: { status: 1, stdout: "", stderr: "provider: HTTP 429 rate limit" } };
    const limited = await runGreenDefaultBranch(ctx, repo, false);
    expect(limited.state).toBe("deferred");
    expect(limited.evidence).toContain("429");
    expect(pushedBranch()).toBe(false);

    // FIXED: the old check scanned stdout for "429" and "rate limit", so a clean run that mentioned them was thrown away.
    fixable();
    h.world.omp = {
      kind: "exit",
      result: { status: 0, stdout: "fixed the rate limit test on line 429\n", stderr: "" },
    };
    expect((await runGreenDefaultBranch(ctx, repo, false)).state).toBe("awaiting-merge");
    expect(pushedBranch()).toBe(true);
  });

  it("records needs-human with the reason when the push fails", async () => {
    fixable();
    h.world.failPush = true;
    const run = await runGreenDefaultBranch(ctx, repo, false);
    expect(run.state).toBe("needs-human");
    expect(run.needsHuman).toContain("remote rejected");
    expect(lineMatches("pr create")).toBe(false);
  });

  it("defers a fix, without launching omp, once the day's agent time is used", async () => {
    fixable();
    await writeFile(
      join(h.stateDir, "events.jsonl"),
      `${
        JSON.stringify({
          at: h.host.now().toISOString(),
          runId: "rg-seed",
          nameWithOwner: "",
          from: "",
          to: "notify",
          evidence: "seed",
          elapsedSeconds: 6 * 60 * 60,
        })
      }\n`,
    );
    await sweep(false);
    expect(row(await loadState(), repo).state).toBe("deferred");
    expect(h.ompRuns()).toEqual([]);
  });

  it("counts the agent day by local calendar day", () => {
    const now = new Date(2026, 9, 25, 23, 59);
    const at = (date: Date) => date.toISOString();
    const event = (date: Date, elapsedSeconds: number) => ({
      at: at(date),
      runId: "r",
      nameWithOwner: "a/b",
      from: "",
      to: "fixing",
      evidence: "",
      elapsedSeconds,
    });
    const events = [event(new Date(2026, 9, 25, 0, 5), 600), event(new Date(2026, 9, 24, 23, 55), 9000)];
    expect(agentMsToday(events, now)).toBe(600_000);
    expect(agentCapReached(6 * 3600 * 1000)).toBe(true);
    expect(agentCapReached(5 * 3600 * 1000 + 14 * 60 * 1000)).toBe(false);
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("resumes the branch of an open ci-green pull request instead of starting a new one", async () => {
    fixable({ openFix: { number: 3, branch: "ci-green/2026-10-24", headSha: "bbb" } });
    await runGreenDefaultBranch(ctx, repo, false);
    expect(gitCalls().some((args) => args[0] === "checkout" && args.includes("ci-green/2026-10-24"))).toBe(true);
    expect(Object.keys(h.world.refs[repo] ?? {})).toEqual(["refs/heads/ci-green/2026-10-24"]);
  });
});

describe("green_default_branch: landing", () => {
  const land = (extra: Partial<RepoFixture> = {}): RepoFixture => ({
    push: true,
    rollup: "FAILURE",
    headSha: "oldsha",
    workflows: ["ci"],
    jobs: [codeJob()],
    diff: "diff --git a/a.txt b/a.txt\n",
    checks: ["pass"],
    mergeViews: [{ state: "OPEN", mergeStateStatus: "CLEAN", url: "https://github.com/acme/land/pull/7" }],
    ...extra,
  });
  const merges = () => h.world.calls.filter((call) => call.bin === GH_BIN && call.args[0] === "pr" && call.args[1] === "merge");

  it("squash-merges the judged head with --match-head-commit and never arms auto-merge", async () => {
    h.world.prNumber = 7;
    h.world.repos = { "acme/land": land() };
    await sweep(false);
    expect(row(await loadState(), "acme/land").state).toBe("awaiting-merge");
    expect(merges().map((call) => call.args)).toEqual([[
      "pr",
      "merge",
      "7",
      "--repo",
      "acme/land",
      "--squash",
      "--match-head-commit",
      GATE_HEAD,
    ]]);
    expect(lineMatches("--auto")).toBe(false);
  });

  it("hands a pull request that is not settled approved to make_pr_mergable and records its report, never needs-human", async () => {
    h.world.prNumber = 8;
    h.world.driven = {
      urls: [],
      exitCode: 1,
      text: "https://github.com/acme/blocked/pull/8 @ abc: blocked\n  - the run spent its budget: 3 failed rounds from abc",
    };
    h.world.repos = { "acme/blocked": land({ gateMergeState: "BLOCKED", mergeViews: undefined }) };
    await sweep(false);
    const state = await loadState();
    expect(h.world.driven.urls).toEqual(["https://github.com/acme/blocked/pull/8"]);
    expect(row(state, "acme/blocked").state).toBe("unfixed");
    expect(row(state, "acme/blocked").lastEvent).toContain("spent its budget");
    expect(merges()).toEqual([]);
  });

  it("a drive that merged the pull request is awaiting-merge, and the squash is read back", async () => {
    h.world.prNumber = 8;
    h.world.driven = { urls: [], exitCode: 0, text: "merged" };
    h.world.repos = { "acme/blocked": land({ gateMergeState: "BLOCKED", mergeViews: undefined }) };
    await sweep(false);
    expect(row(await loadState(), "acme/blocked").state).toBe("awaiting-merge");
    expect(h.world.driven.urls).toHaveLength(1);
  });

  it("keeps the default branch unfixed when the pull request merges and the rollup stays FAILURE", async () => {
    h.world.prNumber = 9;
    h.world.repos = {
      "acme/trust": land({
        mergeViews: [{
          state: "MERGED",
          mergeStateStatus: "CLEAN",
          mergeCommit: "squashsha",
          url: "https://github.com/acme/trust/pull/9",
        }],
      }),
    };
    await sweep(false);
    const landed = row(await loadState(), "acme/trust");
    expect(landed.state).toBe("unfixed");
    expect(landed.lastEvent).toContain("FAILURE");
    expect(landed.lastEvent).toContain("oldsha");
    expect(landed.lastEvent).toContain("squashsha");
  });

  it("records green only when the default branch's head is the squash commit and its fresh rollup is SUCCESS", async () => {
    h.world.prNumber = 9;
    h.world.repos = {
      "acme/trust": land({
        rollup: "FAILURE",
        mergeViews: [{ state: "MERGED", mergeStateStatus: "CLEAN", mergeCommit: "squashsha" }],
      }),
    };
    // After the merge the default branch reads green on the squash commit.
    let reads = 0;
    const realExec = h.host.exec;
    h.host.exec = async (bin, args, opts) => {
      const result = await realExec(bin, args, opts);
      if (bin === GH_BIN && args[1] === "graphql" && args.some((arg) => arg === "name=trust")) {
        reads += 1;
        // The first read is the triage read; every later read follows the merge and sees the squash commit.
        if (reads >= 1) {
          const repoFx = h.world.repos["acme/trust"] as RepoFixture;
          repoFx.rollup = "SUCCESS";
          repoFx.headSha = "squashsha";
        }
      }
      return result;
    };
    const run = await runGreenDefaultBranch(ctx, "acme/trust", false);
    expect(run.state).toBe("green");
    expect(run.exitCode).toBe(0);
    expect(row(await loadState(), "acme/trust").lastEvent).toContain("squashsha");
  });

  it("re-reads an awaiting-merge from an earlier run, writing green only when HEAD is the squash merge", async () => {
    h.world.repos = {
      "acme/matched": {
        push: true,
        rollup: "SUCCESS",
        headSha: "squashsha",
        workflows: ["ci"],
        mergeViews: [{ state: "MERGED", mergeStateStatus: "CLEAN", mergeCommit: "squashsha" }],
      },
      "acme/drifted": {
        push: true,
        rollup: "SUCCESS",
        headSha: "othersha",
        workflows: ["ci"],
        mergeViews: [{ state: "MERGED", mergeStateStatus: "CLEAN", mergeCommit: "squashsha" }],
      },
    };
    await seed({
      "acme/matched": { state: "awaiting-merge", prUrl: "https://github.com/acme/matched/pull/3" },
      "acme/drifted": { state: "awaiting-merge", prUrl: "https://github.com/acme/drifted/pull/4" },
    });
    await sweep(false);
    const state = await loadState();
    expect(row(state, "acme/matched").state).toBe("green");
    expect(row(state, "acme/matched").lastEvent).toContain("squashsha");
    expect(row(state, "acme/drifted").state).toBe("unfixed");
    expect(row(state, "acme/drifted").lastEvent).toContain("othersha");
    expect(h.ompRuns()).toEqual([]);
  });

  it("a blocked or conflicting pull request left awaiting merge needs a person", async () => {
    h.world.repos = {
      "acme/dirty": {
        push: true,
        rollup: "SUCCESS",
        workflows: ["ci"],
        mergeViews: [{ state: "OPEN", mergeStateStatus: "DIRTY" }],
      },
    };
    await seed({ "acme/dirty": { state: "awaiting-merge", prUrl: "https://github.com/acme/dirty/pull/4" } });
    const run = await runGreenDefaultBranch(ctx, "acme/dirty", false);
    expect(run.state).toBe("needs-human");
    expect(run.needsHuman).toBe("merge DIRTY");
  });

  it("records needs-human only when the pull request cannot be created", async () => {
    h.world.repos = { "acme/nopr": land({ createFails: "GraphQL: not allowed" }) };
    const run = await runGreenDefaultBranch(ctx, "acme/nopr", false);
    expect(run.state).toBe("needs-human");
    expect(run.needsHuman).toBe("pr create failed: GraphQL: not allowed");
  });

  it("refuses a pr create that printed no pull request URL instead of judging an undefined pull request", async () => {
    h.world.repos = { "acme/odd": land({ createPrints: "Creating pull request...\n" }) };
    const run = await runGreenDefaultBranch(ctx, "acme/odd", false);
    expect(run.state).toBe("needs-human");
    expect(run.needsHuman).toContain("printed no pull request URL");
    expect(merges()).toEqual([]);
  });

  it("takes the already open pull request for the branch instead of creating another", async () => {
    h.world.prNumber = 3;
    h.world.repos = {
      "acme/resume": land({
        openFix: { number: 3, branch: "ci-green/2026-10-24", headSha: "bbb" },
        mergeViews: [{ state: "OPEN", mergeStateStatus: "CLEAN", url: "https://github.com/acme/resume/pull/3" }],
      }),
    };
    await runGreenDefaultBranch(ctx, "acme/resume", false);
    expect(lineMatches("pr create")).toBe(false);
    expect(merges()).toHaveLength(1);
  });

  it("triages a repository fresh whatever its ledger row says: needs-human or a run of failed days is fixed next", async () => {
    h.world.repos = { "acme/human": land(), "acme/tired": land() };
    const earlier = (name: string, to: string, day: string) =>
      JSON.stringify({
        at: `2026-10-${day}T15:00:00.000Z`,
        runId: "rg-seed",
        nameWithOwner: name,
        from: "",
        to,
        evidence: "still red",
        defaultBranch: "main",
      });
    await writeFile(
      join(h.stateDir, "events.jsonl"),
      `${
        [
          earlier("acme/human", "needs-human", "25"),
          ...["21", "22", "23", "24"].map((day) => earlier("acme/tired", "unfixed", day)),
        ].join("\n")
      }\n`,
    );
    const human = await runGreenDefaultBranch(ctx, "acme/human", false);
    const tired = await runGreenDefaultBranch(ctx, "acme/tired", false);
    expect(human.state).toBe("awaiting-merge");
    expect(tired.state).toBe("awaiting-merge");
    expect(h.ompRuns()).toHaveLength(2);
  });

  it("a dry run never launches omp, reruns a job, opens a pull request, merges, or upgrades a dependency", async () => {
    h.world.repos = {
      "acme/code": { push: true, rollup: "FAILURE", workflows: ["ci"], jobs: [codeJob()], diff: "diff --git a/a b/a\n" },
      "acme/flaky": {
        push: true,
        rollup: "FAILURE",
        workflows: ["ci"],
        jobs: [codeJob({ name: "test", previous: "success", runId: 61 })],
      },
      "acme/green": {
        push: true,
        rollup: "SUCCESS",
        workflows: ["ci"],
        pulls: [{
          number: 5,
          url: "https://github.com/acme/green/pull/5",
          title: "bump",
          author: { login: "app/renovate" },
          labels: [],
        }],
      },
      "acme/hold": {
        push: true,
        rollup: "SUCCESS",
        headSha: "squashsha",
        workflows: ["ci"],
        mergeViews: [{ state: "MERGED", mergeStateStatus: "CLEAN", mergeCommit: "squashsha" }],
      },
    };
    await seed({ "acme/hold": { state: "awaiting-merge", prUrl: "https://github.com/acme/hold/pull/4" } });

    const report = await sweep(true);
    const state = await loadState();

    expect(report.exitCode).toBe(1);
    expect(row(state, "acme/code").state).toBe("queued");
    expect(row(state, "acme/flaky").state).toBe("queued");
    expect(row(state, "acme/green").state).toBe("green");
    expect(h.ompRuns()).toEqual([]);
    expect(h.world.upgraded).toEqual([]);
    for (const forbidden of ["run rerun", "pr create", "pr merge", "checkout -B", "git push"]) {
      expect(lineMatches(forbidden)).toBe(false);
    }
  });
});

describe("green_default_branch: dependency upgrades", () => {
  const dependabot = (number: number, labels: string[], login = "app/dependabot"): PullFixture => ({
    number,
    url: `https://github.com/acme/deps/pull/${number}`,
    title: `bump ${number}`,
    author: { login },
    labels: labels.map((name) => ({ name })),
  });

  it("does nothing unless the recorded state is green", async () => {
    h.world.repos = {
      "acme/deps": {
        push: true,
        rollup: "SUCCESS",
        workflows: ["ci"],
        pulls: [dependabot(11, []), dependabot(12, ["ai:dependencies-checked"]), dependabot(13, [], "octocat")],
      },
    };
    const red = await upgradeBotDependencyPrsMissingCheckedLabel(ctx, { nameWithOwner: "acme/deps" }, { state: "unfixed" });
    expect(red.pulls).toEqual([]);
    expect(red.skipped).toContain("not green");
    expect(h.world.calls).toEqual([]);

    const green = await upgradeBotDependencyPrsMissingCheckedLabel(ctx, { nameWithOwner: "acme/deps" }, { state: "green" });
    expect(green.pulls).toEqual([
      { url: "https://github.com/acme/deps/pull/11", verdict: "ready", reason: "upgrade_dependency verdict ready" },
    ]);
    expect(h.world.upgraded).toEqual(["https://github.com/acme/deps/pull/11"]);
  });

  it("reports a needs_work upgrade with the gates that failed, and an error or a throwing runner as needs_work", async () => {
    h.world.upgrades["https://github.com/acme/deps/pull/11"] = {
      verdict: "needs_work",
      failed: ["ci: https://github.com/acme/deps/pull/11 @ 0123456789: spent"],
    };
    h.world.upgrades["https://github.com/acme/deps/pull/12"] = { error: "upgrade_dependency returned no verdict" };
    h.world.repos = {
      "acme/deps": { push: true, rollup: "SUCCESS", workflows: ["ci"], pulls: [dependabot(11, []), dependabot(12, []), dependabot(13, [])] },
    };
    const upgrade = ctx.upgrade;
    ctx.upgrade = async (url) => {
      if (url.endsWith("/13")) throw new Error("omp failed to start: ENOENT");
      return upgrade(url);
    };
    const result = await upgradeBotDependencyPrsMissingCheckedLabel(ctx, { nameWithOwner: "acme/deps" }, { state: "green" });
    expect(result.pulls).toEqual([
      {
        url: "https://github.com/acme/deps/pull/11",
        verdict: "needs_work",
        reason: "upgrade_dependency verdict needs_work: ci: https://github.com/acme/deps/pull/11 @ 0123456789: spent",
      },
      { url: "https://github.com/acme/deps/pull/12", verdict: "needs_work", reason: "upgrade_dependency returned no verdict" },
      {
        url: "https://github.com/acme/deps/pull/13",
        verdict: "needs_work",
        reason: "upgrade_dependency could not run: omp failed to start: ENOENT",
      },
    ]);
  });

  it("upgrades org-prefixed Renovate bot pull requests such as app/sah-renovate-bot, and lists them on a dry run", async () => {
    h.world.repos = {
      "sah/isa-platform": {
        push: true,
        rollup: "SUCCESS",
        workflows: ["ci"],
        pulls: [{
          number: 732,
          url: "https://github.com/sah/isa-platform/pull/732",
          title: "chore(deps): update module golang.org/x/net to v0.62.0 [security]",
          author: { login: "app/sah-renovate-bot" },
          labels: [{ name: "security" }],
        }],
      },
    };
    const dry = await runGreenDefaultBranch(ctx, "sah/isa-platform", true);
    expect(dry.pulls).toEqual([
      { url: "https://github.com/sah/isa-platform/pull/732", verdict: "skipped", reason: "dry run" },
    ]);
    expect(h.world.upgraded).toEqual([]);
    const live = await runGreenDefaultBranch(ctx, "sah/isa-platform", false);
    expect(live.pulls[0]?.verdict).toBe("ready");
    expect(h.world.upgraded).toEqual(["https://github.com/sah/isa-platform/pull/732"]);
  });

  it("keeps the recorded state and says why when the pull requests cannot be read", async () => {
    h.world.repos = { "acme/deps": { push: true, rollup: "SUCCESS", workflows: ["ci"] } };
    const realExec = h.host.exec;
    h.host.exec = async (bin, args, opts) =>
      bin === GH_BIN && args[0] === "pr" && args[1] === "list" && args.includes("number,url,title,author,labels")
        ? { status: 1, stdout: "", stderr: "gh: HTTP 502" }
        : realExec(bin, args, opts);
    const run = await runGreenDefaultBranch(ctx, "acme/deps", false);
    // FIXED: a failed upgrade read used to blank the state and turn a green repository into `unclassified`, exit 1.
    expect(run.state).toBe("green");
    expect(run.exitCode).toBe(0);
    expect(run.skipped).toContain("HTTP 502");
  });

  describe("the upgrade_dependency runner", () => {
    const end = (details: unknown, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: UPGRADE_TOOL, result: { content: [], details }, ...extra });

    it("reads the verdict and the failed gates from the tool's own details, never from the model's words", () => {
      const stream = [
        JSON.stringify({ type: "session", id: "s" }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "verdict: ready" }] } }),
        end({
          verdict: "needs_work",
          gates: [
            { name: "lockfile", verdict: "passed", observed: "ok" },
            { name: "ci", verdict: "failed", observed: "red" },
            { name: "facade", verdict: "not_proven", observed: "n/a" },
          ],
        }),
      ].join("\n");
      expect(reportOfEvents(stream)).toEqual({ verdict: "needs_work", failed: ["ci: red"] });
    });

    it("fails explicitly on a missing call, a tool error, or details of another shape", () => {
      expect(reportOfEvents("")).toEqual({ error: "omp never finished a upgrade_dependency call" });
      expect(reportOfEvents(JSON.stringify({ type: "tool_execution_end", toolName: "read", result: {} }))).toMatchObject({ error: expect.any(String) });
      expect(reportOfEvents(end({ verdict: "maybe" }))).toEqual({ error: "upgrade_dependency returned no verdict" });
      expect(reportOfEvents(end(undefined))).toEqual({ error: "upgrade_dependency returned no verdict" });
      const failed = JSON.stringify({
        type: "tool_execution_end",
        toolName: UPGRADE_TOOL,
        isError: true,
        result: { content: [{ type: "text", text: "no push access" }] },
      });
      expect(reportOfEvents(failed)).toEqual({ error: "upgrade_dependency failed: no push access" });
    });

    it("spawns omp headless in json mode on a private prompt file, and removes the file", async () => {
      const seen: { args: string[]; cwd?: string; prompt: string }[] = [];
      const host = {
        ...h.host,
        exec: async (_bin: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => {
          const file = (args[1] ?? "").slice(1);
          seen.push({ args, cwd: opts?.cwd, prompt: await readFile(file, "utf8") });
          return { status: 0, stdout: `${end({ verdict: "ready", gates: [] })}\n`, stderr: "" };
        },
      };
      const report = await ompUpgradeRunner(host)("https://github.com/acme/deps/pull/11");
      expect(report).toEqual({ verdict: "ready", failed: [] });
      const call = seen[0]!;
      expect(call.args.slice(0, 1)).toEqual(["-p"]);
      expect(call.args).toContain("--mode");
      expect(call.args[call.args.indexOf("--mode") + 1]).toBe("json");
      expect(call.args).not.toContain("--config");
      expect(call.prompt).toContain(UPGRADE_TOOL);
      expect(call.prompt).toContain("https://github.com/acme/deps/pull/11");
      expect(await host.exists(call.args[1]!.slice(1))).toBe(false);
    });

    it("reports a timed-out or crashed omp as an error, not as a verdict", async () => {
      const timedOut = { ...h.host, exec: async () => ({ status: 143, stdout: "", stderr: "", timedOut: true }) };
      expect(await ompUpgradeRunner(timedOut)("https://github.com/a/b/pull/1")).toEqual({
        error: "omp did not finish upgrade_dependency in time",
      });
      const crashed = { ...h.host, exec: async () => ({ status: 2, stdout: "", stderr: "no provider" }) };
      const report = await ompUpgradeRunner(crashed)("https://github.com/a/b/pull/1");
      expect(report).toMatchObject({ error: expect.stringContaining("omp exited 2: no provider") });
    });
  });
});

describe("green_default_branch: a sweep", () => {
  const rank = () => ({
    "a/green": { push: true, rollup: "SUCCESS", workflows: ["ci"] },
    "m/down": { push: true, rollupStatus: 503, rollup: "ABSENT", workflows: ["ci"] },
    "y/error": { push: true, rollup: "ERROR", workflows: ["ci"], jobs: [codeJob()] },
    "z/red": { push: true, rollup: "FAILURE", workflows: ["ci"], jobs: [codeJob()] },
  } satisfies Record<string, RepoFixture>);

  it("orders a live-red repository before a green one and treats an unreadable rollup as not red", async () => {
    h.world.repos = rank();
    const ordered = await orderRedFirstByLiveRollup(
      ctx,
      ["a/green", "m/down", "y/error", "z/red"].map((nameWithOwner) => ({ nameWithOwner })),
    );
    expect(ordered.map((repo) => repo.nameWithOwner)).toEqual(["y/error", "z/red", "a/green", "m/down"]);
    expect(await readEvents(h.host)).toEqual([]);
  });

  it("reports the repositories red first, one line each", async () => {
    h.world.repos = rank();
    const report = await runGreenRepositories(ctx, { kind: "all" }, true);
    expect(report.text.split("\n").map((line) => line.split(":")[0])).toEqual(["y/error", "z/red", "a/green", "m/down"]);
    expect(report.exitCode).toBe(1);
  });

  it("runs only one owner's repositories and lists only that owner's exclusions", async () => {
    h.world.orgs = ["acme"];
    h.world.repos = {
      "acme/lib": { org: "acme", push: true, rollup: "SUCCESS", workflows: ["ci"] },
      "acme/old": { org: "acme", push: true, archived: true, rollup: "SUCCESS", workflows: ["ci"] },
      "octocat/alive": { push: true, rollup: "SUCCESS", workflows: ["ci"] },
      "octocat/old": { push: true, archived: true, rollup: "SUCCESS", workflows: ["ci"] },
    };
    const report = await runGreenRepositories(ctx, { kind: "owner", owner: "acme" }, true);
    expect(report.exitCode).toBe(0);
    expect(report.text.split("\n")).toEqual(["acme/lib: green (statusCheckRollup SUCCESS)", "acme/old: excluded (archived)"]);
    expect((await readEvents(h.host)).some((event) => event.nameWithOwner === "octocat/alive")).toBe(false);
  });

  it("fails an owner that has nothing to green rather than passing silently", async () => {
    h.world.repos = { "octocat/alive": { push: true, rollup: "SUCCESS", workflows: ["ci"] } };
    const report = await runGreenRepositories(ctx, { kind: "owner", owner: "nobody" }, true);
    expect(report.exitCode).toBe(1);
    expect(report.text).toBe("no pushable repositories to green for nobody");
  });

  it("greens at most three repositories at a time", async () => {
    h.world.repos = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f"].map((name) => [`acme/${name}`, { push: true, rollup: "SUCCESS", workflows: ["ci"] }]),
    );
    const active = new Set<string>();
    let peak = 0;
    const realExec = h.host.exec;
    h.host.exec = async (bin, args, opts) => {
      const reads = args.find((arg) => /^repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(arg));
      if (bin === GH_BIN && reads !== undefined) {
        active.add(reads);
        peak = Math.max(peak, active.size);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (bin === GH_BIN && args[0] === "pr" && args[1] === "list") {
        active.delete(`repos/${args[args.indexOf("--repo") + 1]}/actions/workflows`);
      }
      return realExec(bin, args, opts);
    };
    const report = await runGreenRepositories(ctx, { kind: "all" }, true);
    expect(report.exitCode).toBe(0);
    expect(report.text.split("\n")).toHaveLength(6);
    expect(peak).toBe(3);
  });

  it("reports a repository its fixes could not land in its text and exit code, and posts nothing", async () => {
    h.world.prNumber = 8;
    h.world.driven = { urls: [], exitCode: 1, text: "https://github.com/acme/blocked/pull/8 @ abc: blocked" };
    h.world.repos = {
      "acme/blocked": {
        push: true,
        rollup: "FAILURE",
        workflows: ["ci"],
        jobs: [codeJob()],
        diff: "diff --git a/a.txt b/a.txt\n",
        checks: ["pass"],
        gateMergeState: "BLOCKED",
      },
      "acme/fine": { push: true, rollup: "SUCCESS", workflows: ["ci"] },
    };
    const report = await runGreenRepositories(ctx, { kind: "all" }, false);
    expect(report.exitCode).toBe(1);
    const blocked = report.text.split("\n").find((line) => line.startsWith("acme/blocked: "));
    expect(blocked).toMatch(/^acme\/blocked: unfixed \(.*acme\/blocked\/pull\/8 @ abc: blocked/);
    expect(report.text).toContain("acme/fine: green");
    expect(h.world.calls.filter((call) => call.bin === "osascript" || call.bin === "agentmux")).toEqual([]);
  });

  it("a cancelled run stops instead of recording every remaining repository as an error", async () => {
    h.world.repos = rank();
    const realExec = h.host.exec;
    h.host.exec = async (bin, args, opts) => {
      if (bin === GH_BIN && args[0] === "api" && args[1]?.endsWith("/actions/workflows")) {
        throw new Error("gh api was cancelled");
      }
      return realExec(bin, args, opts);
    };
    await expect(runGreenRepositories(ctx, { kind: "all" }, true)).rejects.toThrow("was cancelled");
  });
});

describe("green_default_branch: the host", () => {
  it("stops a command at its timeout and says so", async () => {
    const host = shellHost();
    const result = await host.exec("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.status).not.toBe(0);
  });

  it("kills the child and rejects when the run is cancelled, and refuses to start once cancelled", async () => {
    const controller = new AbortController();
    const host = shellHost(controller.signal);
    const pending = host.exec("node", ["-e", "setTimeout(() => {}, 5000)"]);
    controller.abort();
    await expect(pending).rejects.toThrow("was cancelled");
    await expect(host.exec("node", ["-e", "0"])).rejects.toThrow("cancelled");
    await expect(host.sleep(10)).rejects.toThrow("cancelled");
  });

  it("returns stdout, stderr and the exit status of a finished command", async () => {
    const result = await shellHost().exec("node", [
      "-e",
      "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)",
    ]);
    expect(result).toMatchObject({ status: 3, stdout: "out\n", stderr: "err\n" });
  });
});

describe("green_default_branch: the tool", () => {
  const chain = (): unknown => new Proxy(function () {}, { get: () => chain(), apply: () => chain() });
  const pi = { zod: { object: () => chain(), string: () => chain(), boolean: () => chain() }, cwd: "/tmp" } as never;

  it("parses targets: all, an owner, owner/name, a repository URL; refuses a pull request URL and junk", () => {
    expect(parseTarget("all")).toEqual({ kind: "sweep", filter: { kind: "all" } });
    expect(parseTarget(" ALL ")).toEqual({ kind: "sweep", filter: { kind: "all" } });
    expect(parseTarget("acme")).toEqual({ kind: "sweep", filter: { kind: "owner", owner: "acme" } });
    expect(parseTarget("acme/lib")).toEqual({ kind: "repository", nameWithOwner: "acme/lib" });
    expect(parseTarget("https://github.com/acme/lib")).toEqual({ kind: "repository", nameWithOwner: "acme/lib" });
    expect(parseTarget("https://github.com/acme/lib.git/")).toEqual({ kind: "repository", nameWithOwner: "acme/lib" });
    expect(() => parseTarget("https://github.com/acme/lib/pull/4")).toThrow("make_pr_mergable");
    expect(() => parseTarget("")).toThrow("target is empty");
    expect(() => parseTarget("a/b/c")).toThrow("not `all`");
    expect(() => parseTarget("acme/..")).toThrow("not a valid owner/name");
    expect(() => parseTarget("-bad")).toThrow("not `all`");
  });

  it("describes itself in the house style: 80 to 250 words, with side effects and the exit rule", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const needle of ["make_pr_mergable", "upgrade_dependency", "dryRun", "model quota", "exitCode"]) {
      expect(DESCRIPTION).toContain(needle);
    }
  });

  it("runs one repository through execute and returns the line, the exit code and typed details", async () => {
    h.world.repos = { "acme/lib": { push: true, rollup: "SUCCESS", workflows: ["ci"] } };
    const tool = buildTool(pi, { host: () => h.host, upgrade: () => h.upgrade, drive: () => h.drive });
    expect(tool.name).toBe("green_default_branch");
    const result = await tool.execute("id", { target: "acme/lib", dryRun: true }, undefined, undefined as never, undefined);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "acme/lib: green (statusCheckRollup SUCCESS)\nexitCode 0",
    });
    expect(result.details).toMatchObject({ kind: "repository", exitCode: 0, dryRun: true, target: "acme/lib" });
  });

  it("runs a sweep through execute, reports needs-human and upgrade verdicts, and treats a null dryRun as false", async () => {
    h.world.repos = {
      "acme/deps": {
        push: true,
        rollup: "SUCCESS",
        workflows: ["ci"],
        pulls: [{
          number: 2,
          url: "https://github.com/acme/deps/pull/2",
          title: "bump",
          author: { login: "dependabot[bot]" },
          labels: [],
        }],
      },
    };
    const tool = buildTool(pi, { host: () => h.host, upgrade: () => h.upgrade, drive: () => h.drive });
    const result = await tool.execute("id", { target: "acme", dryRun: null }, undefined, undefined as never, undefined);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("acme/deps: green (statusCheckRollup SUCCESS)");
    expect(text).toContain("acme/deps: https://github.com/acme/deps/pull/2: ready (upgrade_dependency verdict ready)");
    expect(text.endsWith("exitCode 0")).toBe(true);
    expect(result.details).toMatchObject({ kind: "sweep", dryRun: false, exitCode: 0 });
  });

  it("refuses a malformed target at the schema boundary without any port call, and accepts an owner and owner/name", () => {
    let check: ((v: string) => boolean) | undefined;
    const rec = (): unknown =>
      new Proxy(function () {}, {
        get: (_t, key) => (key === "refine" ? (fn: (v: string) => boolean) => ((check = fn), rec()) : rec()),
        apply: () => rec(),
      });
    const recPi = { zod: { object: () => rec(), string: () => rec(), boolean: () => rec() }, cwd: "/tmp" } as never;
    buildTool(recPi, { host: () => h.host, upgrade: () => h.upgrade, drive: () => h.drive });
    expect(check).toBeDefined();
    for (const bad of ["a/b/c", "-bad", "has space", "acme/", "/lib", "x".repeat(40)]) {
      expect(check?.(bad)).toBe(false);
    }
    for (const good of ["acme", "acme-co", "acme/lib", "acme/lib.js", "all"]) {
      expect(check?.(good)).toBe(true);
    }
    expect(h.world.calls).toEqual([]);
  });

  it("fails on a bad target before touching GitHub, and sends heartbeats while it works", async () => {
    const tool = buildTool(pi, { host: () => h.host, upgrade: () => h.upgrade, drive: () => h.drive });
    await expect(tool.execute("id", { target: "a/b/c" }, undefined, undefined as never, undefined)).rejects.toThrow();
    expect(h.world.calls).toEqual([]);
    expect(renderRun({ nameWithOwner: "a/b", exitCode: 1, state: "needs-human", evidence: "x  y", needsHuman: "why", pulls: [] })).toBe(
      "a/b: needs-human (x y)\n  needs a person: why",
    );
  });
});
