/**
 * A fake GitHub, git and omp for the tests: `gh`, `git` and `omp` answer from `World` fixtures, the clock is virtual, and
 * the ledger and clones live in real temporary directories. Nothing here reaches a network, a model or a real
 * repository. Not a tool module and not a test: `bun test` ignores it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GH_BIN, OMP_BIN } from "./constants.js";
import type { DrivePr } from "./context.js";
import { type CommandResult, type Host, shellHost } from "./host.js";
import type { UpgradeReport, UpgradeRunner } from "./upgrade_runner.js";

export type JobFixture = {
  type: "check" | "status";
  name: string;
  conclusion: string;
  workflow?: string;
  runId?: number;
  logUrl?: string;
  previous?: string | null;
};

export type MergeView = { state: string; mergeStateStatus: string; mergeCommit?: string; url?: string };

export type PullFixture = {
  number: number;
  url: string;
  title: string;
  author: { login: string };
  labels: { name: string }[];
};

export type RepoFixture = {
  org?: string;
  archived?: boolean;
  fork?: boolean;
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  defaultBranch?: string;
  workflowsStatus?: number;
  workflows?: string[];
  rollupStatus?: number;
  rollup?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | "ABSENT";
  headSha?: string;
  jobs?: JobFixture[];
  diff?: string;
  mergeViews?: MergeView[];
  checks?: string[];
  /** The ci-green pull request's mergeStateStatus when the settled-approved gate reads it. */
  gateMergeState?: string;
  /** Unresolved review threads on the ci-green pull request when the gate reads it. */
  openThreads?: number;
  mergeStatus?: number;
  rerunStatus?: number;
  rerunConclusion?: "SUCCESS" | "FAILURE" | "PENDING";
  /** Open pull requests `gh pr list` returns for the dependency-upgrade read. */
  pulls?: PullFixture[];
  /** An open `ci-green/` pull request an earlier run left, as `gh pr list` reports it. */
  openFix?: { number: number; branch: string; headSha: string };
  /** What `gh pr create` fails with, when set. */
  createFails?: string;
  /** What `gh pr create` prints instead of a pull request URL. */
  createPrints?: string;
};

export type Command = { bin: string; args: string[]; cwd?: string };

/** The head SHA of every ci-green pull request the settled-approved gate reads. */
export const GATE_HEAD = "a".repeat(40);

export type OmpBehaviour =
  | { kind: "exit"; result: CommandResult }
  | { kind: "hang" }
  | { kind: "run"; run: (cwd: string) => CommandResult };

export class World {
  calls: Command[] = [];
  repos: Record<string, RepoFixture> = {};
  orgs: string[] = [];
  views: Record<string, number> = {};
  refs: Record<string, Record<string, string>> = {};
  originHeadAtPush: Record<string, CommandResult> = {};
  hookCodes: number[] = [];
  killed: number[] = [];
  forbidPush = false;
  prNumber = 7;
  failFetch = false;
  failSetHead = false;
  failPush = false;
  omp: OmpBehaviour = { kind: "exit", result: { status: 0, stdout: "done\n", stderr: "" } };
  /** What the upgrade runner answers, per pull request URL; the default is `ready`. */
  upgrades: Record<string, UpgradeReport> = {};
  upgraded: string[] = [];
  /** What the make_pr_mergable drive answers. */
  driven = { urls: [] as string[], exitCode: 1, text: "blocked" };
  /** When set, a failing listing. */
  listFails = false;
  startMs = Date.parse("2026-10-25T16:00:00.000Z");
  elapsedMs = 0;
}

export type Harness = {
  world: World;
  host: Host;
  upgrade: UpgradeRunner;
  drive: DrivePr;
  stateDir: string;
  worktrees: string;
  lines(): string[];
  ompRuns(): Command[];
  cleanup(): Promise<void>;
};

export async function makeHarness(): Promise<Harness> {
  const world = new World();
  const stateDir = await mkdtemp(join(tmpdir(), "green-default-branch-state-"));
  const worktrees = await mkdtemp(join(tmpdir(), "green-default-branch-work-"));
  const base = shellHost();
  const host: Host = {
    ...base,
    exec: async (bin, args, opts) => {
      world.calls.push({ bin, args: [...args], cwd: opts?.cwd });
      const pid = 200_000 + world.calls.length;
      opts?.onPid?.(pid);
      await Promise.resolve();
      return answer(world, bin, [...args], opts?.cwd);
    },
    now: () => new Date(world.startMs + world.elapsedMs),
    sleep: async (ms: number) => {
      world.elapsedMs += ms;
      await delay(1);
    },
    stateDir: () => stateDir,
    worktrees: () => worktrees,
    kill: async (pid: number) => {
      world.killed.push(pid);
    },
  };
  return {
    world,
    host,
    upgrade: async (url) => {
      world.upgraded.push(url);
      return world.upgrades[url] ?? { verdict: "ready", failed: [] };
    },
    drive: async (url) => {
      world.driven.urls.push(url);
      return { exitCode: world.driven.exitCode, text: world.driven.text };
    },
    stateDir,
    worktrees,
    lines: () => world.calls.map((call) => [call.bin, ...call.args].join(" ")),
    ompRuns: () => world.calls.filter((call) => call.bin === OMP_BIN && call.args[0] === "-p"),
    cleanup: async () => {
      await rm(stateDir, { recursive: true, force: true });
      await rm(worktrees, { recursive: true, force: true });
    },
  };
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

const json = (body: unknown): CommandResult => ({ status: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });
const httpError = (status: number): CommandResult => ({ status: 1, stdout: "", stderr: `HTTP ${status}` });

function listing(name: string, repo: RepoFixture) {
  return {
    full_name: name,
    archived: repo.archived === true,
    fork: repo.fork === true,
    default_branch: repo.defaultBranch ?? "main",
    permissions: {
      admin: repo.admin === true,
      maintain: repo.maintain === true,
      push: repo.push === true,
      triage: false,
    },
  };
}

function rollupBody(name: string, repo: RepoFixture): unknown {
  const headSha = repo.headSha ?? "abc111";
  const branch = repo.defaultBranch ?? "main";
  if ((repo.rollup ?? "SUCCESS") === "ABSENT") {
    return {
      data: { repository: { defaultBranchRef: { name: branch, target: { oid: headSha, statusCheckRollup: null } } } },
    };
  }
  const nodes = (repo.jobs ?? []).map((job) => {
    if (job.type === "status") {
      return {
        __typename: "StatusContext",
        context: job.name,
        state: job.conclusion,
        targetUrl: job.logUrl ?? `https://example.test/${job.name}`,
      };
    }
    return {
      __typename: "CheckRun",
      name: job.name,
      conclusion: job.conclusion,
      detailsUrl: job.logUrl ?? `https://github.com/${name}/actions/runs/${job.runId ?? 1}`,
      status: "COMPLETED",
      checkSuite: { workflowRun: { databaseId: job.runId ?? 1, workflow: { name: job.workflow ?? job.name } } },
    };
  });
  return {
    data: {
      repository: {
        defaultBranchRef: {
          name: branch,
          target: { oid: headSha, statusCheckRollup: { state: repo.rollup ?? "SUCCESS", contexts: { nodes } } },
        },
      },
    },
  };
}

function refusePush(hookPath: string, remoteRef: string): number {
  const result = spawnSync("sh", [hookPath], { input: `a b ${remoteRef} c\n`, encoding: "utf8" });
  return result.status ?? 1;
}

function answerGh(world: World, args: string[]): CommandResult {
  if (args[0] === "api" && args[1] === "user") return json({ login: "octocat" });
  if (args[0] === "api" && args.some((arg) => arg === "user/orgs" || arg.endsWith("user/orgs"))) {
    if (world.listFails) return { status: 1, stdout: "", stderr: "gh: HTTP 401" };
    return json(world.orgs.map((login) => ({ login })));
  }
  const orgArg = args.find((arg) => arg.startsWith("orgs/") && arg.includes("/repos"));
  if (orgArg !== undefined) {
    const org = orgArg.split("/")[1] ?? "";
    const names = Object.entries(world.repos).filter(([, repo]) => repo.org === org).map(([name]) => name);
    return json(names.map((name) => listing(name, world.repos[name] as RepoFixture)));
  }
  if (args.some((arg) => arg.includes("affiliation=owner,collaborator"))) {
    const names = Object.entries(world.repos).filter(([, repo]) => repo.org === undefined).map(([name]) => name);
    return json(names.map((name) => listing(name, world.repos[name] as RepoFixture)));
  }
  const workflowArg = args.find((arg) => arg.includes("/actions/workflows"));
  if (workflowArg !== undefined) {
    const name = workflowArg.slice("repos/".length, workflowArg.indexOf("/actions/workflows"));
    const repo = world.repos[name];
    if (repo === undefined) return httpError(404);
    if ((repo.workflowsStatus ?? 200) !== 200) return httpError(repo.workflowsStatus ?? 500);
    return json({
      workflows: (repo.workflows ?? ["ci"]).map((workflow) => ({
        name: workflow,
        path: `.github/workflows/${workflow}.yml`,
      })),
    });
  }
  if (args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("query PrComments"))) {
    return json([{ data: { repository: { pullRequest: { comments: { nodes: [] } } } } }]);
  }
  if (args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("query PrReviews"))) {
    return json([{ data: { repository: { pullRequest: { reviews: { nodes: [] } } } } }]);
  }
  if (args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("reviewThreads"))) {
    const owner = args.find((arg) => arg.startsWith("owner="))?.slice("owner=".length) ?? "";
    const repoName = args.find((arg) => arg.startsWith("repo="))?.slice("repo=".length) ?? "";
    const repo = world.repos[`${owner}/${repoName}`];
    const nodes = Array.from({ length: repo?.openThreads ?? 0 }, (_, index) => ({
      id: `T${index}`,
      isResolved: false,
      comments: { nodes: [{ body: "fix this", path: "a.txt", url: "", author: { login: "bot[bot]" } }] },
    }));
    return json([{
      data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false } } } } },
    }]);
  }
  const commitRead = args[0] === "api"
    ? args[1]?.match(/^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+(\/check-suites)?$/)
    : null;
  if (commitRead !== null && commitRead !== undefined) {
    return commitRead[1] === undefined
      ? json({ commit: { committer: { date: "2026-10-25T10:00:00Z" } } })
      : json({ check_suites: [] });
  }
  if (args[0] === "api" && args[1] === "graphql") {
    const owner = args.find((arg) => arg.startsWith("owner="))?.slice("owner=".length) ?? "";
    const repoName = args.find((arg) => arg.startsWith("name="))?.slice("name=".length) ?? "";
    const name = `${owner}/${repoName}`;
    const repo = world.repos[name];
    if (repo === undefined) return httpError(404);
    if ((repo.rollupStatus ?? 200) !== 200) return httpError(repo.rollupStatus ?? 500);
    return json(rollupBody(name, repo));
  }
  if (args[0] === "run" && args[1] === "list") {
    const repo = world.repos[flag(args, "--repo")];
    const workflow = flag(args, "--workflow");
    const job = repo?.jobs?.find((item) => (item.workflow ?? item.name) === workflow) ?? repo?.jobs?.[0];
    const current = (job?.conclusion ?? "failure").toLowerCase();
    if (job?.previous === undefined || job.previous === null) return json([{ conclusion: current }]);
    return json([{ conclusion: current }, { conclusion: job.previous.toLowerCase() }]);
  }
  if (args[0] === "run" && args[1] === "rerun") {
    const status = world.repos[flag(args, "--repo")]?.rerunStatus ?? 0;
    return { status, stdout: "", stderr: status === 0 ? "" : "rerun failed" };
  }
  if (args[0] === "run" && args[1] === "view") {
    const mode = world.repos[flag(args, "--repo")]?.rerunConclusion ?? "SUCCESS";
    if (mode === "PENDING") return json({ status: "in_progress", conclusion: null });
    if (mode === "FAILURE") return json({ status: "completed", conclusion: "failure" });
    return json({ status: "completed", conclusion: "success" });
  }
  if (args[0] === "pr" && args[1] === "list") {
    const repo = world.repos[flag(args, "--repo")];
    if (args.includes("--head")) {
      const fix = repo?.openFix;
      return json(fix === undefined || fix.branch !== flag(args, "--head")
        ? []
        : [{ url: `https://github.com/${flag(args, "--repo")}/pull/${fix.number}`, number: fix.number }]);
    }
    if (flag(args, "--json").includes("headRefName")) {
      const fix = repo?.openFix;
      return json(fix === undefined
        ? []
        : [{
          number: fix.number,
          url: `https://github.com/${flag(args, "--repo")}/pull/${fix.number}`,
          headRefName: fix.branch,
          headRefOid: fix.headSha,
        }]);
    }
    return json(repo?.pulls ?? []);
  }
  const repoRead = args[0] === "api" ? args[1]?.match(/^repos\/([^/]+\/[^/]+)$/) : null;
  if (repoRead?.[1] !== undefined) {
    const repo = world.repos[repoRead[1]];
    if (repo === undefined) return httpError(404);
    return json(listing(repoRead[1], repo));
  }
  if (args[0] === "pr" && args[1] === "view" && flag(args, "--json").includes("headRefOid")) {
    const name = flag(args, "--repo");
    const buckets = world.repos[name]?.checks ?? ["pass"];
    return json({
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "ci-green/2026-10-25",
      headRefOid: GATE_HEAD,
      isCrossRepository: false,
      reviewDecision: "",
      mergeStateStatus: world.repos[name]?.gateMergeState ?? "CLEAN",
      author: { login: "octocat" },
      statusCheckRollup: buckets.map((bucket, index) => ({
        __typename: "CheckRun",
        name: `check-${index}`,
        status: bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: bucket === "pass" ? "SUCCESS" : bucket === "pending" ? null : "FAILURE",
      })),
    });
  }
  if (args[0] === "pr" && args[1] === "view") {
    const name = flag(args, "--repo");
    const views = world.repos[name]?.mergeViews ?? [{
      state: "OPEN",
      mergeStateStatus: "CLEAN",
      url: `https://github.com/${name}/pull/${world.prNumber}`,
    }];
    const index = world.views[name] ?? 0;
    world.views[name] = index + 1;
    const view = views[Math.min(index, Math.max(views.length - 1, 0))];
    return json({
      state: view?.state ?? "OPEN",
      mergeStateStatus: view?.mergeStateStatus ?? "CLEAN",
      mergeCommit: view?.mergeCommit === undefined ? null : { oid: view.mergeCommit },
      url: view?.url ?? `https://github.com/${name}/pull/${world.prNumber}`,
    });
  }
  if (args[0] === "pr" && args[1] === "create") {
    const repo = world.repos[flag(args, "--repo")];
    if (repo?.createFails !== undefined) return { status: 1, stdout: "", stderr: repo.createFails };
    if (repo?.createPrints !== undefined) return { status: 0, stdout: repo.createPrints, stderr: "" };
    return { status: 0, stdout: `https://github.com/${flag(args, "--repo")}/pull/${world.prNumber}\n`, stderr: "" };
  }
  if (args[0] === "pr" && args[1] === "merge") {
    const status = world.repos[flag(args, "--repo")]?.mergeStatus ?? 0;
    return { status, stdout: "", stderr: status === 0 ? "" : "merge refused" };
  }
  return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
}

function repoOfCwd(world: World, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  return Object.keys(world.repos)
    .sort((left, right) => right.length - left.length)
    .find((name) => cwd === name || cwd.endsWith(`/${name}`));
}

function answerGit(world: World, args: string[], cwd: string | undefined): CommandResult {
  const repo = repoOfCwd(world, cwd);
  if (args[0] === "diff") {
    return { status: 0, stdout: (repo === undefined ? "" : world.repos[repo]?.diff) ?? "", stderr: "" };
  }
  if (args[0] === "push") {
    if (repo !== undefined) {
      world.originHeadAtPush[repo] = answerGit(world, ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    }
    const ref = args[2] ?? "";
    if (world.failPush) return { status: 1, stdout: "", stderr: "remote rejected" };
    if (repo !== undefined && (ref === "refs/heads/main" || ref.startsWith("refs/tags/"))) {
      return { status: 1, stdout: "", stderr: `refused ${ref}` };
    }
    if (repo !== undefined && ref.startsWith("refs/heads/ci-green/")) {
      const refs = world.refs[repo] ?? {};
      refs[ref] = "pushed";
      world.refs[repo] = refs;
    }
    return { status: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "clone") {
    const destination = args[args.length - 1] ?? "";
    if (existsSync(destination) && readdirSync(destination).length > 0) {
      const refusal = `fatal: destination path '${destination}' already exists and is not an empty directory.`;
      return { status: 128, stdout: "", stderr: refusal };
    }
    mkdirSync(join(destination, ".git"), { recursive: true });
    writeFileSync(join(destination, ".git", "fake-origin"), args[args.length - 2] ?? "");
    const branch = flag(args, "--branch");
    const remoteRef = join(destination, ".git", "refs", "remotes", "origin", branch);
    mkdirSync(join(remoteRef, ".."), { recursive: true });
    writeFileSync(remoteRef, "fetched\n");
    return { status: 0, stdout: "", stderr: "" };
  }
  if (cwd !== undefined && existsSync(join(cwd, ".git"))) {
    const gitFile = (name: string) => join(cwd, ".git", name);
    if (args[0] === "remote" && args[1] === "get-url") {
      const origin = existsSync(gitFile("fake-origin")) ? readFileSync(gitFile("fake-origin"), "utf8") : "";
      return { status: origin === "" ? 2 : 0, stdout: `${origin}\n`, stderr: "" };
    }
    if (args[0] === "symbolic-ref") {
      const ref = args[1] ?? "";
      const target = args[2];
      if (target !== undefined) {
        mkdirSync(join(gitFile(ref), ".."), { recursive: true });
        writeFileSync(gitFile(ref), `ref: ${target}\n`);
        return { status: 0, stdout: "", stderr: "" };
      }
      const contents = existsSync(gitFile(ref)) ? readFileSync(gitFile(ref), "utf8") : "";
      return contents.startsWith("ref: ")
        ? { status: 0, stdout: contents.slice("ref: ".length), stderr: "" }
        : { status: 128, stdout: "", stderr: `fatal: ref ${ref} is not a symbolic ref` };
    }
    if (args[0] === "remote" && args[1] === "set-head") {
      const target = `refs/remotes/${args[2]}/${args[3]}`;
      if (world.failSetHead || !existsSync(gitFile(target))) {
        return { status: 1, stdout: "", stderr: `error: cannot set origin/HEAD to ${target}` };
      }
      return answerGit(world, ["symbolic-ref", `refs/remotes/${args[2]}/HEAD`, target], cwd);
    }
    if (args[0] === "fetch" && !world.failFetch) {
      const refspec = args[args.length - 1] ?? "";
      const target = refspec.split(":")[1];
      if (target !== undefined) {
        mkdirSync(join(gitFile(target), ".."), { recursive: true });
        writeFileSync(gitFile(target), "fetched\n");
      }
    }
    if (args[1] === "--abort") {
      if (args[0] !== "merge" || !existsSync(gitFile("MERGE_HEAD"))) {
        return { status: 128, stdout: "", stderr: `fatal: There is no ${args[0]} to abort` };
      }
      rmSync(gitFile("MERGE_HEAD"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "checkout" && !args.includes("-f") && existsSync(gitFile("MERGE_HEAD"))) {
      return { status: 128, stdout: "", stderr: "error: you need to resolve your current index first" };
    }
    if (args[0] === "reset" && args.includes("--hard")) rmSync(gitFile("MERGE_HEAD"), { force: true });
    if (args[0] === "clean") rmSync(join(cwd, ".repo-green"), { recursive: true, force: true });
  }
  if (args[0] === "fetch" && world.failFetch) {
    return { status: 128, stdout: "", stderr: "fatal: unable to access remote: Could not resolve host" };
  }
  if (["fetch", "checkout", "config", "reset", "clean", "branch"].includes(args[0] ?? "")) {
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
}

function answer(world: World, bin: string, args: string[], cwd: string | undefined): CommandResult | Promise<CommandResult> {
  if (bin === OMP_BIN && args[0] === "-p") {
    if (world.forbidPush) {
      const hookPath = join(flag(args, "--cwd"), ".git", "hooks", "pre-push");
      world.hookCodes.push(refusePush(hookPath, "refs/heads/main"));
      world.hookCodes.push(refusePush(hookPath, "refs/tags/v1.2.3"));
    }
    const behaviour = world.omp;
    if (behaviour.kind === "hang") return new Promise<CommandResult>(() => undefined);
    if (behaviour.kind === "run") return behaviour.run(flag(args, "--cwd"));
    return behaviour.result;
  }
  if (bin === GH_BIN) return answerGh(world, args);
  if (bin === "git") return answerGit(world, args, cwd);
  return { status: 1, stdout: "", stderr: `unexpected ${bin}` };
}
