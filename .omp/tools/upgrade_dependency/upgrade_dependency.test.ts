import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import factory, { reportText } from "./index.js";
import { decodeSnapshot, type Facts, type Snapshot } from "./lib/schemas.js";
import type { Facts as LoopFacts } from "./loop/types.js";
import type { PrGates, PrLoopResult } from "./loop/run.js";
import { type Exec, MODEL_TIMEOUT_MS, ompModelStep, RESEARCH_TIMEOUT_MS } from "./omp_model.js";
import {
  CHANGELOG,
  CHANGES,
  FACADE,
  languagePrompt,
  PR_BODY,
  QUALIFIES,
  qualifiesPrompt,
  SCHEMA_LEAD,
  USAGE,
} from "./prompts.js";
import { checkedGates, gatesOf, promptForDecoder, renderChanges, renderQualifies } from "./render.js";
import {
  decodeBody,
  decodeChangelog,
  decodeChanges,
  decodeFacade,
  decodeKind,
  decodeUsages,
  PULL_REQUEST_KINDS,
} from "./schemas.js";
import { upgradeDependency, type UpgradeDeps, type UpgradeResult } from "./upgrade.js";
import type { LockfileState, LockfileStatus, UpgradeHost } from "./upgrade_host.js";

const FIXTURE = new URL("./fixtures/pr_588_snapshot.json", import.meta.url);
const snapshot = (): Snapshot => decodeSnapshot(JSON.parse(readFileSync(FIXTURE, "utf8")));
const URL_588 = snapshot().url!;

const reply = (value: unknown): string => JSON.stringify(value);

/** The marker only each prompt's own input carries, so a scripted reply follows the prompt, not a call count. */
const MARK = {
  qualifies: "Choose exactly one",
  changes: "## Changed files",
  changelog: "## Notes the upgrade pull request already carries",
  usage: "## Packages to trace",
  facade: "## The checklist",
  body: "Headings to use",
} as const;

/** A model that answers each prompt with a reply its step accepts; `override` replaces any one reply. */
class FakeModel {
  readonly prompts: string[] = [];
  constructor(
    private readonly kind: string = "upgrade",
    private readonly override: (prompt: string, attempt: number) => string | undefined = () => undefined,
  ) {}
  private readonly attempts = new Map<string, number>();

  readonly step = async (prompt: string): Promise<string> => {
    this.prompts.push(prompt);
    const key = Object.entries(MARK).find(([, marker]) => prompt.includes(marker))?.[0] ?? "other";
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const custom = this.override(prompt, attempt);
    if (custom !== undefined) return custom;
    const pkg = snapshot().packages[0]!;
    switch (key) {
      case "qualifies":
        return reply({ Kind: this.kind });
      case "changes":
        return reply({
          packages: [{ name: pkg.name, from: pkg.from, to: pkg.to, evidence: "package.json: the version line moves" }],
        });
      case "changelog":
        return reply({
          packages: [{
            name: pkg.name,
            entries: [{ version: pkg.to, kind: "fix", url: `https://example.invalid/${pkg.to}`, text: "A bug fix." }],
            advisories: [],
          }],
        });
      case "usage":
        return reply({
          usages: [{
            package: pkg.name,
            file: "src/app.js",
            line: 1,
            how: "direct-import",
            basis: "import-graph",
            evidence: "import { View } from 'react-native-web'",
            touched: "nothing in the range touches it",
          }],
        });
      case "facade":
        return reply({ needed: false, reason: "One import site: a facade is optional here.", steps: [] });
      default:
        return reply({ units: [{ heading: `${pkg.name} ${pkg.from} → ${pkg.to}`, behavior: "Nothing changes." }] });
    }
  };
  /** The prompt kinds asked, in order. */
  get asked(): string[] {
    return this.prompts.map((prompt) => Object.entries(MARK).find(([, marker]) => prompt.includes(marker))?.[0] ?? "?");
  }
}

const IN_PR: LockfileStatus = { state: "in_pull_request", lockfile: "package-lock.json" };

class FakeHost implements UpgradeHost {
  readonly calls: string[] = [];
  settled: LockfileState = { head: "h1", statuses: [IN_PR] };
  resettled: LockfileState[] = [];
  armed = { armed: true, reason: "armed" };
  changed: { path: string; patch: string }[] | undefined;
  headUnits: string[][] | undefined;
  async settleLockfiles(manifests: readonly string[], lockfiles: readonly string[]): Promise<LockfileState> {
    this.calls.push(`settle ${manifests.join(",")} | ${lockfiles.join(",")}`);
    return this.settled;
  }
  async resettleLockfiles(manifests: readonly string[], lockfiles: readonly string[]): Promise<LockfileState> {
    this.calls.push(`resettle ${manifests.join(",")} | ${lockfiles.join(",")}`);
    return this.resettled.shift() ?? this.settled;
  }
  async armPullRequest(): Promise<{ armed: boolean; reason: string }> {
    this.calls.push("arm");
    return this.armed;
  }
  async currentChangedFiles(repo: string, number: number) {
    this.calls.push(`files ${repo}#${number}`);
    return this.changed;
  }
  async currentHeadUnits(repo: string, number: number, ecosystem: string) {
    this.calls.push(`units ${repo}#${number} ${ecosystem}`);
    return this.headUnits;
  }
}

const DONE: PrLoopResult = { status: "done", rounds: 0, reasons: [], text: `${URL_588} @ h1: done` };

class World {
  model: FakeModel;
  host = new FakeHost();
  snap: Snapshot = snapshot();
  loopResult: PrLoopResult | Error = DONE;
  loopCalls: { prUrl: string; gates: PrGates }[] = [];
  /** Stands in for the loop: reads heads through `gates`, then ends with `loopResult`. */
  loopBody: ((gates: PrGates) => Promise<void>) | undefined;
  gathered: string[] = [];
  /** Prompts sent through the plain (no tools) step and through the researching (read-only tools) step. */
  plainPrompts: string[] = [];
  researchPrompts: string[] = [];
  researchUrls: string[] = [];
  progress: string[] = [];
  now = 0;

  constructor(model: FakeModel = new FakeModel()) {
    this.model = model;
  }

  withFacts(facts: Partial<Facts>): this {
    this.snap = { ...this.snap, facts: { ...this.snap.facts!, ...facts } };
    return this;
  }

  deps(): UpgradeDeps {
    return {
      model: (prompt) => {
        this.plainPrompts.push(prompt);
        return this.model.step(prompt);
      },
      research: async (prUrl) => {
        this.researchUrls.push(prUrl);
        return (prompt) => {
          this.researchPrompts.push(prompt);
          return this.model.step(prompt);
        };
      },
      host: this.host,
      loop: async (input) => {
        this.loopCalls.push(input);
        if (this.loopBody) await this.loopBody(input.gates);
        if (this.loopResult instanceof Error) throw this.loopResult;
        return this.loopResult;
      },
      gather: async (prUrl) => {
        this.gathered.push(prUrl);
        return this.snap;
      },
      clock: () => (this.now += 1000),
      progress: (message) => this.progress.push(message),
    };
  }

  run(url: string = URL_588): Promise<UpgradeResult> {
    return upgradeDependency(this.deps(), url);
  }
}

const head = (headSha: string): LoopFacts => ({ headSha, repo: "o/r", number: 588 }) as LoopFacts;
const verdictOf = (gates: readonly { name: string; verdict: string }[], name: string) =>
  gates.find((gate) => gate.name === name)?.verdict;
const CLEAN_TESTS = { test_diff: { changed: [], suspicious: [] } };

describe("upgrade_dependency flow", () => {
  it("runs the six prompts in order, loops, and arms when everything passes", async () => {
    const world = new World();
    const report = await world.run();
    expect(world.model.asked).toEqual(["qualifies", "changes", "changelog", "usage", "facade", "body"]);
    expect(world.gathered).toEqual([URL_588]);
    expect(report.kind).toBe("upgrade");
    expect(report.changes.packages[0]!.name).toBe("react-native-web");
    expect(report.usages).toHaveLength(1);
    expect(report.facade.needed).toBe(false);
    expect(report.body.units).toHaveLength(1);
    expect(report.gates.map((gate) => gate.name)).toEqual([
      "one_dependency_per_commit",
      "lockfile_committed",
      "tests_unweakened",
      "ci",
    ]);
    expect(report.gates.some((gate) => gate.verdict === "failed")).toBe(false);
    expect(report.verdict).toBe("ready");
    expect(world.host.calls).toContain("arm");
    expect(world.host.calls[0]).toBe("settle package.json | package-lock.json");
    expect(report.seconds).toBeGreaterThan(0);
    expect(world.progress).toContain("pull request loop");
  });

  it("sends only the changelog and usage prompts through the researching step, with a note naming its tools", async () => {
    const world = new World();
    await world.run();
    const kindOf = (prompt: string) => Object.entries(MARK).find(([, marker]) => prompt.includes(marker))?.[0];
    expect(world.researchUrls).toEqual([URL_588]);
    expect(world.researchPrompts.map(kindOf)).toEqual(["changelog", "usage"]);
    expect(world.plainPrompts.map(kindOf)).toEqual(["qualifies", "changes", "facade", "body"]);
    for (const prompt of world.researchPrompts) {
      expect(prompt).toContain("read-only checkout of the pull request head");
      expect(prompt).toContain("web_search");
      expect(prompt).toContain("Never write or change anything.");
    }
    for (const prompt of world.plainPrompts) expect(prompt).not.toContain("read-only checkout");
    expect(world.researchPrompts[0]).toContain(CHANGELOG.instructions);
    expect(world.researchPrompts[1]).toContain(USAGE.instructions);
  });

  it("checks out nothing for research when the pull request is not an upgrade", async () => {
    for (const kind of ["not_dependency", "config_only"]) {
      const world = new World(new FakeModel(kind));
      await world.run();
      expect(world.researchUrls).toEqual([]);
      expect(world.researchPrompts).toEqual([]);
    }
  });

  it("skips a not_dependency pull request: no loop, no lockfile, no label, no gates", async () => {
    const world = new World(new FakeModel("not_dependency"));
    const report = await world.run();
    expect(report).toMatchObject({ kind: "not_dependency", verdict: "skipped", gates: [] });
    expect(world.model.asked).toEqual(["qualifies"]);
    expect(world.loopCalls).toEqual([]);
    expect(world.host.calls).toEqual([]);
  });

  it("sends config_only through the loop with no changes and arms it", async () => {
    const world = new World(new FakeModel("config_only"));
    const report = await world.run();
    expect(report).toMatchObject({ kind: "config_only", verdict: "ready" });
    expect(report.changes.packages).toEqual([]);
    expect(report.usages).toEqual([]);
    expect(world.model.asked).toEqual(["qualifies"]);
    expect(world.loopCalls).toHaveLength(1);
    expect(world.host.calls).toContain("arm");
  });

  it.each(["impossible", "spent"] as const)("reports a loop that ended %s as needs_work with its reasons", async (status) => {
    const world = new World().withFacts(CLEAN_TESTS);
    world.loopResult = {
      status,
      rounds: 2,
      reasons: ["push refused: zizmor dangerous-triggers"],
      text: `${URL_588} @ h1: ${status}`,
    };
    const report = await world.run();
    expect(report.verdict).toBe("needs_work");
    const ci = report.gates.find((gate) => gate.name === "ci")!;
    expect(ci.verdict).toBe("failed");
    expect(ci.observed).toContain(status);
    expect(ci.observed).toContain("push refused: zizmor dangerous-triggers");
    expect(world.host.calls).not.toContain("arm");
  });

  it("turns a throwing loop into a failed ci gate with the message, not a throw", async () => {
    const world = new World();
    world.loopResult = new Error("checkout failed: disk full");
    const report = await world.run();
    expect(report.verdict).toBe("needs_work");
    expect(report.gates.find((gate) => gate.name === "ci")).toMatchObject({
      verdict: "failed",
      observed: "checkout failed: disk full",
    });
  });

  it("does not arm and reports needs_work when a gate failed though the loop ended done", async () => {
    const world = new World().withFacts({
      test_diff: {
        changed: ["src/a.test.js"],
        suspicious: [{ path: "src/a.test.js", kind: "removed_assertion", line: "expect(a).toBe(1)" }],
      },
    });
    const report = await world.run();
    expect(verdictOf(report.gates, "tests_unweakened")).toBe("failed");
    expect(report.verdict).toBe("needs_work");
    expect(world.host.calls).not.toContain("arm");
  });

  it("reports needs_work when arming is refused", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    world.host.armed = { armed: false, reason: "label failed" };
    expect((await world.run()).verdict).toBe("needs_work");
  });

  it("still arms when a gate is only not_proven", async () => {
    const world = new World().withFacts({ test_diff: { changed: ["src/a.test.js"], suspicious: [] } });
    const report = await world.run();
    expect(verdictOf(report.gates, "tests_unweakened")).toBe("not_proven");
    expect(report.verdict).toBe("ready");
    expect(world.host.calls).toContain("arm");
  });

  it("is ready without arming when the loop ended merged", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    world.loopResult = { status: "merged", rounds: 0, reasons: [], text: "already landed" };
    const report = await world.run();
    expect(report.verdict).toBe("ready");
    expect(world.host.calls).not.toContain("arm");
  });

  it("refuses a snapshot with no facts before asking any model", async () => {
    const world = new World();
    world.snap = { ...world.snap, facts: undefined };
    await expect(world.run()).rejects.toThrow("needs the snapshot's facts");
    expect(world.model.prompts).toEqual([]);
  });

  it("rejects a pull request URL that is not exact, before gathering", async () => {
    const world = new World();
    await expect(world.run("https://github.com/o/r/pull/1?x=1")).rejects.toThrow();
    expect(world.gathered).toEqual([]);
  });

  it("lets a gather failure through", async () => {
    const world = new World();
    const deps = { ...world.deps(), gather: async () => Promise.reject(new Error("gh: not found")) };
    await expect(upgradeDependency(deps, URL_588)).rejects.toThrow("gh: not found");
  });
});

describe("caller gates in the loop", () => {
  it("hands the loop the upgrade's gates, without ci", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    await world.run();
    const gates = await world.loopCalls[0]!.gates(head("h1"));
    expect(gates.map((gate) => gate.name)).toEqual([
      "one_dependency_per_commit",
      "lockfile_committed",
      "tests_unweakened",
    ]);
    expect(world.host.calls.filter((call) => call.startsWith("resettle"))).toEqual([]);
  });

  it("settles the lockfile again on a new head: a failure at the first reading passes at the next", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    world.host.settled = {
      head: "h1",
      statuses: [{ state: "stale", lockfile: "package-lock.json", reason: "install failed" }],
    };
    world.host.resettled = [{ head: "h2", statuses: [IN_PR] }];
    world.loopBody = async (gates) => {
      const first = await gates(head("h1"));
      expect(verdictOf(first, "lockfile_committed")).toBe("failed");
      const second = await gates(head("h2"));
      expect(second.some((gate) => gate.verdict === "failed")).toBe(false);
    };
    const report = await world.run();
    expect(verdictOf(report.gates, "lockfile_committed")).toBe("passed");
    expect(report.verdict).toBe("ready");
  });

  it("fails the reading whose settle pushed a rewritten lockfile, and passes the head it made", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    const rewritten: LockfileStatus = { state: "rewritten", lockfile: "package-lock.json", via: "bun install" };
    world.host.resettled = [{ head: "h3", statuses: [rewritten] }, { head: "h3", statuses: [IN_PR] }];
    world.loopBody = async (gates) => {
      expect(verdictOf(await gates(head("h1")), "lockfile_committed")).toBe("passed");
      const pushed = await gates(head("h2"));
      expect(pushed.find((gate) => gate.name === "lockfile_committed")).toMatchObject({
        verdict: "failed",
        observed: expect.stringContaining("pushed as a new head not yet read"),
      });
      expect(verdictOf(await gates(head("h3")), "lockfile_committed")).toBe("passed");
      const seen = world.host.calls.length;
      await gates(head("h3"));
      expect(world.host.calls).toHaveLength(seen);
    };
    expect((await world.run()).verdict).toBe("ready");
  });

  it("re-reads the head's units, so the one-dependency gate judges a body a round narrowed", async () => {
    const world = new World().withFacts({ units: [["react", "react-dom"], ["eslint-plugin-react-hooks"]] });
    world.model = new FakeModel("upgrade", (prompt) =>
      prompt.includes(MARK.changes)
        ? reply({
          packages: [
            { name: "react", from: "19.2.4", to: "19.3.1", evidence: "package.json" },
            { name: "react-dom", from: "19.2.4", to: "19.3.1", evidence: "package.json" },
            { name: "eslint-plugin-react-hooks", from: "7.0.1", to: "7.1.1", evidence: "package.json" },
          ],
        })
        : prompt.includes(MARK.changelog)
        ? reply({ packages: [] })
        : prompt.includes(MARK.body)
        ? reply({
          units: ["react", "react-dom", "eslint-plugin-react-hooks"].map((name) => ({ heading: name, behavior: "x" })),
        })
        : undefined);
    world.host.changed = [{ path: "package.json", patch: "@@ -1 +1 @@" }, { path: "package-lock.json", patch: "" }];
    world.host.headUnits = [["react", "react-dom"]];
    world.loopBody = async (gates) => {
      expect(verdictOf(await gates(head("h1")), "one_dependency_per_commit")).toBe("failed");
      expect(verdictOf(await gates(head("h2")), "one_dependency_per_commit")).toBe("passed");
    };
    const report = await world.run();
    expect(world.host.calls).toContain("files o/r#588");
    expect(world.host.calls).toContain("units o/r#588 npm");
    expect(report.verdict).toBe("ready");
  });

  it("re-reads tests_unweakened from the new head's patches, so a restored assertion clears the gate", async () => {
    const world = new World().withFacts({
      test_diff: {
        changed: ["main_test.go"],
        suspicious: [{ path: "main_test.go", kind: "removed_assertion", line: "t.Fatal(status)" }],
      },
    });
    world.host.changed = [{ path: "main_test.go", patch: "@@ -1 +1 @@\n-a := 1\n+a := 2" }];
    world.loopBody = async (gates) => {
      expect(verdictOf(await gates(head("h1")), "tests_unweakened")).toBe("failed");
      const second = await gates(head("h2"));
      expect(second.find((gate) => gate.name === "tests_unweakened")).toMatchObject({
        verdict: "not_proven",
        observed: expect.stringContaining("main_test.go"),
      });
    };
    const report = await world.run();
    expect(verdictOf(report.gates, "tests_unweakened")).toBe("not_proven");
    expect(report.verdict).toBe("ready");
  });

  it("keeps the snapshot's files when the head's changed files cannot be read", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    world.host.changed = undefined;
    world.loopBody = async (gates) => {
      expect(verdictOf(await gates(head("h2")), "lockfile_committed")).toBe("passed");
    };
    expect((await world.run()).verdict).toBe("ready");
    expect(world.host.calls).toContain("resettle package.json | package-lock.json");
  });
});

describe("validator refusals", () => {
  const failing = (override: (prompt: string) => string | undefined) =>
    new World(new FakeModel("upgrade", override)).run();

  it("asks again with the reason, then accepts the corrected reply", async () => {
    const model = new FakeModel("upgrade", (prompt, attempt) =>
      prompt.includes(MARK.changelog) && attempt === 1
        ? reply({
          packages: [{
            name: "react-native-web",
            entries: [{ version: "9.9.9", kind: "fix", url: "https://x.invalid", text: "t" }],
            advisories: [],
          }],
        })
        : undefined);
    const world = new World(model);
    const report = await world.run();
    expect(model.asked.filter((kind) => kind === "changelog")).toHaveLength(2);
    expect(model.prompts.find((prompt) => prompt.includes("was rejected"))).toContain("outside the range");
    expect(report.changelog.packages[0]!.entries[0]!.version).toBe("0.21.4");
  });

  const cases: [string, string, string, unknown][] = [
    ["empty packages", MARK.changes, "name it from the manifest or lockfile lines", { packages: [] }],
    [
      "unknown version placeholder",
      MARK.changes,
      "has no version read from the changed lines",
      { packages: [{ name: "a", from: "Unknown (not visible)", to: "2.0.0", evidence: "e" }] },
    ],
    [
      "empty evidence",
      MARK.changes,
      "say which changed file and lines showed a 1.0.0 → 2.0.0",
      { packages: [{ name: "a", from: "1.0.0", to: "2.0.0", evidence: "" }] },
    ],
    [
      "package outside the upgrade",
      MARK.changelog,
      "is not one of the packages being upgraded",
      { packages: [{ name: "other", entries: [], advisories: [] }] },
    ],
    [
      "entry without a url",
      MARK.changelog,
      "names no reference URL",
      { packages: [{ name: "react-native-web", entries: [{ version: "0.21.4", kind: "fix", url: "", text: "t" }], advisories: [] }] },
    ],
    [
      "entry without text",
      MARK.changelog,
      "says what changed but not what it means",
      { packages: [{ name: "react-native-web", entries: [{ version: "0.21.4", kind: "fix", url: "u", text: "" }], advisories: [] }] },
    ],
    [
      "usage without evidence",
      MARK.usage,
      "every usage needs the package, the file, and the evidence",
      { usages: [{ package: "p", file: "f", how: "binary", basis: "read", evidence: "", touched: "" }] },
    ],
    ["facade without a reason", MARK.facade, "say why this upgrade needs a facade", { needed: false, reason: "", steps: [] }],
    ["needed facade without a name", MARK.facade, "needs its name and the file", { needed: true, reason: "r", steps: [] }],
    [
      "needed facade without steps",
      MARK.facade,
      "needs its ordered steps",
      { needed: true, reason: "r", name: "N", path: "p", steps: [] },
    ],
    ["body unit count", MARK.body, "answer for exactly 1 package(s)", { units: [] }],
  ];

  it.each(cases)("refuses %s", async (_label, marker, message, bad) => {
    const attempts: string[] = [];
    await expect(
      failing((prompt) => {
        if (!prompt.includes(marker)) return undefined;
        attempts.push(prompt);
        return reply(bad);
      }),
    ).rejects.toThrow(message);
    expect(attempts).toHaveLength(3);
  });

  it("refuses a reply that is not JSON and a qualifies reply outside the closed choice", async () => {
    await expect(failing((prompt) => (prompt.includes(MARK.qualifies) ? "not json at all" : undefined))).rejects.toThrow(
      "the reply is not JSON",
    );
    await expect(
      failing((prompt) => (prompt.includes(MARK.qualifies) ? reply({ Kind: "maybe" }) : undefined)),
    ).rejects.toThrow("reply.Kind must be one of upgrade, config_only, not_dependency");
  });

  it("accepts a fenced JSON reply", async () => {
    const model = new FakeModel("upgrade", (prompt) =>
      prompt.includes(MARK.qualifies) ? "```json\n{\"Kind\":\"not_dependency\"}\n```" : undefined);
    expect((await new World(model).run()).verdict).toBe("skipped");
  });
});

describe("prompts and rendering", () => {
  it("copies the six prompts from the yaml and asks for the reply itself, not a field wrapper", () => {
    expect(QUALIFIES.instructions).toContain("Judge it by the changed files, not by the description");
    expect(Object.keys(QUALIFIES.criteria)).toEqual([...PULL_REQUEST_KINDS]);
    for (const question of [CHANGES, CHANGELOG, USAGE, FACADE, PR_BODY]) {
      expect(question.instructions.length).toBeGreaterThan(50);
      const sent = promptForDecoder(languagePrompt(question, "diff"), question.schema);
      const pasted = JSON.parse(sent.slice(sent.lastIndexOf(SCHEMA_LEAD) + SCHEMA_LEAD.length));
      expect(pasted).toEqual(question.schema);
      expect(sent).toContain(`## ${question.field}\n`);
      expect(sent).toContain("Prompt:\ndiff\n");
    }
    const changes = promptForDecoder(languagePrompt(CHANGES, "diff"), CHANGES.schema);
    expect((JSON.parse(changes.slice(changes.lastIndexOf(SCHEMA_LEAD) + SCHEMA_LEAD.length)) as { required: string[] }).required)
      .toEqual(["packages"]);
    expect(changes).not.toContain("\"Packages\"");
  });

  it("replaces a wrapped schema tail instead of appending a second one", () => {
    const wrapped = `body${SCHEMA_LEAD}{"wrapped":true}`;
    expect(promptForDecoder(wrapped, { type: "object" })).toBe(`body${SCHEMA_LEAD}{"type":"object"}`);
  });

  it("builds the qualifies prompt as a closed choice over the three kinds", () => {
    const text = qualifiesPrompt(QUALIFIES, renderQualifies(snapshot()));
    expect(text).toContain("Choose exactly one:");
    expect(text).toContain("- config_only:");
    expect(text).toContain("{\"Kind\": \"upgrade\" | \"config_only\" | \"not_dependency\"}");
    expect(text).toContain("package-lock.json");
  });

  it("gives the changes prompt the diff itself, not only the description", () => {
    const rendered = renderChanges(snapshot());
    expect(rendered).toContain("## The pull request description");
    expect(rendered).toContain("package.json");
    expect(rendered).toContain("package-lock.json");
  });

  it("cuts the qualifies description and leaves a large patch to its path", () => {
    const input = snapshot();
    input.body = "x".repeat(5000);
    input.files = [{ path: "a.ts", patch: "p".repeat(1501) }, { path: "b.ts", patch: "small" }];
    const state = renderQualifies(input);
    expect(state.description).toHaveLength(4000);
    expect(state.changed_files).toEqual([{ path: "a.ts" }, { path: "b.ts", diff: "small" }]);
  });

  const claimed = { packages: [{ name: "actions/checkout", from: "v4", to: "v4", evidence: "pin digest moves" }] };
  const lockfileGate = (files: string[], facts: Partial<Facts>, changes = claimed) => {
    const input = snapshot();
    input.files = files.map((path) => ({ path }));
    input.facts = { ...input.facts!, lockfile: [], manifest: [], ...facts };
    return gatesOf(input, changes, { green: true, reason: "green" }, []).find((gate) => gate.name === "lockfile_committed")!;
  };

  it("passes the lockfile gate for a pull request that only moves git-ref pins or changes no files", () => {
    expect(lockfileGate([".github/workflows/ci.yml"], {})).toMatchObject({ verdict: "passed" });
    expect(lockfileGate([".github/workflows/ci.yml", ".pinact.yaml"], {}).observed).toContain(".pinact.yaml pin a git ref");
    expect(lockfileGate([], {})).toMatchObject({ verdict: "passed", observed: "no files changed, so no lockfile is owed" });
  });

  it("fails the lockfile gate when a non-pin file rides along, or a manifest has no installer and no lockfile", () => {
    expect(lockfileGate([".github/workflows/ci.yml", "src/app.ts"], {})).toMatchObject({
      verdict: "failed",
      observed: "no lockfile in the changed files",
    });
    expect(lockfileGate(["Cargo.toml"], { manifest: ["Cargo.toml"] })).toMatchObject({ verdict: "failed" });
    expect(lockfileGate(["package.json"], { manifest: ["package.json"] }, { packages: [] }).verdict).toBe("failed");
  });

  it("owes no lockfile when no manifest changed and no upgrade is claimed", () => {
    expect(lockfileGate(["src/app.ts"], {}, { packages: [] })).toMatchObject({ verdict: "passed" });
    expect(lockfileGate(["package.json", "package-lock.json"], { manifest: ["package.json"], lockfile: ["package-lock.json"] }).verdict)
      .toBe("passed");
  });

  it("describes every lockfile state in the gate and fails on a stale one", () => {
    const input = snapshot();
    input.facts = { ...input.facts!, lockfile: [] };
    const statuses: LockfileStatus[] = [
      { state: "rewritten", lockfile: "a.lock", via: "pnpm" },
      { state: "unchanged", lockfile: "b.lock", via: "go mod tidy" },
      { state: "absent", manifest: "mise.toml", lockfiles: ["mise.lock"] },
    ];
    const gate = checkedGates(input, { packages: [] }, statuses).find((g) => g.name === "lockfile_committed")!;
    expect(gate.observed).toBe(
      "a.lock rewritten and committed by pnpm; b.lock unchanged by go mod tidy; no lockfile for mise.toml (mise.lock)",
    );
    const stale = checkedGates(input, { packages: [] }, [{ state: "stale", lockfile: "c.lock", reason: "boom" }]);
    expect(stale.find((g) => g.name === "lockfile_committed")).toMatchObject({
      verdict: "failed",
      observed: "c.lock is stale and could not be rewritten: boom",
    });
  });

  it("fails one_dependency_per_commit for several units behind several packages", () => {
    const input = snapshot();
    input.facts = { ...input.facts!, units: [["a"], ["b", "c"]] };
    const two = { packages: [{ name: "a", from: "1", to: "2", evidence: "e" }, { name: "b", from: "1", to: "2", evidence: "e" }] };
    expect(checkedGates(input, two, [IN_PR])[0]).toMatchObject({
      verdict: "failed",
      observed: "2 units: a; b + c",
    });
    expect(checkedGates(input, { packages: [] }, [IN_PR])[0]!.observed).toBe("no dependency upgraded");
  });
});

describe("decoders", () => {
  it("name the bad field", () => {
    expect(() => decodeChanges([])).toThrow("reply must be an object");
    expect(() => decodeChanges({})).toThrow("reply.packages must be an array");
    expect(() => decodeChanges({ packages: [{ name: "a", from: 1, to: "b", evidence: "e" }] })).toThrow(
      "reply.packages[0].from must be a string",
    );
    expect(() => decodeChangelog({ packages: [{ name: "a", entries: [{ version: "1", kind: "big", url: "", text: "" }], advisories: [] }] }))
      .toThrow("reply.packages[0].entries[0].kind must be one of breaking, deprecation, security, behavior, fix, other");
    expect(() => decodeChangelog({ packages: [{ name: "a", entries: [], advisories: [{ url: 1, summary: "s" }] }] })).toThrow(
      "reply.packages[0].advisories[0].url must be a string",
    );
    expect(() => decodeUsages({ usages: [{ package: "p", file: "f", line: 1.5 }] })).toThrow("reply.usages[0].line must be an integer");
    expect(() =>
      decodeUsages({ usages: [{ package: "p", file: "f", how: "magic", basis: "read", evidence: "e", touched: "t" }] })
    ).toThrow("reply.usages[0].how must be one of direct-import, binary, wrapper");
    expect(() =>
      decodeUsages({ usages: [{ package: "p", file: "f", how: "binary", basis: "guess", evidence: "e", touched: "t" }] })
    ).toThrow("reply.usages[0].basis must be one of import-graph, call-graph, lockfile-trace, advisory-trace, read");
    expect(() => decodeFacade({ needed: "yes", reason: "r" })).toThrow("reply.needed must be a boolean");
    expect(() => decodeFacade({ needed: true, reason: "r", steps: [{ order: "1", what: "w", green_when: "g" }] })).toThrow(
      "reply.steps[0].order must be an integer",
    );
    expect(() => decodeFacade({ needed: true, reason: "r", steps: [{ order: 1, what: "w", green_when: "g", human: "no" }] })).toThrow(
      "reply.steps[0].human must be a boolean",
    );
    expect(() => decodeBody({ units: [{ heading: "h" }] })).toThrow("reply.units[0].behavior must be a string");
    expect(() => decodeKind({ Kind: "other" })).toThrow("reply.Kind must be one of upgrade, config_only, not_dependency");
  });

  it("fill the defaults Mastra's schema gave and keep optional fields only when present", () => {
    const changelog = decodeChangelog({
      packages: [{ name: "a", entries: [], advisories: [{ url: "u", summary: "s" }] }],
    });
    expect(changelog.packages[0]!.advisories[0]).toEqual({ id: "", url: "u", affects: [], summary: "s" });
    expect(decodeFacade({ needed: false, reason: "r" })).toEqual({ needed: false, reason: "r", steps: [] });
    const facade = decodeFacade({
      needed: true,
      reason: "r",
      name: "N",
      path: "p",
      owns: "o",
      steps: [{ order: 1, what: "w", green_when: "g", human: true }],
    });
    expect(facade.steps[0]).toEqual({ order: 1, what: "w", green_when: "g", human: true });
    const usage = decodeUsages({
      usages: [{ package: "p", file: "f", line: 3, how: "wrapper", basis: "read", symbol: "s", evidence: "e", touched: "t" }],
    });
    expect(usage.usages[0]).toMatchObject({ line: 3, symbol: "s" });
    expect(decodeKind({ Kind: "config_only" })).toBe("config_only");
  });
});

describe("ompModelStep", () => {
  interface Call {
    command: string;
    args: string[];
    cwd: string | undefined;
    timeout: number | undefined;
    prompt: string;
  }
  const recording = (calls: Call[]): Exec => async (command, args, options) => {
    const file = args[1]!.slice(1);
    calls.push({ command, args, cwd: options?.cwd, timeout: options?.timeout, prompt: readFileSync(file, "utf8") });
    return { stdout: " {\"ok\":true} \n", stderr: "", code: 0, killed: false };
  };

  it("is a bare completion by default: --no-tools, the private temp directory as cwd, the plain timeout", async () => {
    const calls: Call[] = [];
    expect(await ompModelStep(recording(calls), { model: "@task" })("hello")).toBe("{\"ok\":true}");
    const [call] = calls;
    expect(call!.command).toBe("omp");
    expect(call!.args).toContain("--no-tools");
    expect(call!.args.some((arg) => arg.startsWith("--tools"))).toBe(false);
    expect(call!.args.slice(call!.args.indexOf("--model"), call!.args.indexOf("--model") + 2)).toEqual(["--model", "@task"]);
    expect(call!.prompt).toBe("hello");
    expect(call!.cwd).toContain("omp-model-step-");
    expect(call!.timeout).toBe(MODEL_TIMEOUT_MS);
  });

  it("grants exactly the named tools, replaces --no-tools, keeps the other bare flags, and runs in cwd", async () => {
    const calls: Call[] = [];
    const step = ompModelStep(recording(calls), {
      model: "@task",
      tools: ["read", "grep", "find", "web_search"],
      cwd: "/work/checkout",
    });
    await step("research this");
    const [call] = calls;
    expect(call!.args).toContain("--tools=read,grep,find,web_search");
    expect(call!.args).not.toContain("--no-tools");
    for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files"]) {
      expect(call!.args).toContain(flag);
    }
    expect(call!.cwd).toBe("/work/checkout");
    expect(call!.args[1]).not.toContain("/work/checkout");
    expect(call!.prompt).toBe("research this");
    expect(call!.timeout).toBe(RESEARCH_TIMEOUT_MS);
    expect(RESEARCH_TIMEOUT_MS).toBe(900_000);
  });

  it("lets timeoutMs override the default and names it when the child is killed", async () => {
    const calls: Call[] = [];
    await ompModelStep(recording(calls), { tools: ["read"], timeoutMs: 1234 })("x");
    expect(calls[0]!.timeout).toBe(1234);
    const killed: Exec = async () => ({ stdout: "", stderr: "", code: 1, killed: true });
    await expect(ompModelStep(killed, { timeoutMs: 2000 })("x")).rejects.toThrow("killed after 2 s");
  });

  it("treats an empty tool list as no tools", async () => {
    const calls: Call[] = [];
    await ompModelStep(recording(calls), { tools: [] })("x");
    expect(calls[0]!.args).toContain("--no-tools");
  });
});

/** A chainable stand-in for `pi.zod`: every method returns the same proxy. */
function fakeZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}
interface BuiltTool {
  name: string;
  label: string;
  description: string;
  loadMode?: unknown;
  execute(id: string, params: unknown, onUpdate?: unknown, ctx?: unknown, signal?: AbortSignal): Promise<unknown>;
}

describe("tool object", () => {
  const build = async (): Promise<BuiltTool> => (factory as unknown as (pi: unknown) => BuiltTool)({ zod: fakeZod() });

  it("is named, discoverable, and describes itself within 80-250 words", async () => {
    const tool = await build();
    expect(tool.name).toBe("upgrade_dependency");
    expect(tool.loadMode).toBeUndefined();
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(tool.description).toContain("--input");
    expect(tool.description).toContain("ai:dependencies-checked");
    expect(tool.description).toContain("read-only tools (read, grep, find, web_search)");
    expect(tool.description).toContain("`gh`, `git`, `rg` and the ecosystem's lock tool (aube/pnpm/npm, go, mise) on PATH");
  });

  it("rejects a look-alike or inexact pull request URL by throwing, before any call", async () => {
    const tool = await build();
    await expect(tool.execute("id", { url: "https://github.com.evil.example/acme/widgets/pull/7" })).rejects.toThrow();
    await expect(tool.execute("id", { url: "https://github.com/acme/widgets/pull/7?x=1" })).rejects.toThrow();
    await expect(tool.execute("id", { url: "not a url" })).rejects.toThrow();
  });

  it("renders a report as text with the verdict and every gate", async () => {
    const world = new World().withFacts(CLEAN_TESTS);
    const text = reportText(await world.run());
    expect(text).toContain(`upgrade_dependency ${URL_588}: ready (upgrade,`);
    expect(text).toContain("upgrading: react-native-web 0.21.2 → 0.21.4");
    expect(text).toContain("passed ci:");
  });
});
