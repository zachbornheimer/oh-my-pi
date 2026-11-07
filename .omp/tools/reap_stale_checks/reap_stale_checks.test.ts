import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentHost,
  agentStatus,
  agentsFor,
  installAgents,
  type Launchctl,
  nodeBinary,
  plistFor,
  REAPER_AGENTS,
  uninstallAgents,
} from "./agents.ts";
import factory from "./index.ts";
import { SCANNER_SOURCE } from "./scanner_source.ts";
import { parseInput, reapText, runReap } from "./reap.ts";
import {
  hasNoControllingTty,
  killAll,
  OMP_ORPHAN_MIN_AGE_MINUTES,
  type Process,
  parseEtime,
  parseProcessTable,
  runScan,
  type ScanDeps,
  selectCandidates,
} from "./reap_scan.mjs";

/**
 * The scanner's passes, pinned against a fixed process table: which work has lost its owner, and what must never be
 * claimed. The process shapes are real: the paths and markers are the ones `ps` reported on the Mac on 2026-11-05,
 * when ~50 omp processes had accumulated unreaped.
 */
const OMP = "/Users/zbornheimer/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-20261104042159-2155dff-9f5c2b1/omp";
const PUPPETEER = "/Users/zbornheimer/.omp/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64";
const CHROME = `${PUPPETEER}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const CRASHPAD = `${PUPPETEER}/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/150.0.7871.24/Helpers/chrome_crashpad_handler`;

function at(pid: number, ppid: number, minutes: number, command: string, tty = "??"): Process {
  return { pid, ppid, pgid: pid, tty, ageSeconds: Math.round(minutes * 60), rssKb: 1024, command };
}

/** launchd: the parent every orphan has, and the only one a reaped process may be left with. */
const LAUNCHD = at(1, 0, 9_999, "/sbin/launchd");

const ompSelected = (processes: readonly Process[], minutes = OMP_ORPHAN_MIN_AGE_MINUTES) =>
  selectCandidates(processes, { scope: "omp-orphans", maxAgeSeconds: minutes * 60 });
const ompPids = (processes: readonly Process[], minutes?: number) =>
  ompSelected(processes, minutes).map(({ process: candidate }) => candidate.pid);
const hookPids = (processes: readonly Process[], scope: "long" | "orphans", minutes: number) =>
  selectCandidates(processes, { scope, maxAgeSeconds: minutes * 60 }).map(({ process: candidate }) => candidate.pid);

describe("the omp-orphan age floor", () => {
  it("is a named number of minutes, not a literal buried in the scanner", () => {
    expect(OMP_ORPHAN_MIN_AGE_MINUTES).toBe(10);
  });
});

describe("hasNoControllingTty", () => {
  it("reads what ps prints for a terminal, and for the absence of one", () => {
    expect(hasNoControllingTty("??")).toBe(true);
    expect(hasNoControllingTty("ttys002")).toBe(false);
    expect(hasNoControllingTty("console")).toBe(false);
    // A tty this scanner could not read is treated as attached: doubt never widens a reap.
    expect(hasNoControllingTty(undefined)).toBe(false);
  });
});

describe("selectCandidates, omp-orphans", () => {
  it("claims an orphaned __omp_worker_daemon_broker and the tree it left behind", () => {
    const processes = [
      LAUNCHD,
      at(13526, 1, 2 * 24 * 60 + 4 * 60 + 15, `${OMP} __omp_worker_daemon_broker`),
      at(36966, 13526, 39, `${OMP} __omp_worker_text_predict`),
      at(80863, 13526, 11 * 60 + 31, `${CHROME} --headless=new --user-data-dir=/Users/zbornheimer/.omp/run/daemons/abbb055c705cfa27/omp.browser.headless.profile about:blank`),
    ];
    const reasons = new Map(ompSelected(processes).map(({ process: candidate, reason }) => [candidate.pid, reason]));
    expect(reasons.get(13526)).toBe("orphaned omp work");
    expect(reasons.get(36966)).toBe("child of 13526");
    expect(reasons.get(80863)).toBe("child of 13526");
  });

  it("claims an orphaned Chrome-for-Testing tree", () => {
    const processes = [
      LAUNCHD,
      at(51157, 1, 11 * 60 + 15, `${CRASHPAD} --monitor-self --monitor-self-annotation=ptype=crashpad-handler --handshake-fd=5`),
    ];
    expect(ompPids(processes)).toEqual([51157]);
  });

  it("never claims the launchd omp services", () => {
    const processes = [
      LAUNCHD,
      at(1004, 1, 2 * 24 * 60 + 4 * 60, `${OMP} auth-broker serve`),
      at(1979, 1, 2 * 24 * 60 + 4 * 60, `${OMP} auth-gateway serve --bind 0.0.0.0:4100`),
    ];
    expect(ompPids(processes)).toEqual([]);
  });

  it("leaves an omp orphan younger than the floor alone, and claims one at the floor", () => {
    const young = at(75223, 1, OMP_ORPHAN_MIN_AGE_MINUTES - 1, `${OMP} __omp_worker_daemon_broker`);
    const exact = at(75224, 1, OMP_ORPHAN_MIN_AGE_MINUTES, `${OMP} __omp_worker_daemon_broker`);
    expect(ompPids([LAUNCHD, young])).toEqual([]);
    expect(ompPids([LAUNCHD, exact])).toEqual([75224]);
  });

  it("never claims a tty-attached omp session", () => {
    const session = at(700, 1, 60, `${OMP} __omp_worker_js_eval_process`, "ttys002");
    expect(ompPids([LAUNCHD, session])).toEqual([]);
  });

  it("never claims omp work whose parent is still alive", () => {
    const processes = [
      LAUNCHD,
      at(1000, 1, 90, OMP),
      at(6625, 1000, 22 * 60 + 48, `${OMP} __omp_worker_daemon_broker`),
      at(5972, 6625, 8 * 60, `${CHROME} --type=renderer about:blank`),
    ];
    expect(ompPids(processes)).toEqual([]);
  });

  it("never claims a crashpad handler that is not omp's", () => {
    const processes = [
      LAUNCHD,
      at(1103, 1, 2 * 24 * 60, "/Applications/Granola.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=/Users/zbornheimer/Library/Application Support/Granola/Crashpad --handshake-fd=16"),
      at(88211, 1, 11 * 60, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/157.0.8103.39/Helpers/chrome_crashpad_handler --handshake-fd=5"),
    ];
    expect(ompPids(processes)).toEqual([]);
  });

  it("leaves git-hook checks to their own passes", () => {
    const processes = [
      LAUNCHD,
      at(500, 1, 30, "hk run pre-push origin https://github.com/acme/repo.git"),
      at(13526, 1, 2 * 24 * 60, `${OMP} __omp_worker_daemon_broker`),
    ];
    expect(hookPids(processes, "orphans", 20)).toEqual([500]);
    expect(ompPids(processes)).toEqual([13526]);
  });
});

describe("selectCandidates, git-hook passes", () => {
  it("claims a hook root past the limit and the check work under it, never hand-started work", () => {
    const processes = [
      LAUNCHD,
      at(10, 1, 45, "git push origin main"),
      at(11, 10, 44, "/usr/bin/env mise run test"),
      at(12, 11, 44, "go test ./..."),
      at(20, 1, 90, "go test ./..."), // started by hand: no hook root above it
    ];
    expect(hookPids(processes, "long", 20)).toEqual([10, 11, 12]);
  });

  it("leaves a hook root younger than the limit alone", () => {
    expect(hookPids([LAUNCHD, at(10, 1, 19, "git commit -m x")], "long", 20)).toEqual([]);
  });

  it("orphans needs ppid 1; long does not", () => {
    const processes = [LAUNCHD, at(100, 99, 60, "lefthook run pre-push"), at(99, 50, 61, "zsh")];
    expect(hookPids(processes, "long", 20)).toEqual([100]);
    expect(hookPids(processes, "orphans", 20)).toEqual([]);
  });

  it("never touches a REAP_EXEMPT=1 tree, a reaper, or an unparsable age", () => {
    const processes = [
      LAUNCHD,
      at(30, 1, 60, "env REAP_EXEMPT=1 git push origin main"),
      at(31, 30, 60, "hk run pre-push origin"),
      at(32, 1, 60, "node /x/reap-stale-checks.mjs --scope long git push"),
      at(33, 1, 60, "node /x/reap_scan.mjs --scope long git push"),
      { ...at(34, 1, 0, "git push origin x"), ageSeconds: undefined },
    ];
    expect(hookPids(processes, "long", 20)).toEqual([]);
  });
});

describe("parsing", () => {
  it("reads ps etime in every shape ps prints, and nothing else", () => {
    expect(parseEtime("05:25")).toBe(325);
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("2-04:15:00")).toBe(2 * 86400 + 4 * 3600 + 15 * 60);
    expect(parseEtime("abc")).toBeUndefined();
    expect(parseEtime("1-2-3")).toBeUndefined();
    expect(parseEtime("12")).toBeUndefined();
  });

  it("parses a ps table and skips lines that are not rows", () => {
    const table = parseProcessTable(
      "    1     0     1 ??       05:25:03  23952 /sbin/launchd\n  364 62772   364 ttys001   42:57   2208 /bin/bash -lc sleep 1\nnot a row\n",
    );
    expect(table).toEqual([
      { pid: 1, ppid: 0, pgid: 1, tty: "??", ageSeconds: 19503, rssKb: 23952, command: "/sbin/launchd" },
      { pid: 364, ppid: 62772, pgid: 364, tty: "ttys001", ageSeconds: 2577, rssKb: 2208, command: "/bin/bash -lc sleep 1" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// runScan against fakes: no real ps, no real kill, a temporary log directory.

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reap-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface FakeMachine extends ScanDeps {
  kills: { pid: number; signal: string }[];
  alivePids: Set<number>;
}
/** `stubborn`: pids that ignore SIGTERM and SIGKILL. `ignoreTerm`: pids that die only on SIGKILL. */
function fakeMachine(
  processes: Process[],
  options: { stubborn?: number[]; ignoreTerm?: number[]; psFails?: boolean } = {},
): FakeMachine {
  const alivePids = new Set(processes.map((entry) => entry.pid));
  const kills: { pid: number; signal: string }[] = [];
  return {
    kills,
    alivePids,
    async readProcesses() {
      if (options.psFails) throw new Error("ps exploded");
      return processes;
    },
    kill(pid, signal) {
      kills.push({ pid, signal });
      if (!alivePids.has(pid)) throw new Error("ESRCH");
      if (options.stubborn?.includes(pid)) return;
      if (signal === "SIGTERM" && options.ignoreTerm?.includes(pid)) return;
      alivePids.delete(pid);
    },
    alive: (pid) => alivePids.has(pid),
    sleep: async () => {},
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  };
}

const ORPHANS = [
  LAUNCHD,
  at(13526, 1, 120, `${OMP} __omp_worker_daemon_broker`),
  at(36966, 13526, 39, `${OMP} __omp_worker_text_predict`),
  at(700, 1, 60, `${OMP} __omp_worker_js_eval_process`, "ttys002"),
];

describe("runScan", () => {
  it("refuses a log directory that is relative or climbs out with `..`", async () => {
    const machine = fakeMachine(ORPHANS);
    await expect(runScan({ scope: "omp-orphans", logDir: "relative/logs" }, machine)).rejects.toThrow("absolute path without .. segments");
    await expect(runScan({ scope: "omp-orphans", logDir: `${await tempDir()}/../escape` }, machine)).rejects.toThrow("absolute path without .. segments");
    const dotted = await tempDir();
    expect((await runScan({ scope: "omp-orphans", logDir: `${dotted}//..logs` }, machine)).scope).toBe("omp-orphans");
  });

  it("reports without killing, taking a lock, or writing the run log", async () => {
    const logDir = await tempDir();
    const machine = fakeMachine(ORPHANS);
    const scan = await runScan({ scope: "omp-orphans", apply: false, logDir }, machine);
    expect(scan.applied).toBe(false);
    expect(scan.candidates.map((candidate) => candidate.pid)).toEqual([13526, 36966]);
    expect(scan.killed).toEqual([]);
    expect(scan.scanned).toBe(4);
    expect(scan.max_age_min).toBe(10);
    expect(machine.kills).toEqual([]);
    expect(existsSync(join(logDir, "reap-stale-checks.jsonl"))).toBe(false);
    expect(existsSync(join(logDir, "reap-stale-checks.lock"))).toBe(false);
  });

  it("kills the whole subtree with SIGTERM then SIGKILL, logs one line, and releases the lock", async () => {
    const logDir = await tempDir();
    const machine = fakeMachine(ORPHANS, { ignoreTerm: [36966] });
    const scan = await runScan({ scope: "omp-orphans", apply: true, logDir }, machine);
    expect(scan.killed).toEqual([13526, 36966]);
    expect(scan.survivors).toEqual([]);
    expect(machine.kills).toEqual([
      { pid: 13526, signal: "SIGTERM" },
      { pid: 36966, signal: "SIGTERM" },
      { pid: 36966, signal: "SIGKILL" },
    ]);
    expect(machine.alivePids.has(700)).toBe(true);
    const lines = (await readFile(join(logDir, "reap-stale-checks.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ scope: "omp-orphans", applied: true, at: "2026-11-06T12:00:00.000Z" });
    expect(existsSync(join(logDir, "reap-stale-checks.lock"))).toBe(false);
  });

  it("names a pid that survives SIGKILL instead of calling it killed", async () => {
    const logDir = await tempDir();
    const machine = fakeMachine(ORPHANS, { stubborn: [13526] });
    const scan = await runScan({ scope: "omp-orphans", apply: true, logDir }, machine);
    expect(scan.survivors).toEqual([13526]);
    expect(scan.killed).toEqual([36966]);
  });

  it("FIXED: a pass that finds the lock held says skipped, in JSON, and kills nothing", async () => {
    const logDir = await tempDir();
    await writeFile(join(logDir, "reap-stale-checks.lock"), "");
    const machine = fakeMachine(ORPHANS);
    const scan = await runScan({ scope: "omp-orphans", apply: true, logDir }, machine);
    expect(scan.skipped).toBe("another reap holds the lock");
    expect(scan.candidates).toEqual([]);
    expect(machine.kills).toEqual([]);
    expect(existsSync(join(logDir, "reap-stale-checks.lock"))).toBe(true); // the other pass's lock is left alone
    expect(JSON.parse((await readFile(join(logDir, "reap-stale-checks.jsonl"), "utf8")).trim()).skipped).toBeTruthy();
  });

  it("FIXED: a report ignores a held lock because it kills nothing", async () => {
    const logDir = await tempDir();
    await writeFile(join(logDir, "reap-stale-checks.lock"), "");
    const scan = await runScan({ scope: "omp-orphans", apply: false, logDir }, fakeMachine(ORPHANS));
    expect(scan.skipped).toBeUndefined();
    expect(scan.candidates).toHaveLength(2);
  });

  it("an unreadable process table kills nothing and is returned as an error record", async () => {
    const logDir = await tempDir();
    const machine = fakeMachine(ORPHANS, { psFails: true });
    const scan = await runScan({ scope: "omp-orphans", apply: true, logDir }, machine);
    expect(scan.error).toBe("ps snapshot failed: ps exploded");
    expect(scan.killed).toEqual([]);
    expect(machine.kills).toEqual([]);
    expect(existsSync(join(logDir, "reap-stale-checks.lock"))).toBe(false);
  });

  it("stops before killing when the signal is already aborted", async () => {
    const logDir = await tempDir();
    const machine = fakeMachine(ORPHANS);
    const controller = new AbortController();
    controller.abort();
    await expect(runScan({ scope: "omp-orphans", apply: true, logDir, signal: controller.signal }, machine)).rejects.toThrow();
    expect(machine.kills).toEqual([]);
    expect(existsSync(join(logDir, "reap-stale-checks.lock"))).toBe(false);
  });

  it("rejects an unknown scope", async () => {
    await expect(runScan({ scope: "everything" as never }, fakeMachine([]))).rejects.toThrow("scope must be one of");
  });

  it("killAll tolerates a pid that is already gone", async () => {
    const machine = fakeMachine([LAUNCHD]);
    expect(await killAll([4242], machine)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The LaunchAgent side, against a fake launchctl and temporary directories. Nothing touches the real ~/Library.

interface Calls {
  launchctl: string[][];
}
async function fakeHost(options: { loaded?: Set<string>; failLoad?: boolean; withNode?: boolean } = {}): Promise<{ host: AgentHost; calls: Calls; root: string }> {
  const root = await tempDir();
  const calls: Calls = { launchctl: [] };
  const loaded = options.loaded ?? new Set<string>();
  const launchctl: Launchctl = async (args) => {
    calls.launchctl.push([...args]);
    if (args[0] === "load") {
      if (options.failLoad) return { ok: false, stdout: "", stderr: "Load failed: 5\n" };
      loaded.add(args[1]!.replace(/^.*\//, "").replace(/\.plist$/, ""));
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "list") {
      const label = args[1]!;
      return loaded.has(label)
        ? { ok: true, stdout: `{\n\t"LastExitStatus" = 0;\n\t"Label" = "${label}";\n};\n`, stderr: "" }
        : { ok: false, stdout: "", stderr: "Could not find service" };
    }
    if (args[0] === "unload") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "bootout") {
      loaded.delete(args[1]!.replace(/^.*\//, ""));
      return { ok: true, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected launchctl ${args.join(" ")}`);
  };
  const host: AgentHost = {
    agentsDir: join(root, "LaunchAgents"),
    logDir: join(root, "Logs"),
    scriptText: "// scanner\n",
    scriptTarget: join(root, "state", "reap-stale-checks.mjs"),
    node: () => {
      if (options.withNode === false) throw new Error("no node binary found");
      return "/opt/test/node";
    },
    launchctl,
    uid: 501,
    home: join(root, "home"),
  };
  return { host, calls, root };
}

describe("embedded scanner", () => {
  it("is exactly the text of reap_scan.mjs (omp's loader cannot locate sibling files, so the program ships as a string)", async () => {
    const onDisk = await readFile(new URL("./reap_scan.mjs", import.meta.url), "utf8");
    expect(SCANNER_SOURCE).toBe(onDisk);
  });

  it("is a complete program: it parses, and importing it neither scans nor throws when argv[1] is not a real file", async () => {
    const file = join(await tempDir(), "scanner.mjs");
    await writeFile(file, SCANNER_SOURCE);
    const run = spawnSync("bun", ["-e", `process.argv[1] = "/$bunfs/root/omp"; await import(${JSON.stringify(file)}); console.log("imported")`]);
    expect(run.stdout.toString().trim()).toBe("imported");
    expect(run.status).toBe(0);
  });
});

describe("plistFor", () => {
  it("runs the installed scanner with node, the scope and --apply, on the agent's clock", () => {
    const agent = REAPER_AGENTS[0]!;
    const text = plistFor(agent, { node: "/opt/test/node", script: "/x/state/reap-stale-checks.mjs", logDir: "/x/Logs", home: "/x/home" });
    expect(text).toContain("<key>Label</key><string>local.host.reap-long-checks</string>");
    expect(text).toContain("<string>/opt/test/node</string><string>/x/state/reap-stale-checks.mjs</string><string>--scope</string><string>long</string><string>--apply</string><string>--quiet</string>");
    expect(text).toContain("<key>StartInterval</key><integer>120</integer>");
    expect(text).toContain("<key>WorkingDirectory</key><string>/x/state</string>");
    expect(text).toContain("<key>HOME</key><string>/x/home</string>");
    expect(text).toContain("/x/Logs/local.host.reap-long-checks.log");
  });

  it("escapes XML in every interpolated value", () => {
    const text = plistFor(REAPER_AGENTS[0]!, { node: "/n&n/<node>", script: "/s", logDir: "/l", home: "/h" });
    expect(text).toContain("/n&amp;n/&lt;node&gt;");
    expect(text).not.toContain("<node>");
  });
});

describe("nodeBinary", () => {
  it("FIXED: throws instead of pinning a non-node execPath (inside omp that is the omp binary)", async () => {
    const home = await tempDir();
    expect(() => nodeBinary({ execPath: "/somewhere/omp", home, systemNodes: [] })).toThrow("no node binary found");
  });

  it("uses a node execPath, and otherwise the newest mise install by numeric version", async () => {
    const home = await tempDir();
    const execNode = join(home, "bin", "node");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(execNode, "");
    expect(nodeBinary({ execPath: execNode, home })).toBe(realpathSync(execNode));
    for (const version of ["9.0.0", "20.1.0", "18.2.0"]) {
      await mkdir(join(home, ".local/share/mise/installs/node", version, "bin"), { recursive: true });
      await writeFile(join(home, ".local/share/mise/installs/node", version, "bin", "node"), "");
      chmodSync(join(home, ".local/share/mise/installs/node", version, "bin", "node"), 0o755);
    }
    expect(nodeBinary({ execPath: "/somewhere/omp", home })).toBe(join(home, ".local/share/mise/installs/node/20.1.0/bin/node"));
  });
});

describe("installAgents, uninstallAgents, agentStatus", () => {
  it("copies the scanner, writes and loads every plist, and reports the loaded state", async () => {
    const { host, calls } = await fakeHost();
    const reports = await installAgents(host, agentsFor("both"));
    expect(reports.map((report) => [report.label, report.loaded, report.plist_written, report.last_exit_status])).toEqual([
      ["local.host.reap-long-checks", true, true, 0],
      ["local.host.reap-orphan-checks", true, true, 0],
      ["local.host.reap-omp-orphans", true, true, 0],
    ]);
    expect(await readFile(host.scriptTarget, "utf8")).toBe("// scanner\n");
    const plist = await readFile(join(host.agentsDir, "local.host.reap-omp-orphans.plist"), "utf8");
    expect(plist).toContain(host.scriptTarget);
    expect(plist).toContain("<string>omp-orphans</string>");
    // a reinstall unloads first, and no kickstart is used (it would SIGTERM the RunAtLoad pass)
    expect(calls.launchctl.slice(0, 3).map((args) => args[0])).toEqual(["unload", "bootout", "load"]);
    expect(calls.launchctl.some((args) => args[0] === "kickstart")).toBe(false);
  });

  it("installs nothing when no node binary exists", async () => {
    const { host, calls } = await fakeHost({ withNode: false });
    await expect(installAgents(host, agentsFor("both"))).rejects.toThrow("no node binary found");
    expect(existsSync(host.agentsDir)).toBe(false);
    expect(calls.launchctl).toEqual([]);
  });

  it("throws launchctl's own message when load fails", async () => {
    const { host } = await fakeHost({ failLoad: true });
    await expect(installAgents(host, agentsFor("long"))).rejects.toThrow("launchctl load");
  });

  it("uninstall unloads and deletes the plists; a missing agent is not an error", async () => {
    const { host } = await fakeHost();
    await installAgents(host, agentsFor("long"));
    const reports = await uninstallAgents(host, agentsFor("both"));
    expect(reports.every((report) => !report.loaded && !report.plist_written)).toBe(true);
    expect(existsSync(join(host.agentsDir, "local.host.reap-long-checks.plist"))).toBe(false);
  });

  it("status reads launchd and the last logged run per scope, skipping torn lines", async () => {
    const { host } = await fakeHost({ loaded: new Set(["local.host.reap-long-checks"]) });
    await mkdir(host.logDir, { recursive: true });
    await writeFile(
      join(host.logDir, "reap-stale-checks.jsonl"),
      [
        JSON.stringify({ at: "2026-11-06T10:00:00.000Z", scope: "long", candidates: [{}, {}] }),
        JSON.stringify({ at: "2026-11-06T11:00:00.000Z", scope: "omp-orphans", candidates: [] }),
        "{torn",
      ].join("\n"),
    );
    const reports = await agentStatus(host, REAPER_AGENTS);
    const byScope = new Map(reports.map((report) => [report.scope, report]));
    expect(byScope.get("long")).toMatchObject({ loaded: true, last_exit_status: 0, last_run_at: "2026-11-06T10:00:00.000Z", last_candidates: 2 });
    expect(byScope.get("orphans")).toMatchObject({ loaded: false, last_exit_status: null, last_run_at: null, last_candidates: null });
    expect(byScope.get("omp-orphans")).toMatchObject({ last_run_at: "2026-11-06T11:00:00.000Z", last_candidates: 0 });
  });
});

describe("runReap", () => {
  it("rejects an unknown action or scope and an out-of-range age by throwing", () => {
    expect(() => parseInput({ action: "nuke" })).toThrow("action must be one of");
    expect(() => parseInput({ scope: "all" })).toThrow("scope must be one of");
    expect(() => parseInput({ max_age_minutes: 0 })).toThrow("max_age_minutes");
    expect(() => parseInput({ max_age_minutes: 721 })).toThrow("max_age_minutes");
    expect(() => parseInput({ max_age_minutes: 1.5 })).toThrow("max_age_minutes");
    expect(parseInput({ action: null, scope: null, max_age_minutes: null })).toEqual({ action: "report", scope: "both", maxAgeMinutes: undefined });
  });

  it("defaults to a report over every scope, kills nothing, and returns agent status", async () => {
    const { host } = await fakeHost();
    const machine = fakeMachine(ORPHANS);
    const output = await runReap({}, { host, scanDeps: machine });
    expect(output.action).toBe("report");
    expect(output.scans.map((scan) => scan.scope)).toEqual(["long", "orphans", "omp-orphans"]);
    expect(output.scans.every((scan) => !scan.applied)).toBe(true);
    expect(machine.kills).toEqual([]);
    expect(output.agents).toHaveLength(3);
    expect(output.log_file).toBe(join(host.logDir, "reap-stale-checks.jsonl"));
  });

  it("reap kills what the scoped pass selected and honors max_age_minutes", async () => {
    const { host } = await fakeHost();
    const machine = fakeMachine(ORPHANS);
    const young = await runReap({ action: "reap", scope: "omp-orphans", max_age_minutes: 500 }, { host, scanDeps: machine });
    expect(young.scans[0]!.candidates).toEqual([]);
    const output = await runReap({ action: "reap", scope: "omp-orphans" }, { host, scanDeps: machine });
    expect(output.scans[0]!.killed).toEqual([13526, 36966]);
  });

  it("FIXED: an unreadable process table throws rather than reporting a clean, empty scan", async () => {
    const { host } = await fakeHost();
    await expect(runReap({ action: "report", scope: "long" }, { host, scanDeps: fakeMachine([], { psFails: true }) })).rejects.toThrow("pass failed: ps snapshot failed");
  });

  it("install with one scope installs it and reports the others' state; install_and_reap then reaps once", async () => {
    const { host } = await fakeHost();
    const machine = fakeMachine(ORPHANS);
    const installed = await runReap({ action: "install", scope: "omp-orphans" }, { host, scanDeps: machine });
    expect(installed.agents.map((agent) => [agent.scope, agent.plist_written])).toEqual([
      ["omp-orphans", true],
      ["long", false],
      ["orphans", false],
    ]);
    const both = await runReap({ action: "install_and_reap", scope: "omp-orphans" }, { host, scanDeps: machine });
    expect(both.scans).toHaveLength(1);
    expect(both.scans[0]!.applied).toBe(true);
    expect(both.agents).toHaveLength(1);
  });

  it("status and uninstall run no scan", async () => {
    const { host } = await fakeHost();
    const machine = fakeMachine(ORPHANS);
    expect((await runReap({ action: "status" }, { host, scanDeps: machine })).scans).toEqual([]);
    expect((await runReap({ action: "uninstall", scope: "long" }, { host, scanDeps: machine })).agents).toHaveLength(1);
    expect(machine.kills).toEqual([]);
  });

  it("renders candidates, skips and agents as text", async () => {
    const { host } = await fakeHost();
    await writeFile(join(await (async () => { await mkdir(host.logDir, { recursive: true }); return host.logDir; })(), "reap-stale-checks.lock"), "");
    const output = await runReap({ action: "reap", scope: "omp-orphans" }, { host, scanDeps: fakeMachine(ORPHANS) });
    const text = reapText(output);
    expect(text).toContain("scan omp-orphans: skipped (another reap holds the lock)");
    expect(text).toContain("agent local.host.reap-long-checks");
    expect(text).toContain("run log:");
    const report = reapText(await runReap({ scope: "omp-orphans" }, { host, scanDeps: fakeMachine(ORPHANS) }));
    expect(report).toContain("would kill 2");
    expect(report).toContain("13526 120m [orphaned omp work]");
  });
});

/** A chainable stand-in for `pi.zod`: every method returns the same proxy. */
function fakeZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}
interface BuiltTool {
  name: string;
  description: string;
  loadMode?: unknown;
}

describe("tool object", () => {
  it("is named and discoverable, with a description in range", () => {
    const tool = (factory as unknown as (pi: unknown) => BuiltTool)({ zod: fakeZod() });
    expect(tool.name).toBe("reap_stale_checks");
    expect(tool.loadMode).toBeUndefined();
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(tool.description).not.toContain("\\n");
  });
});
