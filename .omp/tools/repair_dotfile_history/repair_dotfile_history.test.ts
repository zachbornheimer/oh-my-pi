/**
 * `repair_dotfile_history` against a temp git store. Real git, real `cp` and `mv`; `launchctl`, `pgrep` and `mise` are
 * fakes (see fake_world.ts). Nothing here reads or writes the real home directory, the real history store or the real
 * dotfiles repository.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENCRYPTED, OTHER_PATH, TOOL_PATH, type World, type WorldOptions, makeWorld, sh } from "./fake_world.ts";
import {
  ENCRYPTED_PREFIX,
  type GitRunner,
  allowsPlaintextHistory,
  blobAt,
  blobIsEncrypted,
  filterBranchCommand,
  gitArgs,
  livePathFor,
  plaintextCommits,
  refuseIfPublished,
  storePathFor,
} from "./history.ts";
import { DESCRIPTION, buildTool, renderReport } from "./index.ts";
import { repairDotfileHistory } from "./repair.ts";

const HOME = "/Users/tester";
const worlds: World[] = [];
const world = (options: WorldOptions = {}): World => {
  const made = makeWorld(options);
  worlds.push(made);
  return made;
};
afterEach(() => {
  for (const made of worlds.splice(0)) made.cleanup();
});

const storeGit: (dir: string) => GitRunner = (dir) => async (args, repoDir) => sh(repoDir || dir, "git", args);
const used = (w: World, command: string): string[][] => w.calls.filter((call) => call.command === command).map((call) => [...call.args]);

describe("storePathFor", () => {
  it("maps a leading-~ live path to the store-relative home/ path", () => {
    expect(storePathFor("~/.local/bin/_llm", HOME)).toBe("home/.local/bin/_llm");
  });

  it("maps an absolute path under home the same way", () => {
    expect(storePathFor(`${HOME}/.config/git/config`, HOME)).toBe("home/.config/git/config");
  });

  it("passes an already store-relative path through unchanged", () => {
    expect(storePathFor("home/.zshrc", HOME)).toBe("home/.zshrc");
  });

  it("refuses paths outside the home tree, quotes, newlines, and emptiness", () => {
    expect(() => storePathFor("/etc/passwd", HOME)).toThrow();
    expect(() => storePathFor("~/evil'; rm -rf /", HOME)).toThrow();
    expect(() => storePathFor("~/a\nb", HOME)).toThrow();
    expect(() => storePathFor("  ", HOME)).toThrow();
    expect(() => storePathFor("~", HOME)).toThrow();
  });

  it("refuses what the source let through: quotes after home/, $(...) and glob syntax, .. segments, trailing slashes", () => {
    for (const bad of [
      "home/x'y",
      'home/x"y',
      "home/a\nb",
      "~/a/../b",
      "home/../etc",
      "~/dir/",
      "~/a//b",
      "~/*.conf",
      "~/a[1]",
      "~/a?b",
      "~/a\\b",
      "home/",
      "~/\u0007bell",
    ]) {
      expect(() => storePathFor(bad, HOME)).toThrow();
    }
    // `$` and backticks stay literal now that nothing is handed to a shell, and the index filter single-quotes them.
    expect(storePathFor("~/$(id)", HOME)).toBe("home/$(id)");
  });

  it("derives the absolute live path from a store path", () => {
    expect(livePathFor("home/.local/bin/_llm", HOME)).toBe(`${HOME}/.local/bin/_llm`);
    expect(() => livePathFor("etc/passwd", HOME)).toThrow();
  });
});

describe("the argument builders", () => {
  it("builds the filter-branch call with every path single-quoted in the index filter and no shell around it", () => {
    const { command, args } = filterBranchCommand("/s/copy.git", ["home/.a", "home/b c"]);
    expect(command).toBe("env");
    expect(args).toContain("git");
    expect(args).toContain("--index-filter");
    expect(args[args.indexOf("--index-filter") + 1]).toBe("git rm --cached --ignore-unmatch -- 'home/.a' 'home/b c'");
    expect(args.slice(-2)).toEqual(["--", "main"]);
    expect(args).toContain("GIT_LITERAL_PATHSPECS=1");
  });

  it("builds git calls with literal pathspecs", () => {
    expect(gitArgs("/s", ["rev-parse", "main"])).toEqual(["--literal-pathspecs", "-C", "/s", "rev-parse", "main"]);
  });

  it("detects the plaintext escape hatch anywhere in a command", () => {
    expect(allowsPlaintextHistory("mise", ["dot", "sync", "--allow-plaintext-history"])).toBe(true);
    expect(allowsPlaintextHistory("sh", ["-c", "mise dot sync --allow-plaintext-history"])).toBe(true);
    expect(allowsPlaintextHistory("mise", ["dot", "sync"])).toBe(false);
  });
});

describe("the plaintext-blob scan", () => {
  it("flags a blob without the encrypted prefix as plaintext", () => {
    expect(blobIsEncrypted(`${ENCRYPTED_PREFIX}:...`)).toBe(true);
    expect(blobIsEncrypted("#!/bin/sh")).toBe(false);
    expect(blobIsEncrypted(`\n${ENCRYPTED_PREFIX}`)).toBe(false);
  });

  it("reports exactly the plaintext commits reachable from the ref, newest first", async () => {
    const w = world();
    const offenses = await plaintextCommits(storeGit(w.storeDir), w.storeDir, "main", [TOOL_PATH]);
    expect(offenses).toEqual([{ storePath: TOOL_PATH, commits: [w.shas.c3, w.shas.c2] }]);
  });

  it("reports nothing for an encrypted path and for a path no commit touches", async () => {
    const w = world();
    const offenses = await plaintextCommits(storeGit(w.storeDir), w.storeDir, "main", [OTHER_PATH, "home/absent"]);
    expect(offenses.map((offense) => offense.commits)).toEqual([[], []]);
  });

  it("does not count a commit that removed the path", async () => {
    const w = world();
    const git = storeGit(w.storeDir);
    // A commit on top of main with the path deleted: its tree lacks the path, so it adds no offender.
    const index = join(w.root, "idx");
    const env = { GIT_INDEX_FILE: index };
    sh(w.storeDir, "git", ["read-tree", "main"], undefined, env);
    sh(w.storeDir, "git", ["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${TOOL_PATH}\n`, env);
    const tree = sh(w.storeDir, "git", ["write-tree"], undefined, env);
    const removal = sh(w.storeDir, "git", ["commit-tree", tree, "-p", "main", "-m", "rm"], undefined, env);
    const offenses = await plaintextCommits(git, w.storeDir, removal, [TOOL_PATH]);
    expect(offenses[0]?.commits).toEqual([w.shas.c3, w.shas.c2]);
  });

  it("refuses a directory path instead of reading a tree as a blob", async () => {
    const w = world();
    await expect(blobAt(storeGit(w.storeDir), w.storeDir, "main", "home/.local")).rejects.toThrow(/not a file/);
  });
});

describe("the origin-reachable refusal", () => {
  it("passes when no plaintext is reachable from origin/setup", async () => {
    const w = world();
    await expect(refuseIfPublished(storeGit(w.storeDir), w.storeDir, [TOOL_PATH])).resolves.toBeUndefined();
  });

  it("refuses, naming the commits, when published history holds plaintext", async () => {
    const w = world({ origin: "plaintext" });
    await expect(refuseIfPublished(storeGit(w.storeDir), w.storeDir, [TOOL_PATH])).rejects.toThrow(
      new RegExp(`refusing repair: .*${TOOL_PATH}: ${w.shas.c2}`),
    );
  });
});

describe("repairDotfileHistory: guards", () => {
  it("refuses before anything moves when plaintext is published, touching no service and making no work directory", async () => {
    const w = world({ origin: "plaintext" });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: false }, w.ports)).rejects.toThrow(/refusing repair/);
    expect(w.refs()).toEqual(before);
    expect(used(w, "launchctl")).toEqual([]);
    expect(used(w, "mise")).toEqual([]);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a path with no plaintext commit, because rewriting would only erase its history", async () => {
    const w = world();
    const before = w.refs();
    await expect(repairDotfileHistory({ paths: [`~/${OTHER_PATH.slice(5)}`], dryRun: true }, w.ports)).rejects.toThrow(
      /nothing to repair: .*home\/\.zshrc/,
    );
    expect(w.refs()).toEqual(before);
  });

  it("refuses an unusable path before any git call", async () => {
    const w = world();
    await expect(repairDotfileHistory({ paths: ["~/x'y"], dryRun: true }, w.ports)).rejects.toThrow(/single literal git path/);
    await expect(repairDotfileHistory({ paths: ["/etc/passwd"], dryRun: true }, w.ports)).rejects.toThrow(/not under the home tree/);
    await expect(repairDotfileHistory({ paths: ["~/.local/bin/tool", "home/.local/bin/tool"], dryRun: true }, w.ports)).rejects.toThrow(/twice/);
    expect(w.calls).toEqual([]);
  });

  it("fails clearly when there is no store", async () => {
    const w = world();
    await expect(
      repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: true }, { ...w.ports, storeDir: join(w.root, "missing.git") }),
    ).rejects.toThrow(/no history store at/);
  });
});

describe("repairDotfileHistory: dry run", () => {
  it("rewrites and verifies in a private copy, and leaves the store, the refs and the services alone", async () => {
    const w = world();
    const before = w.refs();
    const progress: string[] = [];
    const report = await repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: true }, { ...w.ports, progress: (m) => progress.push(m) });

    expect(w.refs()).toEqual(before);
    expect(used(w, "launchctl")).toEqual([]);
    expect(used(w, "mise")).toEqual([]);
    expect(used(w, "pgrep")).toEqual([]);

    expect(report).toMatchObject({
      dry_run: true,
      old_main: w.shas.c4,
      origin_tip_before: w.shas.c1,
      origin_tip_after: w.shas.c1,
      offenders_removed: [{ path: "~/.local/bin/tool", store_path: TOOL_PATH, plaintext_commits: 2 }],
      services_stopped: false,
      services_restored: true,
      publish_succeeded: null,
      remaining_offenders: [],
    });
    expect(report.backups.bak_dir).toBeNull();
    expect(report.new_main).not.toBe(w.shas.c4);

    // The copy has no plaintext for the path and still has the other file and the guard refs.
    const copy = report.backups.copy;
    expect(sh(copy, "git", ["rev-parse", "main"])).toBe(report.new_main);
    expect(sh(copy, "git", ["ls-tree", "-r", "--name-only", "main"])).toBe(OTHER_PATH);
    expect(sh(copy, "git", ["rev-parse", "origin/setup"])).toBe(w.shas.c1);
    expect(sh(copy, "git", ["rev-parse", "backup-1"])).toBe(w.shas.c1);
    expect(sh(copy, "git", ["for-each-ref", "refs/original"])).toBe("");
    // The bundle is non-empty and the work directory is private.
    expect(statSync(report.backups.bundle).size).toBeGreaterThan(0);
    const workDir = join(report.backups.copy, "..");
    expect(statSync(workDir).mode & 0o077).toBe(0);
    expect(workDir.startsWith(w.tmpRoot)).toBe(true);
    expect(progress.length).toBeGreaterThan(3);
  });

  it("is repeatable: a second dry run makes a second private directory and still changes nothing", async () => {
    const w = world();
    const before = w.refs();
    await repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: true }, w.ports);
    await repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: true }, w.ports);
    expect(readdirSync(w.tmpRoot)).toHaveLength(2);
    expect(w.refs()).toEqual(before);
  });
});

describe("repairDotfileHistory: the real run", () => {
  it("stops the services, swaps the verified copy in, re-saves, publishes and restores the services", async () => {
    const w = world();
    const report = await repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: false }, w.ports);

    expect(report).toMatchObject({
      dry_run: false,
      old_main: w.shas.c4,
      origin_tip_before: w.shas.c1,
      services_stopped: false,
      services_restored: true,
      publish_succeeded: true,
      remaining_offenders: [],
    });
    // The store now holds the rewritten history plus the re-saved encrypted blob, and published it.
    expect(w.git("rev-parse", "main")).not.toBe(w.shas.c4);
    expect(w.git("show", `main:${TOOL_PATH}`)).toBe(ENCRYPTED);
    expect(w.git("rev-list", "main", "--", TOOL_PATH).split("\n")).toHaveLength(1);
    expect(report.origin_tip_after).toBe(w.git("rev-parse", "main"));
    expect(report.origin_tip_after).not.toBe(report.origin_tip_before);
    expect(w.git("rev-parse", "backup-1")).toBe(w.shas.c1);
    // The original is kept, and the pre-repair bundle exists.
    expect(report.backups.bak_dir).toBe(`${w.storeDir}.bak-2026-11-06T12-00-00-000Z`);
    expect(sh(report.backups.bak_dir!, "git", ["rev-parse", "main"])).toBe(w.shas.c4);
    expect(existsSync(report.backups.bundle)).toBe(true);
    expect(w.state.watcher).toBe(true);
  });

  it("runs the steps in order, with argument lists and never the plaintext escape hatch", async () => {
    const w = world();
    await repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: false }, w.ports);
    const sequence = w.calls
      .filter((call) => call.command !== "git" && call.command !== "pgrep")
      .map((call) => [call.command, ...call.args.slice(0, 3)].join(" "));
    const at = (prefix: string): number => sequence.findIndex((line) => line.startsWith(prefix));
    expect(at("launchctl bootout")).toBe(0);
    expect(at("launchctl bootout")).toBeLessThan(at("/bin/cp"));
    expect(at("/bin/cp")).toBeLessThan(at("env FILTER_BRANCH_SQUELCH_WARNING=1"));
    expect(at("env FILTER_BRANCH_SQUELCH_WARNING=1")).toBeLessThan(at("mv"));
    expect(at("mv")).toBeLessThan(at("mise dot save"));
    expect(at("mise dot save")).toBeLessThan(at("mise dot sync"));
    expect(at("mise dot sync")).toBeLessThan(at("mise bootstrap services"));
    expect(used(w, "launchctl").map((args) => args[1])).toEqual([
      "gui/501/dev.mise.mise-history-watchdog",
      "gui/501/dev.mise.mise-history",
    ]);
    for (const call of w.calls) expect(allowsPlaintextHistory(call.command, call.args)).toBe(false);
    // The live path is passed to mise as an absolute path, as a shell would have expanded it.
    expect(used(w, "mise").find((args) => args[1] === "save")).toEqual(["dot", "save", `${w.home}/.local/bin/tool`]);
  });

  it("re-saves a store-relative input under its live absolute path (the source passed `home/...` relative to home)", async () => {
    const w = world();
    await repairDotfileHistory({ paths: [TOOL_PATH], dryRun: false }, w.ports);
    expect(used(w, "mise").find((args) => args[1] === "save")).toEqual(["dot", "save", `${w.home}/.local/bin/tool`]);
  });

  it("retries a save that hits the history lock, waiting between attempts", async () => {
    const w = world({ lockedOnce: true });
    const report = await repairDotfileHistory({ paths: ["~/.local/bin/tool"], dryRun: false }, w.ports);
    expect(report.publish_succeeded).toBe(true);
    expect(used(w, "mise").filter((args) => args[1] === "save")).toHaveLength(2);
    expect(w.sleeps).toContain(3000);
  });
});

describe("repairDotfileHistory: failures restore the original", () => {
  const paths = ["~/.local/bin/tool"];
  const restored = (w: World, before: string[]): void => {
    expect(w.refs()).toEqual(before);
    expect(w.git("rev-parse", "main")).toBe(w.shas.c4);
    expect(existsSync(`${w.storeDir}.bak-2026-11-06T12-00-00-000Z`)).toBe(false);
    expect(w.state.watcher).toBe(true);
  };

  it("restores the store and the services when the re-save leaves plaintext", async () => {
    const w = world({ save: "plaintext" });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports)).rejects.toThrow(/re-save left plaintext blobs/);
    restored(w, before);
    expect(used(w, "mise").some((args) => args[1] === "sync")).toBe(false);
  });

  it("restores when the re-save puts no encrypted blob in the store (the source only looked for plaintext)", async () => {
    const w = world({ save: "nothing" });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports)).rejects.toThrow(/did not leave an encrypted blob/);
    restored(w, before);
  });

  it("restores when mise cannot publish", async () => {
    const w = world({ sync: "cannot-publish" });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports)).rejects.toThrow(/could not publish/);
    restored(w, before);
  });

  it("stops before touching the store when the watcher survives the service stop, and brings the services back", async () => {
    const w = world({ stubbornWatcher: true });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports)).rejects.toThrow(/still running after the services were stopped/);
    expect(w.refs()).toEqual(before);
    expect(existsSync(`${w.storeDir}.bak-2026-11-06T12-00-00-000Z`)).toBe(false);
    expect(used(w, "mise").some((args) => args[0] === "bootstrap")).toBe(true);
    expect(used(w, "mise").some((args) => args[1] === "save")).toBe(false);
  });

  it("removes a partial store left by a failed copy-in before moving the original back, never nesting it", async () => {
    const w = world({ copyIntoStoreFails: true });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports)).rejects.toThrow(/no space left/);
    restored(w, before);
    expect(existsSync(join(w.storeDir, "partial"))).toBe(false);
    expect(existsSync(join(w.storeDir, "repo.git.bak-2026-11-06T12-00-00-000Z"))).toBe(false);
  });

  it("restores after an abort even though the abort signal is already set", async () => {
    const controller = new AbortController();
    const w = world({ abortOnSave: controller });
    const before = w.refs();
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports, controller.signal)).rejects.toBeDefined();
    restored(w, before);
  });

  it("keeps the repaired store when the publish already succeeded and only the service restart fails, and says so", async () => {
    const w = world({ servicesStayDown: true });
    await expect(repairDotfileHistory({ paths, dryRun: false }, w.ports)).rejects.toThrow(/repaired store was KEPT/);
    expect(w.git("rev-parse", "main")).not.toBe(w.shas.c4);
    expect(w.git("show", `main:${TOOL_PATH}`)).toBe(ENCRYPTED);
    expect(w.git("rev-parse", "origin/setup")).toBe(w.git("rev-parse", "main"));
    expect(existsSync(`${w.storeDir}.bak-2026-11-06T12-00-00-000Z`)).toBe(true);
  });

  it("refuses to run a command that passes the plaintext escape hatch, whatever built it", async () => {
    const w = world();
    const poisoned = { ...w.ports, home: w.home };
    // A path cannot smuggle the flag into a command: it is just another literal path and is scanned like one.
    await expect(repairDotfileHistory({ paths: ["~/--allow-plaintext-history"], dryRun: true }, poisoned)).rejects.toThrow(
      /refusing to run a command that passes --allow-plaintext-history/,
    );
  });
});

/** A `pi` whose `zod` accepts any chain of builder calls; the real omptype is checked outside the suite. */
function stubPi(exec: (command: string, args: string[], options?: unknown) => Promise<unknown>) {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return { zod: new Proxy({}, { get: () => chain }), exec, cwd: "/" } as unknown as Parameters<typeof buildTool>[0];
}

describe("the tool", () => {
  it("runs a dry run through pi.exec with the temp ports and renders the report", async () => {
    const w = world();
    const piExec: string[] = [];
    const pi = stubPi(async (command, args, options) => {
      piExec.push(command);
      expect(typeof (options as { cwd?: unknown }).cwd).toBe("string");
      return w.ports.exec(command, args, options as never);
    });
    const tool = buildTool(pi, { home: w.home, storeDir: w.storeDir, tmpRoot: w.tmpRoot, now: w.ports.now, sleep: w.ports.sleep });
    const updates: string[] = [];
    const result = await tool.execute("id", { paths: ["~/.local/bin/tool"], dryRun: true }, (partial) => updates.push(partial.content[0]!.text), undefined, undefined);
    expect(result.details.dry_run).toBe(true);
    expect(result.content[0]!.text.startsWith("DRY RUN: the rewrite of ~/.local/bin/tool (2 plaintext commit(s))")).toBe(true);
    expect(JSON.parse(result.content[0]!.text.split("\n")[1]!)).toEqual(result.details);
    expect(piExec).toContain("git");
    expect(updates.some((line) => line.includes("rewriting main in the copy"))).toBe(true);
  });

  it("fails the call, instead of returning a failure as success, when the repair fails", async () => {
    const w = world({ origin: "plaintext" });
    const tool = buildTool(stubPi((command, args, options) => w.ports.exec(command, args, options as never)), {
      home: w.home,
      storeDir: w.storeDir,
      tmpRoot: w.tmpRoot,
    });
    await expect(tool.execute("id", { paths: ["~/.local/bin/tool"], dryRun: false }, undefined, undefined, undefined)).rejects.toThrow(/refusing repair/);
  });

  it("clears its heartbeat timer, success or failure", async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let started = 0;
    let cleared = 0;
    globalThis.setInterval = ((handler: () => void) => {
      started += 1;
      handler();
      return 1;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared += 1;
    }) as unknown as typeof clearInterval;
    try {
      const w = world({ origin: "plaintext" });
      const tool = buildTool(stubPi((command, args, options) => w.ports.exec(command, args, options as never)), {
        home: w.home,
        storeDir: w.storeDir,
        tmpRoot: w.tmpRoot,
      });
      await expect(tool.execute("id", { paths: ["~/.local/bin/tool"], dryRun: true }, () => undefined, undefined, undefined)).rejects.toThrow();
      expect([started, cleared]).toEqual([1, 1]);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  it("renders a real run as repaired and names where the original went", () => {
    const text = renderReport({
      dry_run: false,
      old_main: "a",
      new_main: "b",
      origin_tip_before: "c",
      origin_tip_after: "d",
      offenders_removed: [{ path: "~/x", store_path: "home/x", plaintext_commits: 1 }],
      backups: { bundle: "/t/b.bundle", copy: "/t/c.git", bak_dir: "/s/repo.git.bak-1" },
      services_stopped: false,
      services_restored: true,
      publish_succeeded: true,
      remaining_offenders: [],
    });
    expect(text.split("\n")[0]).toBe("REPAIRED ~/x (1 plaintext commit(s)): published, services restored. The original store is at /s/repo.git.bak-1.");
  });

  it("has the shape of a custom tool and a description in the house style that makes dryRun explicit", () => {
    const tool = buildTool(stubPi(async () => ({})));
    expect(tool.name).toBe("repair_dotfile_history");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("`dryRun` is REQUIRED");
    expect(DESCRIPTION).toContain("ALWAYS call with `dryRun:true` first");
    expect(DESCRIPTION).toContain("NEVER passes `--allow-plaintext-history`");
  });
});
