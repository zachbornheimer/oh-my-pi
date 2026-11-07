import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetectAliases } from "./aliases.js";
import {
  Applied,
  EMBEDDED_ALIASES,
  Exempts,
  loadEmbeddedAliases,
  ManifestNames,
  ParseAliasCatalog,
} from "./alias_catalog.js";
import { NotesFromBody, PackagesFromBody, PackagesFromTitle } from "./body.js";
import { CallSitesSection, callSitesReviewed } from "./callsites.js";
import { ERR_NOT_FOUND, ERR_UNSUPPORTED } from "./changelog/ports.js";
import type { Advisories, ChangelogPorts, Registry, Release, Releases, Repo } from "./changelog/ports.js";
import { facadeFor } from "./facade.js";
import { EcosystemOf, gatherFacts, isCodeFile } from "./facts.js";
import type { GatherPorts } from "./facts.js";
import { ClassifyPath, isOwnLock } from "./files.js";
import { gatherPullRequestSnapshot, gatherSnapshotOnMachine } from "./gather_pr.js";
import { quote } from "./gotext.js";
import { GitHub, parsePullFiles } from "./github.js";
import type { HostMachine, ProcessResult } from "./host_machine.js";
import { type Clock, IsPRURL, loadPullSnapshot, ParsePRURL, type PullRequests } from "./load.js";
import { gatherPorts, MachineConfigFiles, MachineProcess } from "./machine.js";
import { RangeIncludes } from "./peerrange.js";
import type { Command, ConfigFiles, Import, Invocation, Peers, Process, Tree } from "./ports.js";
import { collapseFields, cutRunes, entryLine } from "./purpose.js";
import { decodeFacts, decodeSnapshot } from "./schemas.js";
import type { CICheck, Entry, Facts, Package, Snapshot } from "./schemas.js";
import { goQualifier, ImportSymbols, MatchEntries, SymbolAll, SymbolDefault } from "./symbols.js";
import { DiffTests } from "./testdiff.js";
import { executionPattern, importStatementPattern, parseRgImports, Ripgrep } from "./tree.js";
import { NPMPeers, unitNames, units } from "./units.js";

// Everything here runs against fakes: a scripted HostMachine, canned gh output, and recordings of the real rg and npm
// output for the bpp2.0 pull requests 579 and 588 (fixtures/). No test reaches GitHub, npm or the network.

const FIXTURES = new URL("./fixtures/", import.meta.url);
const text = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
const json = <T>(name: string): T => JSON.parse(text(name)) as T;

const BPP2 = "Software-Automation-Holdings-LLC/bpp2.0";
const PR_FIELDS = "title,body,url,statusCheckRollup";
const FILES_JQ = "[.[] | {filename: .filename, patch: .patch}]";
const pullURL = (number: number): string => `https://github.com/${BPP2}/pull/${number}`;

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });

/** A scripted machine: answers from `commands` by command line (an unlisted one exits 127) and records every run. */
class FakeHostMachine implements HostMachine {
  readonly runs: string[] = [];
  readonly workingDirectory: string;
  readonly homeDirectory = "/home/fake";

  constructor(
    private readonly commands: Readonly<Record<string, ProcessResult>> = {},
    private readonly files: Readonly<Record<string, string>> = {},
    workingDirectory = "/work",
  ) {
    this.workingDirectory = workingDirectory;
  }

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const line = [command, ...args].join(" ");
    this.runs.push(line);
    return this.commands[line] ?? { code: 127, stdout: "", stderr: `no fake for ${line}` };
  }
  async readTextFile(path: string): Promise<string | undefined> {
    return this.files[path];
  }
  async writeTextFile(): Promise<void> {
    throw new Error("the gatherer never writes");
  }
  async isDirectory(): Promise<boolean> {
    return false;
  }
  async isFile(path: string): Promise<boolean> {
    return path in this.files;
  }
  async listDirectory(): Promise<string[]> {
    return [];
  }
  async modifiedAtMs(): Promise<number | undefined> {
    return undefined;
  }
  async readLines(): Promise<AsyncIterable<string> | undefined> {
    return undefined;
  }
  environment(): string | undefined {
    return undefined;
  }
}

const prViewLine = (number: number): string => `gh pr view ${number} --repo ${BPP2} --json ${PR_FIELDS}`;
const filesLine = (number: number): string => `gh api repos/${BPP2}/pulls/${number}/files --paginate --jq ${FILES_JQ}`;

/** A machine that replays the recorded gh output for one pull request. */
function replay(number: number, files?: string): FakeHostMachine {
  return new FakeHostMachine({
    [prViewLine(number)]: ok(text(`gather/pr_${number}.json`)),
    [filesLine(number)]: ok(files ?? text(`gather/files_${number}.json`)),
  });
}

const ZERO_FACTS: Facts = {
  ecosystem: "",
  packages: [],
  units: [],
  test_diff: { changed: [], suspicious: [] },
  ci: [],
  lockfile: [],
  manifest: [],
};

/** The recorded pull request as Load builds it, before any Facts are gathered. */
async function recordedSnapshot(number: number): Promise<Snapshot> {
  const snapshot = await loadPullSnapshot(pullURL(number), {
    pullRequests: new GitHub(replay(number)),
    gather: () => ZERO_FACTS,
  });
  delete snapshot.facts;
  delete snapshot.timings;
  return snapshot;
}

// ParsePRURL

describe("ParsePRURL and IsPRURL", () => {
  it("reads owner, repo and number from a pull URL, with or without a scheme", () => {
    expect(ParsePRURL(`${pullURL(588)}/files`)).toEqual({
      owner: "Software-Automation-Holdings-LLC",
      repo: "bpp2.0",
      number: 588,
      url: pullURL(588),
    });
    const nine = { owner: "acme", repo: "app", number: 9, url: "https://github.com/acme/app/pull/9" };
    expect(ParsePRURL("github.com/acme/app/pull/9")).toEqual(nine);
    expect(ParsePRURL("//github.com/acme/app/pull/9")).toEqual(nine);
    expect(ParsePRURL("http://github.com/acme/app/pull/9")).toEqual(nine);
    expect(ParsePRURL("acme/app#9")).toEqual(nine);
    expect(IsPRURL("  https://github.com/acme/app/pull/9  ")).toBe(true);
  });

  it("refuses what is not a GitHub pull URL", () => {
    expect(IsPRURL(`{"url":"https://github.com/acme/app/pull/9"}`)).toBe(false);
    expect(() => ParsePRURL("")).toThrow(/empty pull request URL/);
    expect(() => ParsePRURL("https://gitlab.com/acme/app/pull/9")).toThrow(/invalid GitHub pull URL/);
    expect(() => ParsePRURL("https://octocat@github.com/acme/app/pull/9")).toThrow(/invalid GitHub pull URL/);
    expect(() => ParsePRURL("https://:placeholder@github.com/acme/app/pull/9")).toThrow(/invalid GitHub pull URL/);
    expect(() => ParsePRURL("https://github.com/acme/app")).toThrow(/invalid GitHub pull request/);
    expect(() => ParsePRURL("https://github.com/acme/app/issues/9")).toThrow(/invalid GitHub pull request/);
    expect(() => ParsePRURL("https://github.com/acme/app/pull/abc")).toThrow(/invalid GitHub pull request/);
    expect(() => ParsePRURL("https://github.com/acme/app/pull/0")).toThrow(/invalid pull number/);
    expect(() => ParsePRURL("acme/app#0")).toThrow(/invalid pull number/);
    expect(() => ParsePRURL("not a url")).toThrow(/invalid pull URL/);
  });

  it("refuses look-alike hosts, ports, schemes and path tricks", () => {
    const lookAlikes = [
      "https://github.com.evil.example/acme/app/pull/9",
      "https://evilgithub.com/acme/app/pull/9",
      "https://notgithub.com/acme/app/pull/9",
      "https://github.com@evil.example/acme/app/pull/9",
      "https://www.github.com/acme/app/pull/9",
      "https://github.com:8443/acme/app/pull/9",
      "https://evil.example/github.com/acme/app/pull/9",
      "ftp://github.com/acme/app/pull/9",
      "https://github.com/acme/pull/9",
      "https://github.com/acme/app/pull/9x",
    ];
    for (const candidate of lookAlikes) {
      expect(IsPRURL(candidate), candidate).toBe(false);
      expect(() => ParsePRURL(candidate), candidate).toThrow();
    }
  });
});

// body.ts

describe("PackagesFromBody", () => {
  it("reads the renovate bump table in the recorded 588 body", () => {
    const body = json<{ body: string }>("gather/pr_588.json").body;
    expect(PackagesFromBody(body)).toEqual([{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }]);
  });

  it("reads every row of the monorepo table in the recorded 579 body", () => {
    const body = json<{ body: string }>("gather/pr_579.json").body;
    expect(PackagesFromBody(body).map((pkg) => pkg.name)).toEqual([
      "eslint-plugin-react-hooks",
      "react",
      "react-dom",
    ]);
  });

  it("reads a linked row and the bare line form, and skips the header", () => {
    const linked =
      "| Package | Change |\n|---|---|\n| [react-native-web](https://redirect.github.com/necolas/react-native-web) | [`0.21.2` → `0.21.4`](https://renovatebot.com/diffs/npm/react-native-web/0.21.2/0.21.4) |";
    expect(PackagesFromBody(linked)).toEqual([{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }]);
    expect(PackagesFromBody("react 19.2.4 → 19.3.0\nreact-dom 19.2.4 -> 19.3.0")).toEqual([
      { name: "react", from: "19.2.4", to: "19.3.0" },
      { name: "react-dom", from: "19.2.4", to: "19.3.0" },
    ]);
    expect(PackagesFromBody("| Package | Change |\n|---|---|")).toEqual([]);
  });
});

describe("PackagesFromTitle", () => {
  it("reads the conventional deps title the body does not carry", () => {
    expect(PackagesFromTitle("fix(deps): update dependency react-native-web to v0.21.4")).toEqual([
      { name: "react-native-web", from: "", to: "0.21.4" },
    ]);
    expect(PackagesFromTitle("chore(deps): update lodash from 4.17.20 to 4.17.21")).toEqual([
      { name: "lodash", from: "4.17.20", to: "4.17.21" },
    ]);
    expect(PackagesFromTitle("fix(deps): update react monorepo")).toEqual([]);
  });
});

describe("NotesFromBody", () => {
  it("reads the recorded 588 release notes as plain text", () => {
    const joined = NotesFromBody(json<{ body: string }>("gather/pr_588.json").body).join("\n");
    expect(joined).toContain("AssetRegistry");
    expect(joined).toContain("useColorScheme");
    for (const markup of ["<details>", "<summary>", "</details>", "</summary>", "&#8203;"]) {
      expect(joined).not.toContain(markup);
    }
  });

  it("drops the furniture and returns nothing without a Release Notes section", () => {
    const body = [
      "### Release Notes",
      "",
      "- Real change",
      "",
      "This PR was generated by Renovate.",
      "",
      "### Configuration",
      "- Schedule: at any time",
    ].join("\n");
    expect(NotesFromBody(body)).toEqual(["Real change"]);
    expect(NotesFromBody("No notes here")).toEqual([]);
  });
});

// files.ts

describe("ClassifyPath", () => {
  it("marks a lockfile, a manifest and a test, and leaves anything else bare", () => {
    expect(ClassifyPath("package-lock.json")).toEqual({ path: "package-lock.json", lockfile: true });
    expect(ClassifyPath("go.sum")).toEqual({ path: "go.sum", lockfile: true });
    expect(ClassifyPath("Cargo.lock")).toEqual({ path: "Cargo.lock", lockfile: true });
    expect(ClassifyPath("package.json")).toEqual({ path: "package.json", manifest: true });
    expect(ClassifyPath("requirements.txt")).toEqual({ path: "requirements.txt", manifest: true });
    expect(ClassifyPath("packages/csharp/Isa.Sdk.csproj")).toEqual({
      path: "packages/csharp/Isa.Sdk.csproj",
      manifest: true,
    });
    expect(ClassifyPath("packages/csharp/packages.lock.json")).toEqual({
      path: "packages/csharp/packages.lock.json",
      lockfile: true,
    });
    expect(ClassifyPath("src/app/index.ts")).toEqual({ path: "src/app/index.ts" });
  });

  it("calls a test by its suffix or by a test directory", () => {
    for (
      const path of [
        "src/app.test.tsx",
        "src/app.spec.ts",
        "src/util_test.go",
        "scripts/check.t",
        "src/lib/__tests__/app.ts",
        "internal/depupgrade/testdata/bpp2.0/pr_588.json",
      ]
    ) {
      expect(ClassifyPath(path)).toEqual({ path, test: true });
    }
    expect(ClassifyPath("src/latest.ts")).toEqual({ path: "src/latest.ts" });
  });

  it("knows the paths that pin a git ref and have no package lockfile", () => {
    expect(isOwnLock(".trunk/trunk.yaml")).toBe(true);
    expect(isOwnLock("package-lock.json")).toBe(false);
  });
});

// testdiff.ts

describe("DiffTests", () => {
  it("flags removed assertions and added skips", () => {
    const patch =
      "@@ -1,4 +1,4 @@\n-  expect(render()).toBe('a')\n+  expect(render()).toBe('b')\n-  const x = 1\n+  it.skip('flaky', () => {})\n--- a\n+++ b";
    const fileA = { ...ClassifyPath("src/a.test.js"), patch };
    const fact = DiffTests([fileA, ClassifyPath("package.json")]);
    expect(fact.changed).toEqual(["src/a.test.js"]);
    expect(fact.suspicious).toHaveLength(2);
    expect(fact.suspicious[0]!.kind).toBe("removed_assertion");
    expect(fact.suspicious[0]!.line).toBe("expect(render()).toBe('a')");
    expect(fact.suspicious[1]!.kind).toBe("added_skip");
  });

  it("reads nothing from a test file with no patch, and nothing from a non-test file", () => {
    expect(DiffTests([ClassifyPath("src/a.test.js")])).toEqual({ changed: ["src/a.test.js"], suspicious: [] });
    expect(DiffTests([{ path: "src/a.js", patch: "-  expect(x).toBe(1)" }])).toEqual({ changed: [], suspicious: [] });
  });
});

// github.ts

function checksOf(rollup: unknown): Promise<CICheck[]> {
  const machine = new FakeHostMachine({
    [`gh pr view 7 --repo acme/app --json ${PR_FIELDS}`]: ok(
      JSON.stringify({ title: "t", body: "", url: "u", statusCheckRollup: rollup }),
    ),
  });
  return new GitHub(machine).view({ owner: "acme", repo: "app", number: 7, url: "u" }).then((request) =>
    request.checks
  );
}

function filesOf(output: string): Promise<{ path: string; patch: string }[]> {
  const machine = new FakeHostMachine({
    [`gh api repos/acme/app/pulls/7/files --paginate --jq ${FILES_JQ}`]: ok(output),
  });
  return new GitHub(machine).files({ owner: "acme", repo: "app", number: 7, url: "u" });
}

describe("the checks GitHub reports", () => {
  it("passes SUCCESS, SKIPPED, NEUTRAL and SUCCESSFUL, and fails anything else", async () => {
    expect(
      await checksOf([
        { name: "lint", conclusion: "SUCCESS" },
        { name: "docs", conclusion: "SKIPPED" },
        { name: "housekeeping", conclusion: "NEUTRAL" },
        { name: "legacy", conclusion: "SUCCESSFUL" },
        { name: "lower", conclusion: "success" },
        { name: "tests", conclusion: "FAILURE" },
        { name: "deploy", state: "PENDING" },
        { name: "weird" },
      ]),
    ).toEqual([
      { name: "lint", passed: true },
      { name: "docs", passed: true },
      { name: "housekeeping", passed: true },
      { name: "legacy", passed: true },
      { name: "lower", passed: true },
      { name: "tests", passed: false },
      { name: "deploy", passed: false },
      { name: "weird", passed: false },
    ]);
  });

  it("takes a check's context when it has no name, drops one with neither, and reads no checks from null", async () => {
    expect(await checksOf([{ context: "codecov", state: "SUCCESS" }, { conclusion: "SUCCESS" }])).toEqual([
      { name: "codecov", passed: true },
    ]);
    expect(await checksOf(null)).toEqual([]);
    expect(await checksOf(undefined)).toEqual([]);
  });
});

describe("the paginator", () => {
  it("concatenates the pages gh --paginate prints, and skips an entry with no filename", async () => {
    const first = JSON.stringify([{ filename: "a.ts", patch: "one" }]);
    const second = JSON.stringify([{ filename: "b.ts" }, { filename: "", patch: "skip" }, {
      filename: "c.ts",
      patch: "three",
    }]);
    const expected = [
      { path: "a.ts", patch: "one" },
      { path: "b.ts", patch: "" },
      { path: "c.ts", patch: "three" },
    ];
    expect(await filesOf(first + second)).toEqual(expected);
    expect(await filesOf(`${first}\n${second}\n`)).toEqual(expected);
    expect(await filesOf(first)).toEqual([{ path: "a.ts", patch: "one" }]);
    expect(parsePullFiles(first + second)).toEqual(expected);
  });

  it("reads the recorded 579 files, patches and all", async () => {
    const files = await filesOf(text("gather/files_579.json"));
    expect(files.map((file) => file.path)).toEqual(["package-lock.json", "package.json"]);
    expect(files[1]?.patch).toContain("eslint-plugin-react-hooks");
  });

  it("names the page that is not JSON", async () => {
    await expect(filesOf("[{\"filename\": \"a.ts\",}]")).rejects.toThrow(/github: decode pull files/);
  });
});

describe("the gh binary", () => {
  it("runs gh only, with --json and --jq, and never looks for ghx", async () => {
    const machine = replay(588);
    await loadPullSnapshot(pullURL(588), { pullRequests: new GitHub(machine), gather: () => ZERO_FACTS });
    expect([...machine.runs].sort()).toEqual([prViewLine(588), filesLine(588)].sort());
  });

  it("names the failing command, its exit and its stderr when gh fails", async () => {
    const machine = new FakeHostMachine({ [prViewLine(588)]: { code: 4, stdout: "", stderr: "HTTP 404" } });
    await expect(new GitHub(machine).view(ParsePRURL(pullURL(588)))).rejects.toThrow(
      `github: gh pr view 588 --repo ${BPP2} --json ${PR_FIELDS}: exit 4: HTTP 404`,
    );
  });
});

// load.ts

interface ParityBundle {
  readonly pull_request: unknown;
  readonly files: unknown;
  readonly snapshot: Snapshot;
}

/** A machine that replays the gh bytes agentmux's own load read for the same pull request. */
function replayParity(number: number, bundle: ParityBundle): FakeHostMachine {
  return new FakeHostMachine({
    [prViewLine(number)]: ok(JSON.stringify(bundle.pull_request)),
    [filesLine(number)]: ok(JSON.stringify(bundle.files)),
  });
}

/** A clock that returns each value once, then repeats the last, so timings are exact. */
function steppingClock(...values: number[]): Clock {
  let index = 0;
  return { now: () => values[Math.min(index++, values.length - 1)] ?? 0 };
}

const dependencies = (machine: FakeHostMachine, gather: (snapshot: Snapshot) => Facts, clock?: Clock) => ({
  pullRequests: new GitHub(machine) as PullRequests,
  gather,
  ...(clock === undefined ? {} : { clock }),
});

describe("loadPullSnapshot on the recorded BPP2.0 pull requests", () => {
  for (const number of [588, 579]) {
    it(`reconstructs pull request ${number} exactly as agentmux's own load did, field for field`, async () => {
      const bundle = json<ParityBundle>(`load_${number}.json`);
      const snapshot = await loadPullSnapshot(
        pullURL(number),
        dependencies(replayParity(number, bundle), () => ZERO_FACTS),
      );
      const { facts, timings, ...loaded } = snapshot;
      expect(loaded).toEqual(bundle.snapshot);
      expect(facts).toBe(ZERO_FACTS);
      expect(timings?.map((timing) => timing.name)).toEqual(["load_pull_request", "gather_facts"]);
    });
  }

  it("reads 588: bump, both files with patches, checks and notes", async () => {
    const snapshot = await loadPullSnapshot(pullURL(588), dependencies(replay(588), () => ZERO_FACTS));
    expect(snapshot.url).toBe(pullURL(588));
    expect(snapshot.title).toBe("fix(deps): update dependency react-native-web to v0.21.4");
    expect(snapshot.packages).toEqual([{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }]);
    expect(snapshot.files).toEqual([
      { path: "package-lock.json", patch: expect.stringContaining("@@"), lockfile: true },
      { path: "package.json", patch: expect.stringContaining("@@"), manifest: true },
    ]);
    expect(snapshot.ci).toContainEqual({ name: "ci", passed: true });
    expect(NotesFromBody(snapshot.body).join(" ")).toContain("useColorScheme");
  });

  it("times the two stages from the clock it is given", async () => {
    const snapshot = await loadPullSnapshot(
      pullURL(588),
      dependencies(replay(588), () => ZERO_FACTS, steppingClock(0, 5, 12)),
    );
    expect(snapshot.timings).toEqual([
      { name: "load_pull_request", wall_ms: 5 },
      { name: "gather_facts", wall_ms: 7 },
    ]);
  });

  it("hands gather the snapshot before any Facts are on it", async () => {
    let factsAtCall: unknown = "unset";
    const snapshot = await loadPullSnapshot(
      pullURL(588),
      dependencies(replay(588), (candidate) => {
        factsAtCall = candidate.facts;
        return ZERO_FACTS;
      }),
    );
    expect(factsAtCall).toBeUndefined();
    expect(snapshot.facts).toBe(ZERO_FACTS);
  });

  it("refuses a URL that is not a pull request without running a process", async () => {
    const machine = replay(588);
    await expect(loadPullSnapshot("https://github.com/acme/app", dependencies(machine, () => ZERO_FACTS))).rejects
      .toThrow(/invalid GitHub pull request/);
    expect(machine.runs).toHaveLength(0);
  });

  it("names the pull request when gh fails, and when the gather fails", async () => {
    await expect(loadPullSnapshot(pullURL(588), dependencies(new FakeHostMachine(), () => ZERO_FACTS))).rejects
      .toThrow(`depupgrade: load ${pullURL(588)}: github: gh pr view 588`);
    await expect(
      loadPullSnapshot(
        pullURL(588),
        dependencies(replay(588), () => {
          throw new Error("rg exploded");
        }),
      ),
    ).rejects.toThrow(`depupgrade: load ${pullURL(588)} facts: rg exploded`);
  });
});

// schemas.ts decoders

describe("decodeSnapshot", () => {
  it("accepts the snapshot agentmux's own load produced and keeps every field", () => {
    const { snapshot } = json<ParityBundle>("load_588.json");
    expect(decodeSnapshot(snapshot)).toEqual(snapshot);
  });

  it("accepts the Facts agentmux gathered, field for field", () => {
    for (const number of [579, 588]) {
      const golden = json<Facts>(`gather/facts_${number}.json`);
      const decoded = decodeFacts(golden);
      expect(decoded.packages.length).toBe(golden.packages.length);
      expect(decodeFacts(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded);
    }
  });

  it("reads null and missing fields as Go does: empty string, empty list, zero struct, zero number, false", () => {
    const decoded = decodeSnapshot({
      body: null,
      files: null,
      packages: [{ name: "react", from: null }],
      ci: [{ name: "ci" }],
      facts: {
        packages: [{ package: null, import_sites: [{ path: "a.js" }], facade: null }],
        units: [null, ["a"]],
        test_diff: null,
      },
      timings: [{ name: "gather_facts" }],
    });
    expect(decoded.body).toBe("");
    expect(decoded.files).toEqual([]);
    expect(decoded.packages).toEqual([{ name: "react", from: "", to: "" }]);
    expect(decoded.ci).toEqual([{ name: "ci", passed: false }]);
    expect(decoded.timings).toEqual([{ name: "gather_facts", wall_ms: 0 }]);
    expect(decoded.url).toBeUndefined();
    const facts = decoded.facts!;
    expect(facts.units).toEqual([[], ["a"]]);
    expect(facts.test_diff).toEqual({ changed: [], suspicious: [] });
    expect(facts.packages[0]!.package).toEqual({ name: "", from: "", to: "" });
    expect(facts.packages[0]!.import_sites).toEqual([{ path: "a.js", line: 0, statement: "" }]);
    expect(facts.packages[0]!.facade).toEqual({ required: false, reason: "" });
    expect(facts.packages[0]!.changelog.range).toEqual({ ecosystem: "", package: "", from: "", to: "" });
  });

  it("treats a null or missing facts as absent, and drops unknown keys", () => {
    expect(decodeSnapshot({ facts: null, surprise: 1 })).toEqual({ body: "", files: [], packages: [] });
    expect(decodeSnapshot({})).toEqual({ body: "", files: [], packages: [] });
  });

  it("throws naming the field that is the wrong type", () => {
    expect(() => decodeSnapshot("nope")).toThrow("snapshot: expected an object");
    expect(() => decodeSnapshot([])).toThrow("snapshot: expected an object");
    expect(() => decodeSnapshot({ files: "package.json" })).toThrow("snapshot.files: expected an array");
    expect(() => decodeSnapshot({ body: 3 })).toThrow("snapshot.body: expected a string");
    expect(() => decodeSnapshot({ files: [{ path: "a" }, { path: 7 }] })).toThrow(
      "snapshot.files[1].path: expected a string",
    );
    expect(() => decodeSnapshot({ files: [{ path: "a", lockfile: "yes" }] })).toThrow(
      "snapshot.files[0].lockfile: expected a boolean",
    );
    expect(() => decodeSnapshot({ facts: { lockfile: "package-lock.json" } })).toThrow(
      "snapshot.facts.lockfile: expected an array",
    );
    expect(() => decodeSnapshot({ facts: [] })).toThrow("snapshot.facts: expected an object");
    expect(() => decodeSnapshot({ facts: { units: [["a"], "b"] } })).toThrow("snapshot.facts.units[1]: expected an array");
    expect(() => decodeSnapshot({ timings: [{ name: "x", wall_ms: 1.5 }] })).toThrow(
      "snapshot.timings[0].wall_ms: expected an integer",
    );
    expect(() => decodeSnapshot({ ci: [{ name: "x", passed: "true" }] })).toThrow(
      "snapshot.ci[0].passed: expected a boolean",
    );
  });

  it("refuses a value outside a closed set, naming where", () => {
    const facts = (packageFacts: unknown) => ({ facts: { packages: [packageFacts] } });
    expect(() => decodeSnapshot(facts({ matched_entries: [{ kind: "meh" }] }))).toThrow(
      "snapshot.facts.packages[0].matched_entries[0].kind: expected one of breaking, deprecation, security, behavior, fix, other",
    );
    expect(() => decodeSnapshot({ facts: { test_diff: { suspicious: [{ kind: "added_test" }] } } })).toThrow(
      "snapshot.facts.test_diff.suspicious[0].kind: expected one of removed_assertion, added_skip",
    );
    expect(() => decodeSnapshot(facts({ import_sites: [{ path: "a", line: "3" }] }))).toThrow(
      "snapshot.facts.packages[0].import_sites[0].line: expected an integer",
    );
    expect(() => decodeSnapshot(facts({ changelog: { entries: [{ kind: "fix" }, {}] } }))).toThrow(
      "snapshot.facts.packages[0].changelog.entries[1].kind",
    );
  });
});

// the golden gather: the recorded rg, npm and changelog output replayed through the real ports

const RG_NAMES = ["react-native-web", "react-native", "react", "react-dom", "eslint-plugin-react-hooks"];

/** Answers rg and npm with the output recorded from the real tools against bpp2.0. */
class ReplayProcess implements Process {
  async run(command: Command): Promise<ProcessResult> {
    if (command.command === "rg") {
      const pattern = command.args[command.args.length - 2];
      const name = RG_NAMES.find((candidate) => importStatementPattern(candidate) === pattern);
      if (name === undefined) return { code: 1, stdout: "", stderr: "" };
      return ok(text(`gather/rg_${name}.json`));
    }
    if (command.command === "npm") {
      const spec = command.args[1] ?? "";
      return ok(text(`gather/peers_${spec.replace("@", "_")}.json`));
    }
    throw new Error(`unexpected command ${command.command}`);
  }

  async lookPath(file: string): Promise<string> {
    return file;
  }
}

const replayProcess = new ReplayProcess();

const recordedConfig: ConfigFiles = {
  async readFile(path: string): Promise<string> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    try {
      return text(`gather/config/${name}`);
    } catch {
      throw new Error(`no config ${name}`);
    }
  },
};

const REPOS: Record<string, Repo> = {
  react: { owner: "facebook", name: "react", directory: "packages/react" },
  "react-dom": { owner: "facebook", name: "react", directory: "packages/react-dom" },
  "eslint-plugin-react-hooks": { owner: "facebook", name: "react", directory: "packages/eslint-plugin-react-hooks" },
  "react-native-web": { owner: "necolas", name: "react-native-web", directory: "" },
};

const registry: Registry = {
  async source(_eco, pkg) {
    const repo = REPOS[pkg];
    if (repo === undefined) throw ERR_NOT_FOUND;
    return repo;
  },
  async versions() {
    throw ERR_UNSUPPORTED;
  },
};

const releases: Releases = {
  async list(repo) {
    const file = repo.name === "react-native-web" ? "releases_react_native_web.json" : "releases_react.json";
    return (JSON.parse(text(`gather/changelog/${file}`)) as { tag_name: string; body: string; html_url: string }[]).map((
      release,
    ): Release => ({ tag: release.tag_name, body: release.body, url: release.html_url }));
  },
  async file(repo, _ref, path) {
    if (repo.directory.endsWith("eslint-plugin-react-hooks") && path.endsWith("CHANGELOG.md")) {
      return text("gather/changelog/changelog_eslint_plugin_react_hooks.md");
    }
    throw ERR_NOT_FOUND;
  },
};

const advisories: Advisories = {
  async for() {
    return [];
  },
};

const recordedChangelog: ChangelogPorts = { registry, releases, advisories };

function recordedPorts(): GatherPorts {
  return {
    tree: new Ripgrep(replayProcess),
    config: recordedConfig,
    peers: new NPMPeers(replayProcess),
    changelog: recordedChangelog,
    root: "/recorded/bpp2.0",
  };
}

describe("recorded bpp2.0 parity", () => {
  for (const number of [579, 588]) {
    it(`gathers the same Facts agentmux gathers for PR ${number}`, async () => {
      const mine = await gatherFacts(await recordedSnapshot(number), recordedPorts());
      expect(decodeFacts(mine)).toEqual(decodeFacts(json<unknown>(`gather/facts_${number}.json`)));
    });
  }

  it("reads a lockfile-only PR as no ecosystem, and records the gap that follows", async () => {
    const snapshot = decodeSnapshot({
      files: [ClassifyPath("package-lock.json")],
      packages: [{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }],
    });
    const facts = await gatherFacts(snapshot, recordedPorts());
    expect(facts.ecosystem).toBe("");
    expect(facts.gaps?.[0]).toBe(
      "changelog for react-native-web 0.21.2 to 0.21.4: changelog: unknown ecosystem \"\" (want npm, go, pypi, or composer)",
    );
    expect(facts.packages[0]!.changelog.gaps).toEqual([
      "changelog: unknown ecosystem \"\" (want npm, go, pypi, or composer)",
    ]);
  });

  it("reads PR 579: units, the react facade, the single react-dom importer", async () => {
    const facts = await gatherFacts(await recordedSnapshot(579), recordedPorts());
    expect(facts.ecosystem).toBe("npm");
    expect(facts.units).toEqual([["eslint-plugin-react-hooks"], ["react", "react-dom"]]);
    const react = facts.packages.find((pkg) => pkg.package.name === "react")!;
    expect(react.importers).toHaveLength(255);
    expect(react.facade.required).toBe(true);
    const dom = facts.packages.find((pkg) => pkg.package.name === "react-dom")!;
    expect(dom.importers).toHaveLength(1);
    expect(dom.used_symbols).toEqual(["createPortal"]);
    expect(dom.facade.owner).toBe(dom.importers[0]);
    expect(dom.unit).toBe("react+react-dom");
  });

  it("reads PR 588: the react-native alias, its evidence and the 0.21.4 notes", async () => {
    const facts = await gatherFacts(await recordedSnapshot(588), recordedPorts());
    expect(facts.units).toEqual([["react-native-web"]]);
    const web = facts.packages[0]!;
    expect(web.aliases).toEqual(["react-native"]);
    expect(web.alias_evidence).toHaveLength(1);
    expect(web.facade.required).toBe(true);
    expect(web.importers.length).toBeGreaterThanOrEqual(100);
    expect(web.changelog.entries.map((entry) => entry.version)).toContain("0.21.4");
  });
});

describe("EcosystemOf and Gather", () => {
  it("reads the ecosystem from the first changed manifest", () => {
    expect(EcosystemOf([ClassifyPath("src/a.js"), ClassifyPath("go.mod")])).toBe("go");
    expect(EcosystemOf([ClassifyPath("package-lock.json")])).toBe("");
  });

  it("fails loudly without the tree, config and peers ports", async () => {
    await expect(gatherFacts(decodeSnapshot({}), {} as GatherPorts)).rejects.toThrow(
      "depupgrade: tree, config, and peers ports are required",
    );
  });

  it("takes Go used symbols from qualified uses and records the executions", async () => {
    const snapshot = decodeSnapshot({
      files: [ClassifyPath("go.mod"), ClassifyPath("go.sum")],
      packages: [{ name: "github.com/acme/widget", from: "3.0.0", to: "3.1.0" }],
    });
    const facts = await gatherFacts(snapshot, { ...recordedPorts(), tree: new GoTree() });
    const pkg = facts.packages[0]!;
    expect(facts.ecosystem).toBe("go");
    expect(pkg.used_symbols).toEqual(["Close", "New", "Option"]);
    expect(pkg.facade.required).toBe(true);
    expect(pkg.importers).toHaveLength(2);
    expect(pkg.executions).toEqual([{ path: "scripts/run.sh", line: 3, statement: "exec.Command(\"widget\", \"-v\")" }]);
  });
});

class GoTree implements Tree {
  async imports(): Promise<Import[]> {
    return [
      { path: "a.go", line: 1, statement: "\t\"github.com/acme/widget/v3\"" },
      { path: "b.go", line: 1, statement: "\tw \"github.com/acme/widget/v3\"" },
    ];
  }

  /** A Go package is reached by running its binary too, which no import statement shows. */
  async executions(): Promise<Invocation[]> {
    return [{ path: "scripts/run.sh", line: 3, statement: "exec.Command(\"widget\", \"-v\")" }];
  }

  async identifiers(_root: string, path: string, qualifier: string): Promise<string[]> {
    if (path === "a.go" && qualifier === "widget") return ["New", "Option"];
    if (path === "b.go" && qualifier === "w") return ["New", "Close"];
    return [];
  }
}

describe("ImportSymbols, MatchEntries, goQualifier", () => {
  const cases: [string, string[]][] = [
    ["import { A, B as C } from 'pkg'", ["A", "B"]],
    ["import {\n  A,\n  type B,\n} from \"pkg\"", ["A", "B"]],
    ["import X from 'pkg'", [SymbolDefault]],
    ["import X, { A } from 'pkg/sub'", ["A", SymbolDefault]],
    ["import * as NS from 'pkg'", [SymbolAll]],
    ["const p = require('pkg')", []],
    ["require('pkg')", [SymbolAll]],
    ["import('pkg')", [SymbolAll]],
    ["export { A } from 'pkg'", ["A"]],
    ["import 'pkg'", []],
  ];
  for (const [statement, want] of cases) {
    it(`parses ${JSON.stringify(statement)}`, () => {
      expect(ImportSymbols(statement).sort()).toEqual([...want].sort());
    });
  }

  const entries: Entry[] = [
    { version: "2", kind: "fix", text: "useColorScheme subscribes once", source: "" },
    { version: "2", kind: "fix", text: "Image onLoad no longer restarts", source: "" },
    { version: "2", kind: "breaking", text: "drops Node 16", source: "" },
    { version: "2", kind: "security", text: "CVE fixed", source: "" },
  ];

  it("keeps the symbol entry plus breaking and security", () => {
    const got = MatchEntries(entries, ["useColorScheme"]);
    expect(got).toHaveLength(3);
    expect(got[0]!.text).toBe(entries[0]!.text);
  });

  it("matches every entry for a namespace use, and none for a default import", () => {
    expect(MatchEntries(entries, [SymbolAll])).toHaveLength(entries.length);
    expect(MatchEntries(entries.slice(0, 2), [SymbolDefault])).toHaveLength(0);
  });

  it("names the Go qualifier of an import line", () => {
    expect(goQualifier("\t\"github.com/acme/widget\"")).toBe("widget");
    expect(goQualifier("\t\"github.com/acme/widget/v3\"")).toBe("widget");
    expect(goQualifier("\tw \"github.com/acme/widget\"")).toBe("w");
    expect(goQualifier("import \"github.com/acme/go-kit\"")).toBe("go_kit");
  });
});

// tree.ts, machine.ts

const ROOT = "/work";
const RG_GLOBS = ["!node_modules/**", "!.git/**", "!dist/**", "!vendor/**", "!*.lock", "!package-lock.json", "!go.sum"];

/** The rg invocation tree.ts builds, spelled out so a change to its flags fails this suite. */
function rgLine(pattern: string): string {
  return ["rg", "--json", "--multiline", ...RG_GLOBS.flatMap((glob) => ["--glob", glob]), pattern, "."].join(" ");
}
const rgImportsLine = (name: string): string => rgLine(importStatementPattern(name));
const rgExecutionsLine = (name: string): string => rgLine(executionPattern(name));
const NO_MATCH: ProcessResult = { code: 1, stdout: "", stderr: "" };

function rgEvent(path: string, lineNumber: number, match: string): string {
  return JSON.stringify({
    type: "match",
    data: { path: { text: path }, line_number: lineNumber, submatches: [{ match: { text: match } }] },
  });
}

/** The regression this suite pins, from PR 502 of ninja-quoter: esbuild is reached from Ruby by running its binary. */
describe("executions: the call sites an import search cannot see", () => {
  const RUBY_CALLS = [
    "esbuild_path = Rails.root.join('node_modules/.bin/esbuild').to_s unless File.exist?(esbuild_path)",
    "esbuild_out, stderr, status = Open3.capture3(esbuild_path, '--minify', stdin_data: js_source)",
  ];
  const IMPORT_LINE = "import { transform } from \"esbuild\";";

  it("matches every line that runs the package's binary, including the one reached from another language", () => {
    const pattern = new RegExp(executionPattern("esbuild"));
    for (const line of RUBY_CALLS) expect(pattern.test(line), line).toBe(true);
    expect(pattern.test("RUN npx esbuild --minify")).toBe(true);
    expect(pattern.test("esbuild_out = `pnpm exec esbuild --version`")).toBe(true);
  });

  it("does not match an import of the package, which the import search owns", () => {
    expect(new RegExp(executionPattern("esbuild")).test(IMPORT_LINE)).toBe(false);
    expect(new RegExp(importStatementPattern("esbuild")).test(IMPORT_LINE)).toBe(true);
  });

  it("is what makes the difference: the import search cannot see the Ruby call sites", () => {
    const imports = new RegExp(importStatementPattern("esbuild"));
    for (const line of RUBY_CALLS) expect(imports.test(line), line).toBe(false);
  });

  it("runs the exact rg invocation and parses the lines it matched", async () => {
    const out = [
      rgEvent("scripts/validate_esbuild.rb", 24, "node_modules/.bin/esbuild"),
      rgEvent("scripts/validate_esbuild.rb", 27, "Open3.capture3(esbuild_path"),
    ].join("\n");
    const host = new FakeHostMachine({ [rgExecutionsLine("esbuild")]: ok(out) });
    const executions = await new Ripgrep(new MachineProcess(host)).executions(ROOT, "esbuild");
    expect(host.runs).toEqual([rgExecutionsLine("esbuild")]);
    expect(executions).toEqual([
      { path: "scripts/validate_esbuild.rb", line: 24, statement: "node_modules/.bin/esbuild" },
      { path: "scripts/validate_esbuild.rb", line: 27, statement: "Open3.capture3(esbuild_path" },
    ]);
  });

  it("searches nothing for an empty name, the way the import search does not", async () => {
    const host = new FakeHostMachine();
    expect(await new Ripgrep(new MachineProcess(host)).executions(ROOT, "")).toEqual([]);
    expect(host.runs).toHaveLength(0);
  });

  it("lands the Ruby call sites in the gathered Facts", async () => {
    const out = rgEvent("scripts/validate_esbuild.rb", 24, "node_modules/.bin/esbuild");
    const host = new FakeHostMachine(
      {
        "npm view esbuild@0.25.0 peerDependencies --json": ok(""),
        [rgImportsLine("esbuild")]: NO_MATCH,
        [rgExecutionsLine("esbuild")]: ok(out),
      },
      {},
      ROOT,
    );
    const snapshot = decodeSnapshot({
      files: [ClassifyPath("package.json")],
      packages: [{ name: "esbuild", from: "0.24.0", to: "0.25.0" }],
    });
    const facts = await gatherFacts(snapshot, gatherPorts(host, ROOT));
    expect(facts.packages[0]!.importers).toEqual([]);
    expect(facts.packages[0]!.executions).toEqual([
      { path: "scripts/validate_esbuild.rb", line: 24, statement: "node_modules/.bin/esbuild" },
    ]);
  });
});

describe("the machine-backed adapters", () => {
  it("MachineProcess runs through the machine and reports the exit, stdout and stderr as given", async () => {
    const host = new FakeHostMachine({ "tool x --json": { code: 3, stdout: "out", stderr: "err" } });
    expect(await new MachineProcess(host).run({ command: "tool", args: ["x", "--json"] })).toEqual({
      code: 3,
      stdout: "out",
      stderr: "err",
    });
  });

  it("refuses a working directory other than the machine's, naming it", async () => {
    const host = new FakeHostMachine();
    await expect(new MachineProcess(host).run({ command: "rg", args: [], dir: "/elsewhere" })).rejects.toThrow(
      "HostMachine runs commands only in the CLI's working directory (/work)",
    );
    expect(host.runs).toHaveLength(0);
  });

  it("resolves a binary with which, and fails loudly when it is absent", async () => {
    const host = new FakeHostMachine({
      "which rg": ok("/usr/bin/rg\n"),
      "which gh": { code: 1, stdout: "", stderr: "no gh" },
    });
    expect(await new MachineProcess(host).lookPath("rg")).toBe("/usr/bin/rg");
    await expect(new MachineProcess(host).lookPath("gh")).rejects.toThrow("depupgrade: gh is not on PATH");
  });

  it("Ripgrep runs the exact rg invocation and parses the recorded events", async () => {
    const host = new FakeHostMachine({ [rgImportsLine("react-dom")]: ok(text("gather/rg_react-dom.json")) });
    const imports = await new Ripgrep(new MachineProcess(host)).imports(ROOT, "react-dom");
    expect(host.runs).toEqual([rgImportsLine("react-dom")]);
    expect(imports).toEqual([
      {
        path: "src/components/Menu/MenuDesktop/MenuDesktop.js",
        line: expect.any(Number),
        statement: expect.stringContaining("react-dom"),
      },
    ]);
    expect(ImportSymbols(imports[0]!.statement)).toEqual(["createPortal"]);
    expect(parseRgImports(text("gather/rg_react-dom.json"))).toHaveLength(1);
  });

  it("Ripgrep turns a failed search into a throw and an rg no-match into nothing", async () => {
    const host = new FakeHostMachine({
      [rgImportsLine("react")]: { code: 2, stdout: "", stderr: "regex parse error" },
      [rgImportsLine("vue")]: NO_MATCH,
    });
    const tree = new Ripgrep(new MachineProcess(host));
    await expect(tree.imports(ROOT, "react")).rejects.toThrow("tree: search react: exit 2: regex parse error");
    expect(await tree.imports(ROOT, "vue")).toEqual([]);
    expect(await tree.imports(ROOT, "")).toEqual([]);
  });

  it("NPMPeers runs the npm view of units.go, decodes the peer ranges, and names a failure", async () => {
    const host = new FakeHostMachine({
      "npm view react-dom@19.3.0 peerDependencies --json": ok(text("gather/peers_react-dom_19.3.0.json")),
      "npm view react-native-web@0.21.4 peerDependencies --json": ok(""),
      "npm view react@20.0.0 peerDependencies --json": { code: 1, stdout: "", stderr: "ETARGET" },
      "npm view bad@1.0.0 peerDependencies --json": ok("not json"),
    });
    const peers = new NPMPeers(new MachineProcess(host));
    expect(await peers.of("npm", "react-dom", "19.3.0")).toEqual({ react: "^19.3.0" });
    expect(await peers.of("npm", "react-native-web", "0.21.4")).toEqual({});
    expect(await peers.of("go", "example.com/x", "1.0.0")).toEqual({});
    await expect(peers.of("npm", "react", "20.0.0")).rejects.toThrow("peers: npm view react@20.0.0: exit 1: ETARGET");
    await expect(peers.of("npm", "bad", "1.0.0")).rejects.toThrow("peers: decode npm view bad@1.0.0");
    expect(host.runs).toHaveLength(4);
  });

  it("MachineConfigFiles reads through the machine and names the path it cannot read", async () => {
    const tsconfig = join(ROOT, "tsconfig.json");
    const packageJson = join(ROOT, "package.json");
    const host = new FakeHostMachine({}, { [tsconfig]: "{}" });
    expect(await new MachineConfigFiles(host).readFile(tsconfig)).toBe("{}");
    await expect(new MachineConfigFiles(host).readFile(packageJson)).rejects.toThrow(
      `depupgrade: cannot read ${packageJson}`,
    );
  });
});

describe("gatherPorts over the machine", () => {
  const RNW_PEERS = "npm view react-native-web@0.21.4 peerDependencies --json";
  const MODEL_SOURCES_GAP =
    "changelog: the changelog and advisory sources are not machine reads — the model-driven sources step owns them";

  function webMachine(overrides: Record<string, ProcessResult> = {}, withConfig = true): FakeHostMachine {
    return new FakeHostMachine(
      {
        [RNW_PEERS]: ok(text("gather/peers_react-native-web_0.21.4.json")),
        [rgImportsLine("react-native-web")]: ok(text("gather/rg_react-native-web.json")),
        [rgImportsLine("react-native")]: ok(text("gather/rg_react-native.json")),
        [rgExecutionsLine("react-native-web")]: NO_MATCH,
        [rgExecutionsLine("react-native")]: NO_MATCH,
        ...overrides,
      },
      withConfig ? { [`${ROOT}/package.json`]: text("gather/config/package.json") } : {},
      ROOT,
    );
  }

  const webSnapshot = (): Snapshot =>
    decodeSnapshot({
      files: [ClassifyPath("package.json"), ClassifyPath("package-lock.json")],
      packages: [{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }],
    });

  it("gathers the working copy's local Facts through rg, npm and the config files, and no gh", async () => {
    const host = webMachine();
    const facts = await gatherFacts(webSnapshot(), gatherPorts(host, host.workingDirectory));
    expect(facts.ecosystem).toBe("npm");
    expect(facts.units).toEqual([["react-native-web"]]);
    expect(facts.manifest).toEqual(["package.json"]);
    expect(facts.lockfile).toEqual(["package-lock.json"]);
    const pkg = facts.packages[0]!;
    expect(pkg.aliases).toEqual(["react-native"]);
    expect(pkg.importers).toHaveLength(162);
    expect(pkg.import_sites).toHaveLength(164);
    expect(pkg.used_symbols.slice(0, 3)).toEqual(["*", "ActivityIndicator", "Animated"]);
    expect(pkg.facade).toEqual({
      required: true,
      reason: "162 files import it directly, e.g. src/Pane.js, src/SlideIns/styles.js, src/Input.js, ...",
    });
    expect([...host.runs].sort()).toEqual([
      RNW_PEERS,
      rgImportsLine("react-native"),
      rgImportsLine("react-native-web"),
      rgExecutionsLine("react-native"),
      rgExecutionsLine("react-native-web"),
    ].sort());
  });

  it("reads no alias from a working copy with no package.json", async () => {
    const host = webMachine({}, false);
    const facts = await gatherFacts(webSnapshot(), gatherPorts(host, host.workingDirectory));
    expect(facts.packages[0]!.aliases).toEqual([]);
    expect(facts.packages[0]!.executions).toBeUndefined();
  });

  it("leaves the model-owned gap in the gathered Facts instead of a silent empty changelog", async () => {
    const host = webMachine();
    const ports = gatherPorts(host, host.workingDirectory);
    expect(() => ports.changelog).toThrow(MODEL_SOURCES_GAP);
    const facts = await gatherFacts(webSnapshot(), ports);
    expect(facts.gaps).toEqual([`changelog for react-native-web 0.21.2 to 0.21.4: ${MODEL_SOURCES_GAP}`]);
    const changelog = facts.packages[0]!.changelog;
    expect(changelog).toEqual({
      range: { ecosystem: "npm", package: "react-native-web", from: "0.21.2", to: "0.21.4" },
      entries: [],
      advisories: [],
      sources: [],
      gaps: [MODEL_SOURCES_GAP],
    });
    expect(facts.packages[0]!.matched_entries).toEqual([]);
  });

  it("records a gap, not a throw, when npm cannot answer", async () => {
    for (
      const [failure, expected] of [
        [{ code: 1, stdout: "", stderr: "ETARGET" }, "peers: npm view react-native-web@0.21.4: exit 1: ETARGET"],
        [{ code: -1, stdout: "", stderr: "spawn npm ENOENT" }, "exit -1: spawn npm ENOENT"],
        [ok("not json"), "peers: decode npm view react-native-web@0.21.4"],
      ] as const
    ) {
      const host = webMachine({ [RNW_PEERS]: failure });
      const facts = await gatherFacts(webSnapshot(), gatherPorts(host, host.workingDirectory));
      expect(facts.gaps?.some((gap) => gap.includes("peer dependencies of react-native-web@0.21.4 unavailable"))).toBe(
        true,
      );
      expect(facts.gaps?.join("\n")).toContain(expected);
      expect(facts.units).toEqual([["react-native-web"]]);
    }
  });

  it("still throws when the tree search itself fails", async () => {
    const host = webMachine({ [rgImportsLine("react-native-web")]: { code: 2, stdout: "", stderr: "regex parse error" } });
    await expect(gatherFacts(webSnapshot(), gatherPorts(host, host.workingDirectory))).rejects.toThrow(
      "tree: search react-native-web: exit 2: regex parse error",
    );
  });
});

// units, peerrange, facade, aliases

function mapPeers(table: Record<string, Record<string, string>>): Peers {
  return {
    async of(_eco, pkg, version) {
      return table[`${pkg}@${version}`] ?? {};
    },
  };
}

describe("units", () => {
  it("follows peerDependency edges", async () => {
    const pkgs: Package[] = [
      { name: "react", from: "19.2.4", to: "19.3.0" },
      { name: "react-dom", from: "19.2.4", to: "19.3.0" },
      { name: "eslint-plugin-react-hooks", from: "7.0.1", to: "7.1.1" },
    ];
    const peers = mapPeers({
      "react-dom@19.3.0": { react: "^19.3.0" },
      "eslint-plugin-react-hooks@7.1.1": { eslint: "^9.0.0" },
    });
    expect(unitNames(await units(peers, "npm", pkgs, () => {}))).toEqual([
      ["react", "react-dom"],
      ["eslint-plugin-react-hooks"],
    ]);
  });

  it("ignores a peer range that excludes the bump", async () => {
    const pkgs: Package[] = [
      { name: "lib", from: "1.0.0", to: "1.1.0" },
      { name: "core", from: "1.0.0", to: "2.0.0" },
    ];
    expect(await units(mapPeers({ "lib@1.1.0": { core: "^1.0.0" } }), "npm", pkgs, () => {})).toHaveLength(2);
  });

  it("records a gap and leaves the package alone when its peers cannot be read", async () => {
    const gaps: string[] = [];
    const failing: Peers = {
      async of() {
        throw new Error("offline");
      },
    };
    const listed = await units(failing, "npm", [{ name: "a", from: "1.0.0", to: "1.1.0" }], (gap) => gaps.push(gap));
    expect(unitNames(listed)).toEqual([["a"]]);
    expect(gaps).toEqual(["peer dependencies of a@1.1.0 unavailable: offline"]);
  });
});

describe("RangeIncludes", () => {
  const cases: [string, string, boolean][] = [
    ["^19.3.0", "19.3.0", true],
    ["^19.3.0", "19.2.9", false],
    ["^19.3.0", "20.0.0", false],
    ["^18.0.0 || ^19.0.0", "19.3.0", true],
    ["^3.0.0 || ^4.0.0 || ^8.0.0-0 || ^9.0.0", "9.1.0", true],
    [">=16.8 <20", "19.3.0", true],
    [">=16.8 <19", "19.3.0", false],
    ["~1.2.3", "1.2.9", true],
    ["~1.2.3", "1.3.0", false],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["19.x", "19.3.0", true],
    ["*", "1.0.0", true],
    ["", "1.0.0", true],
    ["1.2.3", "1.2.4", false],
  ];
  for (const [expr, version, want] of cases) {
    it(`${expr} includes ${version} = ${want}`, () => {
      expect(RangeIncludes(expr, version)).toBe(want);
    });
  }
});

describe("facadeFor and isCodeFile", () => {
  it("requires a facade for more than one importer, with a sampled reason", () => {
    const two = facadeFor(["src/a.js", "src/b.js"], false);
    expect(two.required).toBe(true);
    expect(two.reason).toContain("2 files");
    const many = facadeFor(["1", "2", "3", "4", "5"], false);
    expect(many.reason).toContain("5 files");
    expect(many.reason.endsWith("...")).toBe(true);
  });

  it("lets a single importer own the boundary, and honours the catalog's exemption", () => {
    const one = facadeFor(["src/ui/Image.js"], false);
    expect(one.required).toBe(false);
    expect(one.owner).toBe("src/ui/Image.js");
    expect("owner" in facadeFor([], false)).toBe(false);
    const exempt = facadeFor(["a", "b"], true);
    expect(exempt.required).toBe(false);
    expect(exempt.reason).toContain("exempt");
  });

  it("does not count tests, manifests, lockfiles or docs as importers", () => {
    for (const path of ["package.json", "docs/readme.md", "src/__tests__/a.js", "src/a.test.js", "package-lock.json"]) {
      expect(isCodeFile(path)).toBe(false);
    }
    expect(isCodeFile("src/a.js")).toBe(true);
  });
});

describe("DetectAliases", () => {
  const target: Package[] = [{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }];
  const webpack =
    "module.exports = { resolve: { alias: { 'react-native$': 'react-native-web', '@': path.resolve(__dirname, 'src') } } }";
  const vite =
    "export default { resolve: { alias: { 'react-native': path.resolve(__dirname, 'node_modules/react-native-web') } } }";

  it("reads webpack and vite resolve.alias", () => {
    for (const config of [webpack, vite]) {
      expect(DetectAliases([config], target).get("react-native-web")).toEqual(["react-native"]);
    }
  });

  it("reads tsconfig paths and jest moduleNameMapper, once", () => {
    const tsconfig =
      "{\"compilerOptions\":{\"paths\":{\"react-native\":[\"./node_modules/react-native-web\"],\"@/*\":[\"./src/*\"]}}}";
    const jest = "moduleNameMapper: { '^react-native$': 'react-native-web', '^react-native/(.*)$': 'react-native-web/$1' }";
    expect(DetectAliases([tsconfig, jest], target).get("react-native-web")).toEqual(["react-native"]);
  });

  it("ignores local paths and unrelated packages, and finds none in the recorded bpp2.0 configs", () => {
    expect(DetectAliases(["alias: { '@components': './src/components', 'lodash': 'lodash-es' }"], target).size).toBe(0);
    const packages: Package[] = ["react", "react-dom", "react-native-web", "eslint-plugin-react-hooks"].map((name) => ({
      name,
      from: "",
      to: "",
    }));
    const configs = ["tsconfig.json", "jest.config.js", "babel.config.js"].map((name) => text(`gather/config/${name}`));
    expect(DetectAliases(configs, packages).size).toBe(0);
  });
});

describe("the alias catalog (a TS constant, not aliases.yaml)", () => {
  it("applies the embedded react-native-web alias only when the manifest declares both packages", () => {
    const catalog = loadEmbeddedAliases();
    expect(catalog).toEqual(EMBEDDED_ALIASES);
    expect(Applied(catalog, "react-native-web", new Set(["expo", "react-native-web"]))).toEqual({
      aliases: ["react-native"],
      evidence: ["Expo web resolves react-native to react-native-web"],
    });
    expect(Applied(catalog, "react-native-web", new Set(["react-native-web"]))).toEqual({ aliases: [], evidence: [] });
    expect(Exempts(catalog, "react-native-web")).toBe(false);
  });

  it("refuses an entry that names no manifest, alias or package", () => {
    expect(() => ParseAliasCatalog({ aliases: [{ alias: "a", package: "b" }] })).toThrow(
      "alias catalog entry 1 needs when_manifest_has, alias, and package",
    );
    expect(ParseAliasCatalog(null)).toEqual({ aliases: [], facade_exempt: [] });
  });

  it("reads the names a package.json declares, and refuses text that is not JSON", () => {
    const manifest = JSON.stringify({ dependencies: { a: "1" }, devDependencies: { b: "1" }, scripts: { c: "x" } });
    expect([...ManifestNames(manifest)].sort()).toEqual(["a", "b"]);
    expect(ManifestNames("null").size).toBe(0);
    expect(() => ManifestNames("{")).toThrow("depupgrade: decode package.json");
  });
});

// callsites, purpose, gotext

describe("call sites, prompt lines and Go text helpers", () => {
  const facts: Facts = {
    ...ZERO_FACTS,
    packages: [{
      package: { name: "react", from: "1.0.0", to: "2.0.0" },
      changelog: { range: { ecosystem: "npm", package: "react", from: "1.0.0", to: "2.0.0" }, entries: [], advisories: [], sources: [], gaps: [] },
      aliases: [],
      importers: ["src/a.js", "src/b.js"],
      import_sites: [],
      used_symbols: [],
      matched_entries: [{ version: "2.0.0", kind: "breaking", text: "drops\n  node 16", source: "x" }],
      unit: "react",
      facade: { required: true, reason: "" },
    }],
  };

  it("writes the call-sites section and reviews a PR body against it", () => {
    const section = CallSitesSection(facts);
    expect(section).toContain("### Call sites");
    expect(section).toContain("- `src/a.js`");
    expect(section).toContain("- 2.0.0 (breaking): drops node 16");
    expect(callSitesReviewed(facts, "touches src/a.js and src/b.js").verdict).toBe("passed");
    expect(callSitesReviewed(facts, "says nothing").verdict).toBe("failed");
    expect(callSitesReviewed(facts, `body\n${section}`).verdict).toBe("passed");
    expect(callSitesReviewed(ZERO_FACTS, "").observed).toBe("0 importers, 0 named in the PR body");
  });

  it("shows one changelog entry as a prompt does", () => {
    expect(collapseFields("  a \n\t b  ")).toBe("a b");
    expect(cutRunes("héllo", 3)).toBe("hél...");
    expect(entryLine({ version: "2", kind: "fix", text: "x\n y", source: "release" })).toBe("2 (fix, from release): x y");
  });

  it("quotes like Go's %q", () => {
    expect(quote("a\"b\n\u0001é")).toBe("\"a\\\"b\\n\\x01é\"");
  });
});

// gatherPullRequestSnapshot

describe("gatherSnapshotOnMachine", () => {
  const RNW_PEERS = "npm view react-native-web@0.21.4 peerDependencies --json";

  function pr588Machine(extra: Record<string, ProcessResult> = {}, prOverride?: string): FakeHostMachine {
    return new FakeHostMachine(
      {
        [prViewLine(588)]: ok(prOverride ?? text("gather/pr_588.json")),
        [filesLine(588)]: ok(text("gather/files_588.json")),
        [RNW_PEERS]: ok("{}"),
        [rgImportsLine("react-native-web")]: ok(text("gather/rg_react-native-web.json")),
        [rgImportsLine("react-native")]: ok(text("gather/rg_react-native.json")),
        [rgExecutionsLine("react-native-web")]: NO_MATCH,
        [rgExecutionsLine("react-native")]: NO_MATCH,
        ...extra,
      },
      { [`${ROOT}/package.json`]: text("gather/config/package.json") },
      ROOT,
    );
  }

  it("builds the whole Snapshot with its facts and its stage timings", async () => {
    const snapshot = await gatherSnapshotOnMachine(pullURL(588), pr588Machine());
    expect(snapshot.url).toBe(pullURL(588));
    expect(snapshot.packages).toEqual([{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }]);
    expect(snapshot.facts?.ecosystem).toBe("npm");
    expect(snapshot.facts?.packages[0]!.aliases).toEqual(["react-native"]);
    expect(snapshot.facts?.packages[0]!.importers.length).toBeGreaterThanOrEqual(100);
    expect(snapshot.facts?.red_log).toBeUndefined();
    expect(snapshot.timings?.map((timing) => timing.name)).toEqual(["load_pull_request", "gather_facts"]);
    expect(decodeSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("excerpts the failed check's log into red_log when CI is red", async () => {
    const pr = json<{ statusCheckRollup: Record<string, unknown>[] }>("gather/pr_588.json");
    pr.statusCheckRollup.push({
      __typename: "CheckRun",
      conclusion: "FAILURE",
      name: "unit",
      detailsUrl: `https://github.com/${BPP2}/actions/runs/777/job/9`,
    });
    const machine = pr588Machine(
      {
        [`gh pr view 588 --repo ${BPP2} --json statusCheckRollup --jq [.statusCheckRollup[]? | select(.conclusion == "FAILURE") | .detailsUrl // ""]`]:
          ok(JSON.stringify([`https://github.com/${BPP2}/actions/runs/777/job/9`])),
        [`gh run view 777 --repo ${BPP2} --log-failed`]: ok(
          "unit\tstep\tok line\nunit\tstep\tTypeError: x is not a function\nunit\tstep\tFAIL src/a.test.js\n",
        ),
      },
      JSON.stringify(pr),
    );
    const snapshot = await gatherSnapshotOnMachine(pullURL(588), machine);
    expect(snapshot.ci).toContainEqual({ name: "unit", passed: false });
    expect(snapshot.facts?.red_log).toBe("unit\tstep\tTypeError: x is not a function\nunit\tstep\tFAIL src/a.test.js");
    expect(snapshot.facts?.ci).toContainEqual({ name: "unit", passed: false });
  });

  it("keeps the snapshot, without a red log, when the failed log cannot be read", async () => {
    const pr = json<{ statusCheckRollup: Record<string, unknown>[] }>("gather/pr_588.json");
    pr.statusCheckRollup.push({ conclusion: "FAILURE", name: "unit", detailsUrl: `https://github.com/${BPP2}/actions/runs/777` });
    const snapshot = await gatherSnapshotOnMachine(pullURL(588), pr588Machine({}, JSON.stringify(pr)));
    expect(snapshot.facts).toBeDefined();
    expect(snapshot.facts?.red_log).toBeUndefined();
  });

  it("throws, and returns no snapshot, when the pull request cannot be read", async () => {
    const machine = pr588Machine({ [prViewLine(588)]: { code: 1, stdout: "", stderr: "HTTP 404: Not Found" } });
    await expect(gatherSnapshotOnMachine(pullURL(588), machine)).rejects.toThrow(
      `depupgrade: load ${pullURL(588)}: github: gh pr view 588`,
    );
  });

  it("throws when the pull request files cannot be read", async () => {
    const machine = pr588Machine({ [filesLine(588)]: { code: 1, stdout: "", stderr: "rate limited" } });
    await expect(gatherSnapshotOnMachine(pullURL(588), machine)).rejects.toThrow(
      `depupgrade: load ${pullURL(588)} files: github: gh api`,
    );
  });

  it("throws when the tree search fails, so a snapshot never goes out without facts", async () => {
    const machine = pr588Machine({ [rgImportsLine("react-native-web")]: { code: 2, stdout: "", stderr: "regex parse error" } });
    await expect(gatherSnapshotOnMachine(pullURL(588), machine)).rejects.toThrow(
      `depupgrade: load ${pullURL(588)} facts: tree: search react-native-web: exit 2: regex parse error`,
    );
  });
});

describe("gatherPullRequestSnapshot over real child processes with fake gh, rg and npm on PATH", () => {
  const savedPath = process.env.PATH;
  const savedFixtures = process.env.UPGRADE_FIXTURES;
  let sandbox = "";
  let checkout = "";

  /** A shell script standing in for a tool: the body runs with `$@` the tool's arguments. */
  function fakeTool(name: string, body: string): void {
    const path = join(sandbox, "bin", name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "lib-gather-"));
    checkout = join(sandbox, "checkout");
    mkdirSync(join(sandbox, "bin"));
    mkdirSync(checkout);
    writeFileSync(join(checkout, "package.json"), text("gather/config/package.json"));
    fakeTool(
      "gh",
      [
        "if [ \"$1\" = pr ] && [ \"$2\" = view ]; then cat \"$UPGRADE_FIXTURES/gather/pr_588.json\"; exit 0; fi",
        "if [ \"$1\" = api ]; then cat \"$UPGRADE_FIXTURES/gather/files_588.json\"; exit 0; fi",
        "echo \"unexpected gh $*\" >&2; exit 9",
      ].join("\n"),
    );
    fakeTool("npm", "echo '{}'");
    fakeTool("rg", "exit 1");
    process.env.UPGRADE_FIXTURES = new URL("./fixtures", import.meta.url).pathname;
    process.env.PATH = `${join(sandbox, "bin")}:/usr/bin:/bin`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedFixtures === undefined) delete process.env.UPGRADE_FIXTURES;
    else process.env.UPGRADE_FIXTURES = savedFixtures;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("expands the URL through the checkout directory the caller supplies and returns facts", async () => {
    const asked: string[] = [];
    const snapshot = await gatherPullRequestSnapshot(`  ${pullURL(588)}/files `, {
      checkout: async (url) => {
        asked.push(url);
        return checkout;
      },
    });
    expect(asked).toEqual([pullURL(588)]);
    expect(snapshot.packages).toEqual([{ name: "react-native-web", from: "0.21.2", to: "0.21.4" }]);
    expect(snapshot.facts?.ecosystem).toBe("npm");
    expect(snapshot.facts?.packages[0]!.importers).toEqual([]);
    // package.json declares expo and react-native-web, so the embedded catalog applies its alias.
    expect(snapshot.facts?.packages[0]!.aliases).toEqual(["react-native"]);
  });

  it("refuses a look-alike URL before it asks for a checkout", async () => {
    let asked = 0;
    await expect(
      gatherPullRequestSnapshot("https://github.com.evil.example/a/b/pull/1", {
        checkout: async () => {
          asked++;
          return checkout;
        },
      }),
    ).rejects.toThrow(/invalid GitHub pull URL/);
    expect(asked).toBe(0);
  });

  it("fails when the checkout cannot be made", async () => {
    await expect(
      gatherPullRequestSnapshot(pullURL(588), {
        checkout: async () => {
          throw new Error("clone failed");
        },
      }),
    ).rejects.toThrow("clone failed");
  });

  it("fails, never returning a snapshot, when gh fails", async () => {
    fakeTool("gh", "echo 'gh: not logged in' >&2; exit 4");
    await expect(gatherPullRequestSnapshot(pullURL(588), { checkout: async () => checkout })).rejects.toThrow(
      /github: gh pr view 588.*exit 4: gh: not logged in/,
    );
  });

  it("fails when rg fails inside the checkout", async () => {
    fakeTool("rg", "echo 'rg: boom' >&2; exit 2");
    await expect(gatherPullRequestSnapshot(pullURL(588), { checkout: async () => checkout })).rejects.toThrow(
      /tree: search react-native-web: exit 2: rg: boom/,
    );
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    let asked = 0;
    await expect(
      gatherPullRequestSnapshot(pullURL(588), {
        signal: controller.signal,
        checkout: async () => {
          asked++;
          return checkout;
        },
      }),
    ).rejects.toThrow("stop");
    expect(asked).toBe(0);
  });
});
