/**
 * The adapters of the ticket run against fakes: the model-answer parser, the pull-request link finder, the `gh` and
 * `git` ports (real git on throwaway local repositories), the machine-wide file lock, and the Linear GraphQL port over a
 * fake `fetch`. No test here reaches Linear, GitHub or a model.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { fileLock } from "./file_lock.js";
import { githubPort } from "./github_port.js";
import { RepositoryUnavailableError } from "./ports.js";
import { asRepositoryUnavailable, repoPort } from "./repo_port.js";
import { type Implementation, implementationShape, rootCauseVerdictShape } from "./schemas.js";
import { linkedPullRequests } from "./steps_intake.js";
import { sameWords } from "./steps_close.js";
import { parseAnswer } from "./template.js";
import { ORG, PERSONAL_ORG } from "./fake_world.js";
import { checkoutRootFor, primaryRoot, type Workspace, workspaceFor } from "./workspaces.js";

const SAH = workspaceFor("SAH-1");
const ZYS = workspaceFor("ZYS-1");

const exec = promisify(execFile);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "software-factory-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * The live SAH-3566 Coder answer: every step's text joined with no separator, narration that quotes GitHub Actions
 * `${{ secrets.X }}` and `gh` JSON, and the one record the prompt asks for at the end.
 */
describe("parseAnswer", () => {
  const record: Implementation = {
    outcome: "needs_info",
    summary: "Publish has never succeeded: the release secrets are unset.",
    concerns: ["WP_UPDATER_WEBHOOK, PACKAGIST_TOKEN and PACKAGIST_ORG are empty in the run env."],
    evidence: [".github/workflows/release.yml:41 uses ${{ secrets.WP_UPDATER_WEBHOOK }}"],
    closeLinkedPullRequest: false,
  };
  const narrated = [
    "The `publish` job's notify step failed: `curl: (3) URL rejected` and the env shows `WP_UPDATER_WEBHOOK` empty.",
    "It reads `${{ secrets.WP_UPDATER_WEBHOOK }}`; gh run view answered {\"conclusion\":\"failure\",\"jobs\":[{\"name\":\"publish\"}]}.",
    "Publish has never succeeded. Final record:\n```json\n" + JSON.stringify(record, null, 2) + "\n```",
  ].join("");

  it("takes the record at the end of narration that has braces of its own", () => {
    expect(parseAnswer(narrated, implementationShape, "the implementer on SAH-3566")).toEqual(record);
  });

  it("takes the last record that matches when an earlier JSON object does not", () => {
    const draft = JSON.stringify({ ...record, outcome: "pr_ready", summary: "draft" });
    expect(parseAnswer(`first try ${draft} then ${JSON.stringify(record)}`, implementationShape, "x").summary).toBe(record.summary);
    expect(parseAnswer(`${JSON.stringify(record)} and later {"conclusion":"failure"}`, implementationShape, "x")).toEqual(record);
  });

  it("defaults closeLinkedPullRequest to false when the model omits it", () => {
    const implementation = { outcome: "already_done", summary: "s", concerns: [], evidence: ["e"] };
    expect(parseAnswer(JSON.stringify(implementation), implementationShape, "x").closeLinkedPullRequest).toBe(false);
    const verdict = { verdict: "real", rootCause: "r", summary: "s", evidence: [], concerns: [] };
    expect(parseAnswer(JSON.stringify(verdict), rootCauseVerdictShape, "x").closeLinkedPullRequest).toBe(false);
    expect(
      parseAnswer(JSON.stringify({ ...verdict, closeLinkedPullRequest: true }), rootCauseVerdictShape, "x").closeLinkedPullRequest,
    ).toBe(true);
  });

  it("still refuses an answer with no record that matches, naming what came back", () => {
    expect(() => parseAnswer("I looked at {\"conclusion\":\"failure\"} and stopped.", implementationShape, "the implementer on SAH-1"))
      .toThrow(/the implementer on SAH-1 answered no record that matches its schema/);
  });

  it("names an empty answer as empty, and scrubs a secret out of what came back", () => {
    expect(() => parseAnswer("  \n", implementationShape, "x")).toThrow(/\(no JSON object\); the answer was empty$/);
    let message = "";
    try {
      parseAnswer("narration ghp_abcdefghijklmnop1234567890 end", implementationShape, "x");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("narration");
    expect(message).not.toContain("ghp_abcdefghijklmnop1234567890");
  });
});

describe("linkedPullRequests", () => {
  it("finds pull requests of configured workspace organisations and ignores third-party GitHub orgs", () => {
    const sahPull = `https://github.com/${ORG}/widgets/pull/33`;
    const found = linkedPullRequests([
      `[${sahPull}](<${sahPull}>)`,
      `chore(deps): bump x [sah-pr:${ORG}/gadgets#7]`,
      `see https://github.com/${PERSONAL_ORG}/capabilities/pull/5 and [sah-pr:${PERSONAL_ORG}/agentmux#8]`,
      "https://github.com/can1357/oh-my-pi/pull/16792 and [sah-pr:someone-else/widgets#5]",
      `see ${sahPull}/files and https://github.com/${ORG}/widgets/issues/9`,
    ]);
    expect(found).toEqual([
      { url: sahPull, org: ORG, repo: "widgets", number: 33 },
      { url: `https://github.com/${ORG}/gadgets/pull/7`, org: ORG, repo: "gadgets", number: 7 },
      { url: `https://github.com/${PERSONAL_ORG}/capabilities/pull/5`, org: PERSONAL_ORG, repo: "capabilities", number: 5 },
      { url: `https://github.com/${PERSONAL_ORG}/agentmux/pull/8`, org: PERSONAL_ORG, repo: "agentmux", number: 8 },
    ]);
  });
});

describe("githubPort", () => {
  it("opens a draft pull request with --draft and answers the URL gh prints last", async () => {
    const argv: string[][] = [];
    const port = githubPort(async (args) => {
      argv.push([...args]);
      return `Creating pull request...\nhttps://github.com/${ORG}/widgets/pull/101\n`;
    });

    const url = await port.createPullRequest({ org: ORG, repo: "widgets", head: "sah-1", base: "main", title: "T (SAH-1)", body: "B", draft: true });

    expect(url).toBe(`https://github.com/${ORG}/widgets/pull/101`);
    expect(argv[0]).toEqual(["pr", "create", "--repo", `${ORG}/widgets`, "--head", "sah-1", "--base", "main", "--title", "T (SAH-1)", "--body", "B", "--draft"]);
  });

  it("opens a ready pull request in the arguments' own organisation without --draft, and refuses a non-URL answer", async () => {
    const argv: string[][] = [];
    const port = githubPort(async (args) => {
      argv.push([...args]);
      return "something went wrong";
    });
    await expect(
      port.createPullRequest({ org: PERSONAL_ORG, repo: "capabilities", head: "h", base: "main", title: "t", body: "b", draft: false }),
    ).rejects.toThrow(/no pull request URL/);
    expect(argv[0]).toContain(`${PERSONAL_ORG}/capabilities`);
    expect(argv[0]).not.toContain("--draft");
  });

  it("reads a pull request's state, draft flag and branches", async () => {
    const port = githubPort(async () =>
      JSON.stringify({ number: 33, url: `https://github.com/${ORG}/widgets/pull/33`, state: "OPEN", isDraft: true, headRefName: "dependabot/x", baseRefName: "main" })
    );
    expect(await port.readPullRequest(`https://github.com/${ORG}/widgets/pull/33`)).toEqual({
      url: `https://github.com/${ORG}/widgets/pull/33`,
      org: ORG,
      repo: "widgets",
      number: 33,
      state: "OPEN",
      isDraft: true,
      headRef: "dependabot/x",
      baseRef: "main",
    });
  });

  it("refuses to create, ready, or close a pull request in a third-party GitHub org", async () => {
    const argv: string[][] = [];
    const port = githubPort(async (args) => {
      argv.push([...args]);
      return "";
    });
    await expect(
      port.createPullRequest({ org: "can1357", repo: "oh-my-pi", head: "h", base: "main", title: "t", body: "b", draft: false }),
    ).rejects.toThrow(/third-party|organisation/i);
    await expect(port.markPullRequestReady("https://github.com/can1357/oh-my-pi/pull/16792")).rejects.toThrow(/third-party|organisation/i);
    await expect(
      port.closePullRequest({ url: "https://github.com/can1357/oh-my-pi/pull/16792", comment: "c" }),
    ).rejects.toThrow(/third-party|organisation/i);
    expect(argv).toEqual([]);
  });
});

/**
 * The two forms Linear keeps for one reader-visible body, from the live ZYS-1894 write: the workflow wrote the tag form and
 * Linear stored the link form, so an exact comparison of letters and digits failed on the uuid and href no reader sees.
 */
describe("sameWords", () => {
  const written =
    'See <issue id="e4cd2e94-8846-4eca-af95-338b93916c45" href="https://linear.app/zysys/issue/ZYS-1893/webmaster-server-checks-scanned-wp-content-while">ZYS-1893</issue> for the evidence.';
  const stored = "See [ZYS-1893](https://linear.app/zysys/issue/ZYS-1893/webmaster-server-checks-scanned-wp-content-while) for the evidence.";

  it("reads an issue reference Linear rewrote as the same body", () => {
    expect(sameWords(stored, written)).toBe(true);
  });

  it("still tells a truncated body from the one that was written", () => {
    expect(sameWords(stored.slice(0, 40), written)).toBe(false);
  });

  it("still tells a body with a word changed from the one that was written", () => {
    expect(sameWords(stored.replace("evidence", "guess"), written)).toBe(false);
  });

  it("reads a bare #N Linear auto-linked to <pull-request>org/repo#N</pull-request> and placeholders like <issue|pr> as the same body", () => {
    const writtenZys1742 =
      'Run `upstream-approval --action "<issue|pr> <create|comment>"`.\nSee [ZYS-1724](https://linear.app/zysys/issue/ZYS-1724/slug) and jdx\'s merge of #343 and close of #342.';
    const storedZys1742 =
      'Run `upstream-approval --action "<issue|pr> <create|comment>"`.\nSee <issue id="1182634b-49bf-40e8-8e68-98f67dcf399c" href="https://linear.app/zysys/issue/ZYS-1724/slug">ZYS-1724</issue> and jdx\'s merge of #343 and close of <pull-request id="7d5e0c42-e329-4505-af11-e8036d36f4b8" href="https://linear.app/zysys/review/slug">zachbornheimer/homelab#342</pull-request>.';
    expect(sameWords(storedZys1742, writtenZys1742)).toBe(true);
  });
});

/** Importing the agent modules transforms them and opens sockets on first load, which costs far more than a plain unit test on a loaded machine. */
describe("fileLock", () => {
  it("is held by the first run and refused to the second until the first releases", async () => {
    const lock = fileLock(join(root, "lock"));
    expect((await lock.acquire({ runId: "a", ticket: "SAH-1" })).held).toBe(true);
    const refused = await lock.acquire({ runId: "b", ticket: "SAH-2" });
    expect(refused.held).toBe(false);
    expect(refused.holder).toEqual({ runId: "a", ticket: "SAH-1" });
    await lock.release("a");
    expect((await lock.acquire({ runId: "b", ticket: "SAH-2" })).held).toBe(true);
  });

  it("is never freed by a run that did not take it", async () => {
    const lock = fileLock(join(root, "lock"));
    await lock.acquire({ runId: "a", ticket: "SAH-1" });
    await lock.release("b");
    expect((await lock.acquire({ runId: "c", ticket: "SAH-3" })).held).toBe(false);
  });

  it("reclaims a lock whose process is gone, and one older than the limit", async () => {
    const path = join(root, "lock");
    let clock = 1_000;
    const dead = fileLock(path, { now: () => clock, isAlive: () => false });
    await dead.acquire({ runId: "a", ticket: "SAH-1" });
    expect((await dead.acquire({ runId: "b", ticket: "SAH-2" })).held).toBe(true);

    const old = fileLock(path, { now: () => clock, isAlive: () => true, maxAgeMs: 100 });
    expect((await old.acquire({ runId: "c", ticket: "SAH-3" })).held).toBe(false);
    clock += 101;
    expect((await old.acquire({ runId: "c", ticket: "SAH-3" })).held).toBe(true);
  });

  it("reclaims a lock file nobody can read", async () => {
    const path = join(root, "lock");
    await writeFile(path, "not json");
    expect((await fileLock(path).acquire({ runId: "a", ticket: "SAH-1" })).held).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).runId).toBe("a");
  });

  it("lets exactly one of many simultaneous runs take it", async () => {
    const lock = fileLock(join(root, "lock"));
    const taken = await Promise.all(Array.from({ length: 8 }, (_, i) => lock.acquire({ runId: `run-${i}`, ticket: "SAH-1" })));
    expect(taken.filter((acquire) => acquire.held)).toHaveLength(1);
  });
});

/**
 * The environment every git call here runs with. A developer's git config may run `hk` as config-based hooks, and `HK: "0"`
 * is the switch those hooks check, so they cannot fail a fixture commit whose message is not conventional. Signing is off
 * for the same reason: a fixture commit must not need the developer's key. The `GIT_*`
 * variables are dropped for the reason `mise.toml` drops them: git exports them to its children, so a check that runs inside
 * a managed checkout would otherwise point these throwaway repositories at that checkout instead of at themselves.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HK: "0",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
};

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", [
    "-c", "user.name=Factory Test",
    "-c", "user.email=factory@example.invalid",
    "-c", "commit.gpgsign=false",
    "-C", cwd,
    ...args,
  ], {
    env: GIT_ENV,
  });
  return stdout;
}

/** Real git processes take seconds apiece on a loaded machine, so the remote and its clone are built once for the tests that need one. */
const REAL_GIT_TEST_TIMEOUT_MS = 180_000;
setDefaultTimeout(REAL_GIT_TEST_TIMEOUT_MS);

describe("asRepositoryUnavailable", () => {
  it("reads gh's unresolvable repository as unavailable with the line that says why, and leaves a real fault alone", () => {
    const graphql = `GraphQL: Could not resolve to a Repository with the name '${PERSONAL_ORG}/obsidian-backup'. (repository)`;
    const missing = asRepositoryUnavailable(
      `${PERSONAL_ORG}/obsidian-backup`,
      Object.assign(new Error(`Command failed: gh repo clone ${PERSONAL_ORG}/obsidian-backup /tmp/obsidian-backup`), {
        stderr: `${graphql}\n`,
      }),
    );
    expect(missing).toBeInstanceOf(RepositoryUnavailableError);
    // The reason is the diagnostic line alone: `Command failed: …` names the invocation, not the fault.
    expect(missing).toMatchObject({
      repository: `${PERSONAL_ORG}/obsidian-backup`,
      name: "RepositoryUnavailableError",
      reason: graphql,
    });

    const auth = new Error("HTTP 401: Bad credentials");
    expect(asRepositoryUnavailable(`${ORG}/widgets`, auth)).toBe(auth);
  });
});

describe("repoPort", () => {
  it("answers a worktree whose repository is gone upstream as unavailable, and a network failure as itself", async () => {
    const worktree = { checkout: join(root, "checkouts", "obsidian-backup"), ticket: "ZYS-5", branch: "zys-5" };
    const gone = repoPort({
      clone: async () => {},
      git: async (args) => {
        if (args[0] === "fetch") {
          throw Object.assign(new Error("Command failed: git -C … fetch origin --prune"), {
            stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/zachbornheimer/obsidian-backup/' not found\n",
          });
        }
        if (args[0] === "remote") return `https://github.com/${PERSONAL_ORG}/obsidian-backup.git\n`;
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    await expect(gone.openWorktree(worktree)).rejects.toMatchObject({
      name: "RepositoryUnavailableError",
      repository: `${PERSONAL_ORG}/obsidian-backup`,
      reason: "remote: Repository not found.",
    });

    const offline = repoPort({
      clone: async () => {},
      git: async () => {
        throw new Error("fatal: unable to access 'https://github.com/zachbornheimer/obsidian-backup/': Could not resolve host: github.com");
      },
    });
    await expect(offline.openWorktree(worktree)).rejects.toThrow("Could not resolve host");
  });

  it("lists every checkout under a workspace's roots by GitHub name and org, and clones a missing one into its own root", async () => {
    const checkoutsRoot = join(root, "checkouts");
    const workspace: Workspace = { ...SAH, roots: [checkoutsRoot] };
    const cloned: string[] = [];
    const port = repoPort({ git, clone: async (repo, destination) => void cloned.push(`${repo.org}/${repo.name} -> ${destination}`) });
    const origins = [
      ["widgets", `https://github.com/${ORG}/widgets.git`],
      ["widgets.tmp", `https://github.com/${ORG}/widgets.git`],
      ["scratch", `https://github.com/${PERSONAL_ORG}/scratch.git`],
    ] as const;
    for (const [name, origin] of origins) {
      await mkdir(join(checkoutsRoot, name), { recursive: true });
      await git(["init"], join(checkoutsRoot, name));
      await git(["remote", "add", "origin", origin], join(checkoutsRoot, name));
    }
    await mkdir(join(checkoutsRoot, "not-a-repo"));

    const listed = await port.listCheckouts(workspace);
    expect(listed).toHaveLength(3);
    // A checkout of another organisation is listed too, and the directory named like its repository wins over the scratch copy.
    expect(listed.map((checkout) => `${checkout.org}/${checkout.repo}`)).toEqual(
      expect.arrayContaining([`${ORG}/widgets`, `${PERSONAL_ORG}/scratch`]),
    );
    const namedWidgets = listed.findIndex((checkout) => checkout.path === join(checkoutsRoot, "widgets"));
    const scratchCopy = listed.findIndex((checkout) => checkout.path === join(checkoutsRoot, "widgets.tmp"));
    expect(namedWidgets).toBeLessThan(scratchCopy);
    expect(await port.ensureCheckout(workspace, { name: "widgets" })).toEqual({
      org: ORG,
      repo: "widgets",
      path: join(checkoutsRoot, "widgets"),
    });
    expect(cloned).toEqual([]);
    // A checkout of the wrong organisation is not the repository: that one is cloned.
    expect(await port.ensureCheckout(workspace, { name: "scratch", org: ORG })).toEqual({
      org: ORG,
      repo: "scratch",
      path: join(checkoutsRoot, "scratch"),
    });
    expect(cloned).toEqual([`${ORG}/scratch -> ${join(checkoutsRoot, "scratch")}`]);
    // A repository of an organisation the ticket's workspace does not hold lands under the workspace that does.
    expect(checkoutRootFor(workspace, PERSONAL_ORG)).toBe(primaryRoot(ZYS));
  });

  describe("on a clone of a local bare remote", () => {
    /** The base of the linked pull request ZYS-1872's dispatch continued: a branch that is not the default. */
    const PR_BASE = "zys-1804-local-main";
    let shared: string;
    let remote: string;
    let checkout: string;
    /** A clone whose own refspec carries only `main`, which is how the dispatch that failed was configured. */
    let narrow: string;
    let checkoutsRoot: string;
    let port: ReturnType<typeof repoPort>;

    beforeAll(async () => {
      shared = await mkdtemp(join(tmpdir(), "software-factory-remote-"));
      remote = join(shared, "remote.git");
      const seed = join(shared, "seed");
      await mkdir(seed, { recursive: true });
      await exec("git", ["init", "--bare", "-b", "main", remote], { env: GIT_ENV });
      await git(["init", "-b", "main"], seed);
      await writeFile(join(seed, "README.md"), "seed\n");
      await git(["add", "-A"], seed);
      await git(["commit", "-m", "seed"], seed);
      await git(["remote", "add", "origin", remote], seed);
      await git(["push", "-u", "origin", "main"], seed);
      await git(["checkout", "-b", "feature"], seed);
      await writeFile(join(seed, "feature.txt"), "on the pull request branch\n");
      await git(["add", "-A"], seed);
      await git(["commit", "-m", "feature"], seed);
      await git(["push", "origin", "feature"], seed);
      await git(["checkout", "-b", PR_BASE, "main"], seed);
      await writeFile(join(seed, "base.txt"), "the pull request's base branch\n");
      await git(["add", "-A"], seed);
      await git(["commit", "-m", PR_BASE], seed);
      await git(["push", "origin", PR_BASE], seed);
      await git(["checkout", "main"], seed);
      checkoutsRoot = join(shared, "checkouts");
      await mkdir(checkoutsRoot);
      checkout = join(checkoutsRoot, "widgets");
      await exec("git", ["clone", remote, checkout], { env: GIT_ENV });
      narrow = join(checkoutsRoot, "widgets-narrow");
      await exec("git", ["clone", "--single-branch", "--branch", "main", remote, narrow], { env: GIT_ENV });
      port = repoPort({ git, clone: async () => {} });
    }, REAL_GIT_TEST_TIMEOUT_MS);
    // Removing a clone and its worktrees is as slow as making them on a loaded host: the same budget, not the 10 s default.
    afterAll(async () => {
      await rm(shared, { recursive: true, force: true });
    }, REAL_GIT_TEST_TIMEOUT_MS);

    it("cuts the ticket branch from the default branch, commits leftovers once, counts commits ahead, and pushes the branch", async () => {
      const worktree = await port.openWorktree({ checkout, ticket: "SAH-7", branch: "sah-7" });

      expect(worktree).toEqual({ path: join(checkoutsRoot, ".worktrees", "widgets-sah-7"), branch: "sah-7", base: "main" });
      expect(await port.commitsAhead({ worktree: worktree.path, base: "main" })).toBe(0);
      expect(await port.commitLeftovers({ worktree: worktree.path, message: "chore: nothing" })).toBe(false);

      await writeFile(join(worktree.path, "fix.ts"), "export const fixed = true;\n");
      expect(await port.commitLeftovers({ worktree: worktree.path, message: "chore(sah-7): commit leftover changes" })).toBe(true);
      expect(await port.commitLeftovers({ worktree: worktree.path, message: "chore: again" })).toBe(false);
      expect(await port.commitsAhead({ worktree: worktree.path, base: "main" })).toBe(1);

      await port.push({ worktree: worktree.path, branch: "sah-7" });
      expect((await git(["log", "-1", "--format=%s", "sah-7"], remote)).trim()).toBe("chore(sah-7): commit leftover changes");
    });

    it("continues a branch that already exists on the remote (a linked PR's head) on the PR's base", async () => {
      const worktree = await port.openWorktree({ checkout, ticket: "SAH-8", branch: "feature", base: "main" });

      expect(worktree.base).toBe("main");
      expect(await readFile(join(worktree.path, "feature.txt"), "utf8")).toContain("on the pull request branch");
      expect(await port.commitsAhead({ worktree: worktree.path, base: "main" })).toBe(1);
    });

    it("continues a linked pull request's head and base on a clone whose refspec carries only the default branch", async () => {
      // The ZYS-1872 dispatch condition: `remote.origin.fetch` holds `main` alone, so neither the pull request's head
      // nor the base it was opened against is a ref this clone has.
      expect((await git(["config", "--get-all", "remote.origin.fetch"], narrow)).trim()).toBe(
        "+refs/heads/main:refs/remotes/origin/main",
      );

      const worktree = await port.openWorktree({ checkout: narrow, ticket: "ZYS-1872", branch: "feature", base: PR_BASE });

      expect(worktree).toEqual({
        path: join(checkoutsRoot, ".worktrees", "widgets-narrow-zys-1872"),
        branch: "feature",
        base: PR_BASE,
      });
      // The head the pull request already carries, not a fresh branch cut from the base: the work continues what was pushed.
      expect(await readFile(join(worktree.path, "feature.txt"), "utf8")).toContain("on the pull request branch");
      expect(await port.commitsAhead({ worktree: worktree.path, base: PR_BASE })).toBe(1);
    });

    it("names a base branch the remote does not have, rather than handing git a ref it cannot resolve", async () => {
      await expect(
        port.openWorktree({ checkout: narrow, ticket: "ZYS-1873", branch: "zys-1873", base: "no-such-base" }),
      ).rejects.toThrow("origin has no branch no-such-base");
    });

    it("reuses the ticket's worktree on a second run, and refuses one left on another branch", async () => {
      const first = await port.openWorktree({ checkout, ticket: "SAH-9", branch: "sah-9" });
      await writeFile(join(first.path, "wip.txt"), "work in progress\n");

      const again = await port.openWorktree({ checkout, ticket: "SAH-9", branch: "sah-9" });

      expect(again.path).toBe(first.path);
      expect(await readFile(join(again.path, "wip.txt"), "utf8")).toBe("work in progress\n");
      await expect(port.openWorktree({ checkout, ticket: "SAH-9", branch: "other" })).rejects.toThrow(/is on sah-9, not on other/);
    });
  });
});
