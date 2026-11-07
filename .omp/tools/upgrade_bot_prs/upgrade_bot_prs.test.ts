import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_LANES,
  EXIT_POLL_MS,
  HOUR_MS,
  LANES_ENV,
  LAUNCH_WAIT_MS,
  REPO_HOLD_MS,
  RETRY_AFTER_MS,
  RUN_MAX_TIME,
  SEARCH_LIMIT,
  SPAWN_WINDOW_MS,
  UPGRADE_TOOL,
} from "./constants.js";
import {
  FakeUpgradeBotHost,
  type GhResponder,
  LOCK_PATH,
  REGISTRY_PATH,
  settle,
  urlOf,
} from "./fake_host.js";
import { shellUpgradeBotHost } from "./host.js";
import factory, { DESCRIPTION, summarize, toolInstalled } from "./index.js";
import { listOpenBotPrs } from "./list_open_bot_prs.js";
import { holdInForce, isBotAuthor, lanesFrom } from "./policy.js";
import { type LockOutcome, takeLock } from "./registry.js";
import { type Listed, type Pull, parseRegistry, parseSearchRows } from "./schemas.js";
import { launchUpgradeDependencyPerRepo as startTick, runCommand, runPrompt } from "./tick.js";

/** A tick to the end, on the host's virtual clock: a lane waits for its run to exit, which takes hours of virtual time. */
const launchUpgradeDependencyPerRepo = (host: FakeUpgradeBotHost, input: Listed) => host.run(startTick(host, input));

/** The fixed tick start every test uses. */
const START = new Date(2026, 9, 28, 12, 0, 0);

const url = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;
const pull = (repo: string, number: number, createdAt = "2026-10-01T00:00:00Z") => ({
  pr: `${repo}#${number}`,
  repo,
  number,
  url: url(repo, number),
  createdAt,
});
const listed = (...pulls: Pull[]): Listed => ({ pulls, skipped: [] });

const HEAD = "a".repeat(40);
/** A `gh search prs` row of a bot's open pull request. */
const searchRow = (found: Pull) => ({
  repository: { nameWithOwner: found.repo },
  number: found.number,
  url: found.url,
  author: { login: "renovate[bot]", type: "Bot" },
  isDraft: false,
  labels: [],
  createdAt: found.createdAt,
});

/**
 * `gh pr view <url> --json headRefOid --jq .headRefOid` answers `<heads[url] ?? HEAD>`; a URL in `broken` fails.
 * `gh search prs --repo <repo>`, the lane's listing of one repository again, answers `open()`'s pull requests of that
 * repository; with no `open` it is not faked, so listing again fails as a rate limit would.
 */
function gh(heads: Record<string, string> = {}, broken: string[] = [], open?: () => Pull[]): GhResponder {
  return (args) => {
    if (args[0] === "search" && open !== undefined && args.includes("--repo")) {
      const repo = args[args.indexOf("--repo") + 1];
      return { status: 0, stdout: JSON.stringify(open().filter((found) => found.repo === repo).map(searchRow)), stderr: "" };
    }
    if (args[0] !== "pr" || args[1] !== "view") return undefined;
    const target = args[2]!;
    if (broken.includes(target)) return { status: 1, stdout: "", stderr: "HTTP 502" };
    return { status: 0, stdout: `${heads[target] ?? HEAD}\n`, stderr: "" };
  };
}

const registryWith = (host: FakeUpgradeBotHost, registry: { lastTrys?: object; holds?: object }) =>
  host.files.set(REGISTRY_PATH, JSON.stringify({ lastTrys: {}, holds: {}, ...registry }));

const lastTry = (at: Date, pid: number, startedAt = at) => ({
  at: at.toISOString(),
  pid,
  startedAt: startedAt.toISOString(),
  head: HEAD,
});

const ago = (ms: number) => new Date(START.getTime() - ms);

describe("upgrade_bot_prs: finding the pull requests", () => {
  const row = (login: string, type: string | undefined, extra: object = {}) => ({
    repository: { nameWithOwner: "me/app" },
    number: 1,
    url: url("me/app", 1),
    author: { login, type },
    isDraft: false,
    labels: [],
    createdAt: "2026-10-01T00:00:00Z",
    ...extra,
  });

  /** `gh` for owners `me` and `acme`; `rows[owner]` is what the owner's search returns. */
  const search = (rows: Record<string, object[]>): GhResponder => (args) => {
    if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "me\n", stderr: "" };
    if (args[0] === "api" && args[1] === "user/orgs") return { status: 0, stdout: "acme\n", stderr: "" };
    if (args[0] === "search") {
      return { status: 0, stdout: JSON.stringify(rows[args[args.indexOf("--owner") + 1]!] ?? []), stderr: "" };
    }
    return undefined;
  };

  it("keeps any bot, not only renovate, and drops humans, drafts and already-checked pull requests", async () => {
    const host = new FakeUpgradeBotHost(
      START,
      search({
        me: [
          row("cursor[bot]", "Bot"),
          row("app/some-tool", undefined, { number: 2 }),
          row("zachbornheimer", "User", { number: 3 }),
          row("renovate[bot]", "Bot", { number: 4, isDraft: true }),
          row("dependabot[bot]", "Bot", { number: 5, labels: [{ name: "ai:dependencies-checked" }] }),
          row("sah-renovate-bot[bot]", undefined, { number: 6 }),
        ],
      }),
    );
    const result = await listOpenBotPrs(host, {});
    expect(result.pulls.map((found) => found.pr)).toEqual(["me/app#1", "me/app#2", "me/app#6"]);
    expect(result.skipped).toEqual([]);
  });

  it("asks each owner once: the gh user and every org", async () => {
    const owners: string[] = [];
    const host = new FakeUpgradeBotHost(START, (args) => {
      if (args[0] === "search") owners.push(args[args.indexOf("--owner") + 1]!);
      return search({})(args);
    });
    await listOpenBotPrs(host, {});
    expect(owners).toEqual(["me", "acme"]);
  });

  it("refuses an owner whose search came back at the limit and still lists the others", async () => {
    const full = Array.from({ length: SEARCH_LIMIT }, (_, index) => row("renovate[bot]", "Bot", { number: index + 1 }));
    const host = new FakeUpgradeBotHost(
      START,
      search({ me: full, acme: [{ ...row("renovate[bot]", "Bot"), repository: { nameWithOwner: "acme/lib" } }] }),
    );
    const result = await listOpenBotPrs(host, {});
    expect(result.pulls.map((found) => found.pr)).toEqual(["acme/lib#1"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.pr).toBe("me");
    expect(result.skipped[0]!.reason).toContain("partial list");
  });

  it("reports a failed owner as a skip instead of throwing", async () => {
    const host = new FakeUpgradeBotHost(START, (args) => {
      if (args[0] === "search" && args[args.indexOf("--owner") + 1] === "me") {
        return { status: 1, stdout: "", stderr: "rate limited" };
      }
      return search({})(args);
    });
    const result = await listOpenBotPrs(host, {});
    expect(result.skipped[0]).toMatchObject({ pr: "me" });
    expect(result.skipped[0]!.reason).toContain("rate limited");
  });

  it("reports a failed `gh api user` as an owners skip and lists nothing", async () => {
    const host = new FakeUpgradeBotHost(START, () => ({ status: 4, stdout: "", stderr: "not logged in" }));
    const result = await listOpenBotPrs(host, { dryRun: true });
    expect(result.pulls).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.skipped).toEqual([{ pr: "owners", reason: expect.stringContaining("not logged in") }]);
  });

  it("reports an empty login, and a search row of the wrong shape, as skips", async () => {
    const noLogin = new FakeUpgradeBotHost(START, () => ({ status: 0, stdout: "\n", stderr: "" }));
    expect((await listOpenBotPrs(noLogin, {})).skipped[0]!.reason).toContain("no login");
    const bad = new FakeUpgradeBotHost(START, (args) =>
      args[0] === "search" ? { status: 0, stdout: JSON.stringify([{ number: "x" }]), stderr: "" } : search({})(args)
    );
    const result = await listOpenBotPrs(bad, {});
    expect(result.skipped.map((skip) => skip.pr)).toEqual(["me", "acme"]);
    expect(result.skipped[0]!.reason).toContain("unexpected shape");
  });

  it("rethrows when the call is cancelled instead of reporting skips", async () => {
    const controller = new AbortController();
    const host = new FakeUpgradeBotHost(START, () => {
      controller.abort(new Error("cancelled by user"));
      return { status: 1, stdout: "", stderr: "killed" };
    });
    host.signal = controller.signal;
    await expect(listOpenBotPrs(host, {})).rejects.toThrow("cancelled by user");
  });

  it("calls a Bot by type, by the [bot] suffix or by the app/ prefix, and a person never", () => {
    expect(isBotAuthor({ login: "x", type: "Bot" })).toBe(true);
    expect(isBotAuthor({ login: "x[bot]" })).toBe(true);
    expect(isBotAuthor({ login: "app/x" })).toBe(true);
    expect(isBotAuthor({ login: "zach", type: "User" })).toBe(false);
  });

  it("asks gh for the exact search, with the label filter after `--`", async () => {
    const asked: string[][] = [];
    const host = new FakeUpgradeBotHost(START, (args) => {
      if (args[0] === "search") asked.push([...args]);
      return search({})(args);
    });
    await listOpenBotPrs(host, {});
    expect(asked[0]).toEqual([
      "search", "prs", "--owner", "me", "--state", "open", "--archived=false", "--draft=false",
      "--limit", "1000", "--json", "repository,number,url,author,isDraft,labels,createdAt", "--",
      "-label:ai:dependencies-checked",
    ]);
  });
});

describe("upgrade_bot_prs: validators", () => {
  it("accepts a null author and rejects a missing field by name", () => {
    const base = {
      repository: { nameWithOwner: "a/b" },
      number: 1,
      url: "u",
      isDraft: false,
      labels: [],
      createdAt: "t",
    };
    expect(parseSearchRows([{ ...base, author: null }])[0]!.author).toBeNull();
    expect(() => parseSearchRows([{ ...base, author: { login: 3 } }])).toThrow("author.login");
    expect(() => parseSearchRows([{ ...base, number: 1.5 }])).toThrow("number");
    expect(() => parseSearchRows({})).toThrow("array");
  });

  it("rejects a registry whose entries lack fields", () => {
    expect(parseRegistry({ lastTrys: {}, holds: {} })).toEqual({ lastTrys: {}, holds: {} });
    expect(() => parseRegistry({ lastTrys: { x: { pid: 1 } }, holds: {} })).toThrow("lastTrys.x");
    expect(() => parseRegistry({ lastTrys: {}, holds: { x: { until: "t" } } })).toThrow("holds.x");
    expect(() => parseRegistry([])).toThrow("lastTrys, holds");
  });
});

describe("upgrade_bot_prs: one tick", () => {
  it("launches a headless omp limited to upgrade_dependency, detached, and records it once it is still running", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 7)));
    expect(host.launches).toHaveLength(1);
    const launch = host.launches[0]!;
    expect(launch.bin).toBe("omp");
    expect(launch.args).toEqual(runCommand(url("me/app", 7)).args);
    expect(launch.args.slice(0, 1)).toEqual(["-p"]);
    expect(launch.args).toContain("--no-session");
    expect(launch.args[launch.args.indexOf("--tools") + 1]).toBe(UPGRADE_TOOL);
    expect(launch.args[launch.args.indexOf("--max-time") + 1]).toBe(RUN_MAX_TIME);
    expect(launch.args[1]).toContain(url("me/app", 7));
    expect(launch.logPath).toContain("/.config/webmaster/logs/");
    const pid = launch.pid;
    expect(result.launched).toEqual([{ pr: "me/app#7", url: url("me/app", 7), pid }]);
    expect(host.registry()!.lastTrys["me/app#7"]).toEqual({
      at: START.toISOString(),
      pid,
      startedAt: START.toISOString(),
      head: HEAD,
    });
  });

  it("gives the run a prompt that names the tool, the URL and the one-call limit", () => {
    const prompt = runPrompt(url("me/app", 7));
    expect(prompt).toContain("`upgrade_dependency`");
    expect(prompt).toContain(url("me/app", 7));
    expect(prompt).toContain("exactly once");
  });

  it("picks a bot's pull request that is not renovate's, found by the search", async () => {
    const host = new FakeUpgradeBotHost(START, (args) => {
      if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "me\n", stderr: "" };
      if (args[0] === "api") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "search") {
        return {
          status: 0,
          stdout: JSON.stringify([{
            repository: { nameWithOwner: "me/app" },
            number: 9,
            url: url("me/app", 9),
            author: { login: "cursor[bot]", type: "Bot" },
            isDraft: false,
            labels: [],
            createdAt: "2026-10-01T00:00:00Z",
          }]),
          stderr: "",
        };
      }
      return gh()(args);
    });
    const found = await listOpenBotPrs(host, {});
    const result = await launchUpgradeDependencyPerRepo(host, found);
    expect(result.launched.map((launch) => launch.pr)).toEqual(["me/app#9"]);
  });

  it("fails with BLOCKED, launching and locking nothing, when upgrade_dependency is not installed", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.installed.clear();
    await expect(launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)))).rejects.toThrow(
      "BLOCKED: the `upgrade_dependency` omp tool is not installed",
    );
    expect(host.launches).toEqual([]);
    expect(host.files.size).toBe(0);
  });

  it("needs no upgrade_dependency for a dry run or an empty list", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.installed.clear();
    const dry = await launchUpgradeDependencyPerRepo(host, { ...listed(pull("me/app", 1)), dryRun: true });
    expect(dry.wouldLaunch).toHaveLength(1);
    expect((await launchUpgradeDependencyPerRepo(host, listed())).repos).toBe(0);
  });

  it("skips the whole tick while any recorded run is alive, however old, and launches in no repository", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.alive.add(4242);
    registryWith(host, { lastTrys: { "me/app#1": lastTry(ago(10 * HOUR_MS), 4242) } });
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 2), pull("me/other", 1)));
    expect(host.launches).toEqual([]);
    expect(result.launched).toEqual([]);
    expect(result.skipped).toEqual([{ pr: "tick", reason: expect.stringContaining("me/app#1 (pid 4242)") }]);
  });

  it("lets a recorded run whose pid is dead block nothing", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    registryWith(host, { lastTrys: { "me/app#1": lastTry(ago(HOUR_MS), 4242) } });
    await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 2)));
    expect(host.launches).toHaveLength(1);
  });

  it("counts the 4 h from the tick's start, not from the clock at the moment it checks", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.tickPerNow = 60 * 1000; // the clock runs on while the tick works; the start stays the first reading
    registryWith(host, {
      lastTrys: {
        "me/early#1": lastTry(new Date(START.getTime() - RETRY_AFTER_MS + 30 * 1000), 1),
        "me/exact#1": lastTry(ago(RETRY_AFTER_MS), 2),
      },
    });
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/early", 1), pull("me/exact", 1)));
    expect(result.launched.map((launch) => launch.pr)).toEqual(["me/exact#1"]);
    expect(result.skipped.map((skip) => skip.pr)).toEqual(["me/early#1"]);
    expect(host.registry()!.lastTrys["me/exact#1"]).toMatchObject({ at: START.toISOString() });
  });

  describe("a repository with several pull requests", () => {
    const MINUTE_MS = 60 * 1000;
    const four = pull("me/app", 4, "2026-10-04T00:00:00Z");
    const five = pull("me/app", 5, "2026-10-05T00:00:00Z");
    const six = pull("me/app", 6, "2026-10-06T00:00:00Z");
    /** A host whose repository listing is `open()`; a pull request is open until a run was launched for it. */
    const hostWith = (open: (host: FakeUpgradeBotHost) => ReturnType<typeof pull>[]) => {
      const host: FakeUpgradeBotHost = new FakeUpgradeBotHost(START, gh({}, [], () => open(host)));
      return host;
    };
    const launched = (host: FakeUpgradeBotHost) => host.launches.map(urlOf);
    const unlaunched = (host: FakeUpgradeBotHost, ...found: ReturnType<typeof pull>[]) =>
      found.filter((candidate) => !launched(host).includes(candidate.url));

    it("works all of them in one tick, one run after another, oldest first", async () => {
      const host = hostWith((self) => unlaunched(self, six, four, five));
      const result = await launchUpgradeDependencyPerRepo(host, listed(six, five, four));
      expect(launched(host)).toEqual([four.url, five.url, six.url]);
      expect(result.launched.map((launch) => launch.pr)).toEqual(["me/app#4", "me/app#5", "me/app#6"]);
      expect(result.skipped).toEqual([]);
      expect(result.repos).toBe(1);
      expect(host.maxAlive).toBe(1);
      expect(host.launches.every((launch) => launch.aliveAfter === 1)).toBe(true);
      // Each run is waited for, and the lane is held REPO_HOLD_MS after it exits, before the next starts.
      for (const [index, next] of host.launches.slice(1).entries()) {
        const gap = next.at - host.launches[index]!.at;
        expect(gap).toBeGreaterThanOrEqual(host.lifetimeMs + REPO_HOLD_MS);
        expect(gap).toBeLessThanOrEqual(host.lifetimeMs + REPO_HOLD_MS + EXIT_POLL_MS);
      }
      expect(Object.keys(host.registry()!.lastTrys)).toEqual(["me/app#4", "me/app#5", "me/app#6"]);
      expect(host.files.has(LOCK_PATH)).toBe(false);
    });

    it("lists the repository again after each run: one merged meanwhile is not launched, one opened meanwhile is", async () => {
      const seven = pull("me/app", 7, "2026-10-07T00:00:00Z");
      const host = hostWith((self) => unlaunched(self, five, seven)); // six was merged while four ran
      const result = await launchUpgradeDependencyPerRepo(host, listed(four, five, six));
      expect(launched(host)).toEqual([four.url, five.url, seven.url]);
      expect(result.skipped).toEqual([]);
    });

    it("never launches a pull request twice in a tick, though it is still open after its run", async () => {
      const host = hostWith(() => [four, five, six]);
      const result = await launchUpgradeDependencyPerRepo(host, listed(four, five, six));
      expect(launched(host)).toEqual([four.url, five.url, six.url]);
      expect(result.skipped).toEqual([]);
    });

    it("skips the rest, once each, when listing the repository again fails, and keeps what it launched", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      const result = await launchUpgradeDependencyPerRepo(host, listed(four, five, six));
      expect(launched(host)).toEqual([four.url]);
      expect(result.launched.map((launch) => launch.pr)).toEqual(["me/app#4"]);
      expect(result.skipped.map((skip) => skip.pr)).toEqual(["me/app#5", "me/app#6"]);
      expect(result.skipped[0]!.reason).toContain("listing me/app again failed");
    });

    it("stops launching when the spawn window closes between runs, and skips the pull requests left", async () => {
      const host = hostWith((self) => unlaunched(self, four, five, six));
      host.lifetimeMs = 100 * MINUTE_MS;
      const result = await launchUpgradeDependencyPerRepo(host, listed(four, five, six));
      expect(launched(host)).toEqual([four.url, five.url]);
      expect(host.launches.every((launch) => launch.at < START.getTime() + SPAWN_WINDOW_MS)).toBe(true);
      expect(result.skipped).toEqual([{ pr: "me/app#6", reason: expect.stringContaining("spawn window closed") }]);
    });

    it("passes over one tried within 4 h and launches the next", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      registryWith(host, { lastTrys: { "me/app#4": lastTry(ago(HOUR_MS), 4242) } });
      const result = await launchUpgradeDependencyPerRepo(host, listed(four, five));
      expect(launched(host)).toEqual([five.url]);
      expect(result.skipped).toEqual([{ pr: "me/app#4", reason: expect.stringContaining("tried at") }]);
    });

    it("lists every one on a dry run, oldest first, and lists the repository once", async () => {
      const searches: string[][] = [];
      const host = new FakeUpgradeBotHost(START, (args) => {
        if (args[0] === "search") searches.push([...args]);
        return gh()(args);
      });
      const result = await launchUpgradeDependencyPerRepo(host, { ...listed(six, five, four), dryRun: true });
      expect(result.wouldLaunch.map((would) => would.pr)).toEqual(["me/app#4", "me/app#5", "me/app#6"]);
      expect(result.skipped).toEqual([]);
      expect(searches).toEqual([]);
      expect(host.launches).toEqual([]);
    });
  });

  it("asks gh for only a pull request's head, so one that merged since it was listed is left to upgrade_dependency", async () => {
    const asked: string[][] = [];
    const host = new FakeUpgradeBotHost(START, (args) => {
      asked.push([...args]);
      return gh()(args);
    });
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 4, "2026-10-04T00:00:00Z")));
    expect(asked).toEqual([["pr", "view", url("me/app", 4), "--json", "headRefOid", "--jq", ".headRefOid"]]);
    expect(result.launched.map((launch) => launch.pr)).toEqual(["me/app#4"]);
    expect(host.registry()!.lastTrys["me/app#4"]).toMatchObject({ head: HEAD });
  });

  it("skips every pull request of a repository that reaches the tick after the spawn window closed", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.lifetimeMs = SPAWN_WINDOW_MS;
    const busy = Array.from({ length: DEFAULT_LANES }, (_, index) => pull(`me/app${index}`, 1));
    const result = await launchUpgradeDependencyPerRepo(
      host,
      listed(...busy, pull("me/late", 1), pull("me/late", 2)),
    );
    expect(host.launches).toHaveLength(DEFAULT_LANES);
    expect(host.launches.every((launch) => launch.at < START.getTime() + SPAWN_WINDOW_MS)).toBe(true);
    expect(result.skipped.map((skip) => skip.pr)).toEqual(["me/late#1", "me/late#2"]);
  });

  it("records nothing for a run that exits inside the 20 s, so the next tick tries again", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.exitsEarly.set(url("me/app", 1), 2);
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
    expect(host.launches).toHaveLength(1);
    expect(result.launched).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("exited 2");
    expect(host.registry()).toBeUndefined();

    const next = new FakeUpgradeBotHost(START, gh());
    const again = await launchUpgradeDependencyPerRepo(next, listed(pull("me/app", 1)));
    expect(again.launched).toHaveLength(1);
  });

  it.each(["zachbornheimer", "Zysys", "zysys", "ZAB-AI-LLC", "Software-Automation-Holdings-LLC", "isa-sdk"])(
    "holds no owner for billing: a pull request of %s is launched like any other",
    async (owner) => {
      const host = new FakeUpgradeBotHost(START, gh());
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull(`${owner}/tool`, 3)));
      expect(host.launches.map(urlOf)).toEqual([url(`${owner}/tool`, 3)]);
      expect(result.launched.map((launch) => launch.pr)).toEqual([`${owner}/tool#3`]);
      expect(result.skipped).toEqual([]);
      expect(host.registry()!.holds).toEqual({});
    },
  );

  it("works a dry run's zachbornheimer pull request into wouldLaunch, not skipped", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    const result = await launchUpgradeDependencyPerRepo(host, { ...listed(pull("zachbornheimer/tool", 1)), dryRun: true });
    expect(result.wouldLaunch).toEqual([{ pr: "zachbornheimer/tool#1", url: url("zachbornheimer/tool", 1) }]);
    expect(result.skipped).toEqual([]);
  });

  describe("a hold", () => {
    const holdAt = (head: string | undefined, reason = "needs a person") => ({
      until: new Date(START.getTime() + 24 * HOUR_MS).toISOString(),
      reason,
      ...(head === undefined ? {} : { head }),
    });

    it("lifts when the pull request's head is no longer the one it was set on", async () => {
      const host = new FakeUpgradeBotHost(START, gh({ [url("me/app", 1)]: "b".repeat(40) }));
      registryWith(host, { holds: { "me/app#1": holdAt("a".repeat(40)) } });
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(result.launched).toHaveLength(1);
      expect(host.registry()!.holds).toEqual({});
    });

    it("stays while the head is the same", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      registryWith(host, { holds: { "me/app#1": holdAt(HEAD) } });
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(host.launches).toEqual([]);
      expect(result.skipped[0]!.reason).toContain("needs a person");
    });

    it("lifts once its date passes, whatever the head", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      registryWith(host, { holds: { "me/app#1": { until: ago(1000).toISOString(), reason: "x", head: HEAD } } });
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(result.launched).toHaveLength(1);
    });

    it("stays until its date when it names no head, whatever the pull request's head is", () => {
      const hold = { until: new Date(START.getTime() + HOUR_MS).toISOString(), reason: "x" };
      expect(holdInForce(hold, "c".repeat(40), START)).toBe(true);
      expect(holdInForce(hold, undefined, START)).toBe(true);
    });

    it("lifts when its head is not the one read, and stays when that head is unread or the same", () => {
      const hold = { until: new Date(START.getTime() + HOUR_MS).toISOString(), reason: "x", head: HEAD };
      expect(holdInForce(hold, "c".repeat(40), START)).toBe(false);
      expect(holdInForce(hold, undefined, START)).toBe(true);
      expect(holdInForce(hold, HEAD, START)).toBe(true);
    });
  });

  describe("the lanes", () => {
    const MINUTE_MS = 60 * 1000;
    /** `count` repositories of one pull request each, all queued at the start of the tick. */
    const queued = (count: number) => Array.from({ length: count }, (_, index) => pull(`me/repo${index}`, 1));

    it("holds a lane while its run is alive and frees it REPO_HOLD_MS after the run exits", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.lifetimeMs = HOUR_MS;
      await launchUpgradeDependencyPerRepo(host, listed(...queued(DEFAULT_LANES + 1)));
      const [first, , , , fifth] = host.launches;
      expect(fifth!.at - first!.at).toBeGreaterThanOrEqual(HOUR_MS + REPO_HOLD_MS);
      expect(fifth!.at - first!.at).toBeLessThanOrEqual(HOUR_MS + REPO_HOLD_MS + EXIT_POLL_MS);
    });

    it("does not free a lane while its run is still alive, however long that is", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.lifetimeMs = 2.5 * HOUR_MS;
      await launchUpgradeDependencyPerRepo(host, listed(...queued(DEFAULT_LANES + 1)));
      expect(host.launches[DEFAULT_LANES]!.at - host.launches[0]!.at).toBeGreaterThanOrEqual(
        2.5 * HOUR_MS + REPO_HOLD_MS,
      );
    });

    it("keeps a run going past the 3 h spawn window and holds its lane and the lock until 5 min after it exits", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.lifetimeMs = 5 * HOUR_MS;
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(result.launched).toHaveLength(1);
      const released = host.nowMs - host.launches[0]!.at; // the release is the tick's last step
      expect(released).toBeGreaterThanOrEqual(5 * HOUR_MS + REPO_HOLD_MS);
      expect(released).toBeLessThanOrEqual(5 * HOUR_MS + REPO_HOLD_MS + EXIT_POLL_MS);
      expect(host.files.has(LOCK_PATH)).toBe(false);
    });

    it("launches nothing once the spawn window closes, and drains the runs already started", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.lifetimeMs = SPAWN_WINDOW_MS;
      const result = await launchUpgradeDependencyPerRepo(host, listed(...queued(DEFAULT_LANES + 2)));
      expect(SPAWN_WINDOW_MS).toBe(3 * HOUR_MS);
      expect(host.launches).toHaveLength(DEFAULT_LANES);
      expect(host.launches.every((launch) => launch.at < START.getTime() + SPAWN_WINDOW_MS)).toBe(true);
      expect(result.skipped.map((skip) => skip.pr)).toEqual(["me/repo4#1", "me/repo5#1"]);
      expect(result.skipped[0]!.reason).toContain("spawn window closed");
      expect(host.nowMs - START.getTime()).toBeGreaterThanOrEqual(SPAWN_WINDOW_MS + REPO_HOLD_MS);
    });

    it("checks the window again after the head read: no launch at exactly 3 h, one launch just before", async () => {
      const at = (offset: number) => {
        const host: FakeUpgradeBotHost = new FakeUpgradeBotHost(START, (args) => {
          host.nowMs = START.getTime() + offset; // the head read is where the time went
          return gh()(args);
        });
        return host;
      };
      const exactly = at(SPAWN_WINDOW_MS);
      const closed = await launchUpgradeDependencyPerRepo(exactly, listed(pull("me/app", 1)));
      expect(exactly.launches).toEqual([]);
      expect(closed.skipped[0]!.reason).toContain("spawn window closed");
      const before = at(SPAWN_WINDOW_MS - 1);
      await launchUpgradeDependencyPerRepo(before, listed(pull("me/app", 1)));
      expect(before.launches).toHaveLength(1);
    });

    it("holds the lane 5 min after a run that exits inside the 20 s, though nothing is recorded", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.exitsEarly.set(url("me/repo0", 1), 1);
      await launchUpgradeDependencyPerRepo(host, listed(...queued(DEFAULT_LANES + 1)));
      const gap = host.launches[DEFAULT_LANES]!.at - host.launches[0]!.at;
      expect(gap).toBeGreaterThanOrEqual(REPO_HOLD_MS);
      expect(gap).toBeLessThan(REPO_HOLD_MS + EXIT_POLL_MS);
      expect(host.registry()!.lastTrys["me/repo0#1"]).toBeUndefined();
    });

    it("keeps the lane and the lock until the run exits when recording it fails", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.failRegistryWrites = true;
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(result.launched).toHaveLength(1);
      expect(result.skipped).toEqual([{ pr: "me/app#1", reason: expect.stringContaining("recording it failed") }]);
      expect(host.nowMs - host.launches[0]!.at).toBeGreaterThanOrEqual(host.lifetimeMs + REPO_HOLD_MS);
      expect(host.files.has(LOCK_PATH)).toBe(false);
    });

    it("never has more than four runs alive at once, and a repository's second pull request waits for its first", async () => {
      const second = pull("me/repo0", 2, "2026-10-02T00:00:00Z");
      const repos = queued(10);
      const host: FakeUpgradeBotHost = new FakeUpgradeBotHost(
        START,
        gh({}, [], () => [...repos, second].filter((found) => !host.launches.some((l) => l.args.at(-1) === found.url))),
      );
      repos.forEach((found, index) => host.lifetimes.set(found.url, (10 + index * 7) * MINUTE_MS));
      const result = await launchUpgradeDependencyPerRepo(host, listed(...repos, second));
      expect(result.launched.map((launch) => launch.pr).sort()).toEqual(
        [...repos, second].map((found) => found.pr).sort(),
      );
      expect(host.launches).toHaveLength(11);
      expect(host.maxAlive).toBe(DEFAULT_LANES);
      expect(host.launches.every((launch) => launch.aliveAfter <= DEFAULT_LANES)).toBe(true);
      const launchOf = (found: ReturnType<typeof pull>) => host.launches.find((l) => l.args.at(-1) === found.url)!;
      expect(launchOf(second).at - launchOf(repos[0]!).at).toBeGreaterThanOrEqual(10 * MINUTE_MS + REPO_HOLD_MS);
      expect(result.skipped).toEqual([]);
    });

    describe("the lane count, UPGRADE_BOT_PRS_LANES", () => {
      it("is four unless the environment says otherwise", () => {
        expect(DEFAULT_LANES).toBe(4);
        expect(LANES_ENV).toBe("UPGRADE_BOT_PRS_LANES");
        expect(lanesFrom(undefined)).toEqual({ lanes: 4 });
        expect(lanesFrom("")).toEqual({ lanes: 4 });
        expect(lanesFrom("  ")).toEqual({ lanes: 4 });
      });

      it.each([["1", 1], ["2", 2], [" 8 ", 8], ["12", 12]])("reads %j as %d lanes", (raw, lanes) => {
        expect(lanesFrom(raw)).toEqual({ lanes });
      });

      it.each(["0", "-1", "2.5", "many", "4 lanes", "0x4", "1e2"])("refuses %j, keeping four lanes and saying why", (raw) => {
        const read = lanesFrom(raw);
        expect(read.lanes).toBe(DEFAULT_LANES);
        expect(read.problem).toContain(LANES_ENV);
        expect(read.problem).toContain(JSON.stringify(raw));
      });

      it.each([1, 2, 6])("runs %d repositories at once when the environment says %d", async (lanes) => {
        const host = new FakeUpgradeBotHost(START, gh());
        host.lifetimeMs = 10 * MINUTE_MS; // short enough that one lane gets through all eight inside the spawn window
        host.environment.set(LANES_ENV, String(lanes));
        const result = await launchUpgradeDependencyPerRepo(host, listed(...queued(8)));
        expect(host.launches).toHaveLength(8);
        expect(host.maxAlive).toBe(lanes);
        expect(host.launches.slice(0, lanes).every((launch) => launch.at === START.getTime())).toBe(true);
        expect(host.launches[lanes]!.at).toBeGreaterThan(START.getTime());
        expect(result.skipped).toEqual([]);
      });

      it("works four repositories at once when it is unset, and reports no problem", async () => {
        const host = new FakeUpgradeBotHost(START, gh());
        const result = await launchUpgradeDependencyPerRepo(host, listed(...queued(8)));
        expect(host.maxAlive).toBe(4);
        expect(result.skipped).toEqual([]);
      });

      it("falls back to four lanes, launches all the same, and reports the bad value as a skip", async () => {
        const host = new FakeUpgradeBotHost(START, gh());
        host.environment.set(LANES_ENV, "many");
        const result = await launchUpgradeDependencyPerRepo(host, listed(...queued(8)));
        expect(host.launches).toHaveLength(8);
        expect(host.maxAlive).toBe(4);
        expect(result.skipped).toEqual([{ pr: "tick", reason: expect.stringContaining(LANES_ENV) }]);
      });

      it("is read from the process environment by the shell host", () => {
        const shell = () =>
          shellUpgradeBotHost({
            exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
            cwd: "/tmp",
            installed: () => true,
          });
        const saved = process.env[LANES_ENV];
        try {
          process.env[LANES_ENV] = "3";
          expect(shell().env(LANES_ENV)).toBe("3");
          delete process.env[LANES_ENV];
          expect(shell().env(LANES_ENV)).toBeUndefined();
        } finally {
          if (saved === undefined) delete process.env[LANES_ENV];
          else process.env[LANES_ENV] = saved;
        }
      });
    });

    it("gives lanes to the repositories in the order the tick listed them, so the last one waits for a lane", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      const first = pull("me/first", 1, "2026-10-20T00:00:00Z");
      const rest = Array.from({ length: DEFAULT_LANES }, (_, index) =>
        pull(`me/rest${index}`, 1, `2026-10-0${index + 1}T00:00:00Z`)
      );
      await launchUpgradeDependencyPerRepo(host, listed(first, ...rest));
      expect(host.launches.map(urlOf)).toEqual([first, ...rest].map((found) => found.url));
    });

    it("starts the next repository the moment a lane frees up, so every repository gets its turn", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      const repos = queued(6);
      repos.forEach((found, index) => host.lifetimes.set(found.url, index === 2 ? 20 * MINUTE_MS : 2 * HOUR_MS));
      await launchUpgradeDependencyPerRepo(host, listed(...repos));
      const fifth = host.launches[4]!;
      expect(fifth.at - host.launches[0]!.at).toBeLessThanOrEqual(25 * MINUTE_MS + EXIT_POLL_MS);
      expect(host.launches).toHaveLength(6);
    });

    it("launches nothing in a second tick that starts while the first is still running", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.alive.add(process.pid); // the lock file holds this process's pid
      const first = launchUpgradeDependencyPerRepo(host, listed(pull("me/a", 1)));
      for (let turn = 0; turn < 50 && host.launches.length === 0; turn++) await settle(1);
      expect(host.launches).toHaveLength(1);
      const second = await startTick(host, listed(pull("me/b", 1)));
      expect(second.launched).toEqual([]);
      expect(second.skipped).toEqual([{ pr: "tick", reason: expect.stringContaining("lock") }]);
      expect(host.launches).toHaveLength(1);
      const done = await first;
      expect(done.launched.map((launch) => launch.pr)).toEqual(["me/a#1"]);
      expect(host.files.has(LOCK_PATH)).toBe(false);
    });
  });

  describe("cancellation", () => {
    it("records a run that is alive when the call is cancelled, releases the lock and skips the rest", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      const controller = new AbortController();
      host.signal = controller.signal;
      const tick = startTick(host, listed(pull("me/a", 1), pull("me/a", 2), pull("me/b", 1)));
      for (let turn = 0; turn < 50 && host.launches.length < 2; turn++) await settle(1);
      expect(host.launches).toHaveLength(2);
      controller.abort(new Error("cancelled by user"));
      const result = await tick;
      expect(result.launched.map((launch) => launch.pr).sort()).toEqual(["me/a#1", "me/b#1"]);
      expect(Object.keys(host.registry()!.lastTrys).sort()).toEqual(["me/a#1", "me/b#1"]);
      expect(host.files.has(LOCK_PATH)).toBe(false);
      expect(result.skipped.some((skip) => skip.pr === "tick" && skip.reason.startsWith("cancelled"))).toBe(true);
    });

    it("launches nothing when the call is already cancelled", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      const controller = new AbortController();
      controller.abort(new Error("cancelled by user"));
      host.signal = controller.signal;
      const result = await startTick(host, listed(pull("me/a", 1)));
      expect(host.launches).toEqual([]);
      expect(result.skipped.map((skip) => skip.pr)).toContain("me/a#1");
      expect(host.files.has(LOCK_PATH)).toBe(false);
    });
  });

  it("lists what it would launch on a dry run and launches, writes and locks nothing", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    const result = await launchUpgradeDependencyPerRepo(
      host,
      { ...listed(pull("me/app", 2), pull("me/app", 1), pull("zachbornheimer/tool", 1)), dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.wouldLaunch).toEqual([
      { pr: "me/app#1", url: url("me/app", 1) },
      { pr: "me/app#2", url: url("me/app", 2) },
      { pr: "zachbornheimer/tool#1", url: url("zachbornheimer/tool", 1) },
    ]);
    expect(result.launched).toEqual([]);
    expect(host.launches).toEqual([]);
    expect(host.writtenPaths).toEqual([]);
    expect(host.files.size).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it("writes the registry through a temp file and a rename", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
    expect(host.renames).toHaveLength(1);
    expect(host.renames[0]!.to).toBe(REGISTRY_PATH);
    expect(host.renames[0]!.from).not.toBe(REGISTRY_PATH);
    expect(host.writtenPaths).not.toContain(REGISTRY_PATH);
  });

  it("wraps a repository's failure as skips and still launches the others", async () => {
    const host = new FakeUpgradeBotHost(START, gh({}, [url("me/broken", 1)]));
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/broken", 1), pull("me/fine", 1)));
    expect(result.launched.map((launch) => launch.pr)).toEqual(["me/fine#1"]);
    expect(result.skipped).toEqual([{ pr: "me/broken#1", reason: expect.stringContaining("HTTP 502") }]);
  });

  it("reports an unreadable registry as a skip instead of throwing", async () => {
    const host = new FakeUpgradeBotHost(START, gh());
    host.files.set(REGISTRY_PATH, "{not json");
    const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
    expect(host.launches).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ pr: "tick" });
    expect(result.skipped[0]!.reason).toContain("not a valid registry");
    expect(host.files.has(LOCK_PATH)).toBe(false);
  });

  describe("the tick lock", () => {
    const lockOf = (pid: number, startedAt: Date) =>
      JSON.stringify({ pid, startedAt: startedAt.toISOString(), token: `token-${pid}` });

    it("records the tick's pid, start and token", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      let seen: string | undefined;
      host.lifetimeMs = 60 * 1000;
      const tick = launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      for (let turn = 0; turn < 50 && seen === undefined; turn++) {
        await settle(1);
        seen = host.files.get(LOCK_PATH);
      }
      expect(JSON.parse(seen!)).toEqual({
        pid: process.pid,
        startedAt: START.toISOString(),
        token: expect.any(String),
      });
      await tick;
    });

    it.each([1, 3, 5, 48])("launches nothing while a live tick %d h old holds the lock", async (hours) => {
      const host = new FakeUpgradeBotHost(START, gh());
      const held = lockOf(777, ago(hours * HOUR_MS));
      host.files.set(LOCK_PATH, held);
      host.alive.add(777);
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(host.launches).toEqual([]);
      expect(result.launched).toEqual([]);
      expect(result.skipped).toEqual([{ pr: "tick", reason: expect.stringContaining("still running") }]);
      expect(host.files.get(LOCK_PATH)).toBe(held);
    });

    it("fails closed on a malformed lock and leaves it in place", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.files.set(LOCK_PATH, "{\"pid\":");
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(host.launches).toEqual([]);
      expect(result.skipped).toEqual([{ pr: "tick", reason: expect.stringContaining("malformed") }]);
      expect(host.files.get(LOCK_PATH)).toBe("{\"pid\":");
    });

    it("recovers a dead tick's lock, and removes it when the tick ends", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.files.set(LOCK_PATH, lockOf(777, ago(60 * 1000)));
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      expect(result.launched).toHaveLength(1);
      expect(host.files.has(LOCK_PATH)).toBe(false);
      expect(host.files.has(`${LOCK_PATH}.reclaim`)).toBe(false);
    });

    it("after recovering a dead tick's lock, launches nothing while that tick's run lives in another repository", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.files.set(LOCK_PATH, lockOf(777, ago(HOUR_MS)));
      host.alive.add(4242); // the orphaned run the dead tick launched for me/busy
      registryWith(host, { lastTrys: { "me/busy#1": lastTry(ago(10 * HOUR_MS), 4242) } });
      const result = await launchUpgradeDependencyPerRepo(host, listed(pull("me/free", 1), pull("me/other", 1)));
      expect(host.launches).toEqual([]);
      expect(result.skipped).toEqual([{ pr: "tick", reason: expect.stringContaining("still running") }]);
    });

    it("lets only one of two ticks started together launch", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.alive.add(process.pid);
      const [first, second] = await host.run(Promise.all([
        startTick(host, listed(pull("me/a", 1))),
        startTick(host, listed(pull("me/b", 1))),
      ]));
      expect(first.launched.length + second.launched.length).toBe(1);
      expect(host.launches).toHaveLength(1);
      expect([...first.skipped, ...second.skipped]).toEqual([{ pr: "tick", reason: expect.any(String) }]);
    });

    it("lets only one of two ticks recovering the same dead lock together launch", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.files.set(LOCK_PATH, lockOf(777, ago(HOUR_MS)));
      host.alive.add(process.pid);
      const [first, second] = await host.run(Promise.all([
        startTick(host, listed(pull("me/a", 1))),
        startTick(host, listed(pull("me/b", 1))),
      ]));
      expect(first.launched.length + second.launched.length).toBe(1);
      expect(host.launches).toHaveLength(1);
    });

    it("does not remove a lock another tick holds when this one releases", async () => {
      const host = new FakeUpgradeBotHost(START, gh());
      host.lifetimeMs = HOUR_MS;
      const tick = launchUpgradeDependencyPerRepo(host, listed(pull("me/app", 1)));
      for (let turn = 0; turn < 50 && host.launches.length === 0; turn++) await settle(1);
      const successor = lockOf(888, START);
      host.files.set(LOCK_PATH, successor);
      await tick;
      expect(host.files.get(LOCK_PATH)).toBe(successor);
    });
  });

  describe("the tick lock on the real file system, raced", () => {
    let home = "";
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "upgrade-bot-lock-"));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    const realHost = () => ({
      ...shellUpgradeBotHost({ exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }), cwd: home, installed: () => true }),
      home: () => home,
    });
    const lockFile = () => join(home, ".config/webmaster/registry-upgrade_dependency.lock");
    const RACERS = 24;
    const race = () => Promise.all(Array.from({ length: RACERS }, () => takeLock(realHost(), new Date())));
    const winners = (outcomes: LockOutcome[]) => outcomes.filter((outcome) => "release" in outcome);
    /** A pid that was real and has exited. */
    const deadPid = () => spawnSync("true").pid!;

    it("gives the lock to exactly one of many concurrent acquirers", async () => {
      const outcomes = await race();
      expect(winners(outcomes)).toHaveLength(1);
      const left = await readdir(dirname(lockFile()));
      expect(left).toEqual(["registry-upgrade_dependency.lock"]);
    });

    it("lets exactly one of many concurrent recoverers take a dead owner's lock, and leaves no guard", async () => {
      await mkdir(dirname(lockFile()), { recursive: true });
      await writeFile(
        lockFile(),
        JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), token: "dead" }),
      );
      const outcomes = await race();
      expect(winners(outcomes)).toHaveLength(1);
      const owner = JSON.parse(await readFile(lockFile(), "utf8")) as { pid: number; token: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).not.toBe("dead");
      expect(await readdir(dirname(lockFile()))).toEqual(["registry-upgrade_dependency.lock"]);
    });

    it("refuses every acquirer of a malformed lock and keeps it", async () => {
      await mkdir(dirname(lockFile()), { recursive: true });
      await writeFile(lockFile(), "not json");
      expect(winners(await race())).toHaveLength(0);
      expect(await readFile(lockFile(), "utf8")).toBe("not json");
    });

    it("releases only its own lock", async () => {
      const outcome = await takeLock(realHost(), new Date());
      if (!("release" in outcome)) throw new Error("the lock was not taken");
      const successor = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "successor" });
      await writeFile(lockFile(), successor);
      await outcome.release();
      expect(await readFile(lockFile(), "utf8")).toBe(successor);
    });

    it("launches a real detached process into its log and reports its exit code", async () => {
      const host = realHost();
      const log = join(home, "logs", "run.log");
      const run = host.launch("node", ["-e", "console.log('started'); process.exit(3)"], log);
      expect(run.pid).toBeGreaterThan(0);
      expect(await run.exit).toBe(3);
      expect(await readFile(log, "utf8")).toContain("started");
      expect(host.isAlive(run.pid)).toBe(false);
      expect(() => host.launch("definitely-not-a-program-xyz", [], log)).toThrow("did not start");
    });

    it("writes the registry through a real temp file and rename, and reads a missing file as absent", async () => {
      const host = realHost();
      const path = join(home, "deep", "registry.json");
      expect(await host.readText(path)).toBeUndefined();
      await host.writeText(`${path}.tmp`, "{}");
      await host.rename(`${path}.tmp`, path);
      expect(await host.readText(path)).toBe("{}");
      await host.remove(path);
      expect(await host.readText(path)).toBeUndefined();
    });

    it("cancels a real sleep at once", async () => {
      const controller = new AbortController();
      const host = shellUpgradeBotHost({
        exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
        cwd: home,
        signal: controller.signal,
        installed: () => true,
      });
      const sleeping = host.sleep(60_000);
      controller.abort(new Error("stop"));
      await expect(sleeping).rejects.toThrow("stop");
    });
  });

  describe("tool discovery check", () => {
    let home = "";
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "upgrade-bot-tools-"));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("finds a tool as a directory or a file in the home tools directory or the project's", async () => {
      expect(toolInstalled(home, "upgrade_dependency", home)).toBe(false);
      await mkdir(join(home, ".omp/agent/tools/upgrade_dependency"), { recursive: true });
      await writeFile(join(home, ".omp/agent/tools/upgrade_dependency/index.ts"), "");
      expect(toolInstalled("/nonexistent", "upgrade_dependency", home)).toBe(true);
      await mkdir(join(home, "proj/.omp/tools"), { recursive: true });
      await writeFile(join(home, "proj/.omp/tools/other.ts"), "");
      expect(toolInstalled(join(home, "proj"), "other", "/nonexistent")).toBe(true);
    });
  });
});

describe("upgrade_bot_prs: the tool", () => {
  it("has a description of 80 to 250 words that states the boundaries", () => {
    const words = DESCRIPTION.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const phrase of ["dryRun", "BLOCKED", "NOT ported", "ai:dependencies-checked", "UPGRADE_BOT_PRS_LANES", "Returns"]) {
      expect(DESCRIPTION).toContain(phrase);
    }
  });

  it("summarizes a result in lines", () => {
    const text = summarize({
      dryRun: false,
      repos: 2,
      launched: [{ pr: "a/b#1", url: "u", pid: 5 }],
      wouldLaunch: [],
      skipped: [{ pr: "c/d#2", reason: "held" }],
    });
    expect(text).toBe("tick: 2 repositories, 1 launched, 1 skipped\nlaunched a/b#1 pid 5\nskipped c/d#2: held");
  });

  it("runs a dry run end to end through its factory with a fake pi.exec and launches nothing", async () => {
    /** A chainable stand-in for `pi.zod`: the schema's shape is checked by the load check outside the suite. */
    const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
    const calls: string[][] = [];
    const pi = {
      cwd: "/tmp",
      zod: chain,
      exec: async (_bin: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "api" && args[1] === "user") return { stdout: "me\n", stderr: "", code: 0, killed: false };
        if (args[0] === "api") return { stdout: "", stderr: "", code: 0, killed: false };
        if (args[0] === "search") {
          return {
            stdout: JSON.stringify([{
              repository: { nameWithOwner: "me/app" },
              number: 3,
              url: url("me/app", 3),
              author: { login: "renovate[bot]", type: "Bot" },
              isDraft: false,
              labels: [],
              createdAt: "2026-10-01T00:00:00Z",
            }]),
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: `${HEAD}\n`, stderr: "", code: 0, killed: false };
      },
    };
    const tool = (await (factory as unknown as (pi: unknown) => Promise<{
      name: string;
      execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { wouldLaunch: unknown[] } }>;
    }>)(pi));
    expect(tool.name).toBe("upgrade_bot_prs");
    const outcome = await tool.execute("id", { dryRun: true }, undefined, undefined, undefined);
    expect(outcome.details.wouldLaunch).toEqual([{ pr: "me/app#3", url: url("me/app", 3) }]);
    expect(outcome.content[0]!.text).toContain("would launch me/app#3");
    expect(calls.every((args) => args[0] === "api" || args[0] === "search" || args[0] === "pr")).toBe(true);
  });
});

describe("upgrade_bot_prs: constants the tests rely on", () => {
  it("watches a launched run for 20 s before it counts as running", () => {
    expect(LAUNCH_WAIT_MS).toBe(20_000);
  });
});
