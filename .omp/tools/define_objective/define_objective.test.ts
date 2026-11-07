import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPANDED_LIMIT, miseTasks, openTasks, projectContext, projectLayout, TOP_LEVEL_LIMIT, checkoutNamed, registeredProjects, conventionalHome, firstProse, repositoryGoal } from "./checkout.js";
import { detectRunners } from "./checkout_runners.js";
import { changedFilesSince, extractTestNames, listTestFiles, TEST_FILE_LIMIT, TEST_FILE_PATHSPECS } from "./checkout_tests.js";
import { layoutAccepts, looksLikeHost, pathsNamedBy } from "./checked_paths.js";
import { crossCuttingReason } from "./cross_cutting.js";
import { objectivePrompt, parseObjectiveReply, runDefineObjective } from "./define_objective.js";
import factory from "./index.js";
import { type Machine, nodeMachine, type ProcessResult } from "./machine.js";
import { BARE_OMP_FLAGS, type Exec, type ModelStep, ompModelStep } from "./omp_model.js";
import { contextLines, duplicateOf } from "./project_context.js";
import { objectiveProblems, type Scene, sizedChecks, targetingOf } from "./targeting.js";
import { taskSpecProblems } from "./atask_grammar.js";
import { NEAR_GOAL_LIMIT, rankByRelevance, testIndexNearGoal, tokensOf } from "./test_index.js";
import { namesWholeSuite, testInvocations, testTargets } from "./test_invocation.js";
import type { DefinedObjective, ObjectiveReply, ProjectContext, TaskSpec } from "./types.js";

// ---- the project layouts the rules are tried against (the Mastra test fixtures)
/** A Go project: tests sit beside the code, one package per directory, nothing but `go test` to run them. */
const goProject: ProjectContext = {
  Home: "/p/agentmux",
  Layout: ["AGENTS.md", "cmd/", "go.mod", "internal/", "mise.toml"],
  Unlisted: ["cmd", "internal"],
  MiseTasks: ["ci", "lint", "test"],
  OpenTasks: [],
  Runners: [{ Kind: "go", Dir: "", Command: "go test", Detail: "github.com/zachbornheimer/agentmux" }],
  TestFiles: [
    "delegate_select_model_test.go",
    "internal/capabilities/select_model_test.go",
    "internal/capability/answer_subject_test.go",
    "internal/capability/ranked_models_test.go",
    "internal/model/run_test.go",
  ],
  TestNames: {
    "internal/capability/ranked_models_test.go": ["TestRankedModelsPutLocalLast", "TestRankedModelsKeepOrder"],
  },
};

/** A TypeScript project whose vitest config lives one directory down, as capability-replicas does. */
const typescriptProject: ProjectContext = {
  Home: "/p/replicas",
  Layout: ["README.md", "docs/", "mastra/", "mise.toml", "scripts/"],
  Unlisted: ["mastra"],
  MiseTasks: ["smoke"],
  OpenTasks: [],
  Runners: [{ Kind: "vitest", Dir: "mastra", Command: "aube exec vitest run", Detail: "" }],
  TestFiles: [
    "mastra/test/workflows/get_recent_turns/classify_turns.test.ts",
    "mastra/test/capability/plan_tasks/plan_tasks.test.ts",
    "mastra/test/transcript/turn_source.test.ts",
    "mastra/test/runtime/gather/system_prompt.test.ts",
    "mastra/test/runtime/gather/project_context.test.ts",
  ],
};

/** A Python project with pytest at its root and no mise tasks. */
const pythonProject: ProjectContext = {
  Home: "/p/billing",
  Layout: ["billing/", "pyproject.toml", "tests/"],
  Unlisted: ["billing", "tests"],
  MiseTasks: [],
  OpenTasks: [],
  Runners: [{ Kind: "pytest", Dir: "", Command: "pytest", Detail: "" }],
  TestFiles: ["tests/test_export.py", "tests/test_invoice_total.py"],
};

/** A shell-and-mise project like homelab: area tasks under `test:` and one task that runs every script. */
const miseProject: ProjectContext = {
  Home: "/p/homelab",
  Layout: ["compose/", "mise-tasks/", "mise.toml", "tests/"],
  Unlisted: ["compose", "mise-tasks", "tests"],
  MiseTasks: ["ci", "lint", "test", "test:jellyfin-memory", "test:media-routes"],
  OpenTasks: [],
  Runners: [],
  TestFiles: ["tests/qb-config.test.sh", "tests/status-report.test.sh"],
};

/** A project whose only Go module is nested, with a mise task for the same test, as homelab's desired-state is. */
const nestedModuleProject: ProjectContext = {
  Home: "/p/homelab",
  Layout: ["mise-tasks/", "mise.toml", "services/", "tests/"],
  Unlisted: ["mise-tasks", "services", "tests"],
  MiseTasks: ["ci", "test", "test:jellyfin-memory", "test:media-routes"],
  OpenTasks: [],
  Runners: [{ Kind: "go", Dir: "services/desired-state", Command: "go test", Detail: "homelab/desired-state" }],
  TestFiles: ["services/desired-state/internal/declaration/jellyfin_memory_test.go", "tests/qb-config.test.sh"],
};

// ---- a scripted machine: answers from `world`, records every process it was asked to run
interface FakeWorld {
  homeDirectory?: string;
  /** Results by the command line. An unlisted command fails with exit 127. */
  commands?: Readonly<Record<string, ProcessResult>>;
  files?: Readonly<Record<string, string>>;
  directories?: readonly string[];
}
const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
class FakeHostMachine implements Machine {
  readonly runs: { commandLine: string; env: Readonly<Record<string, string>> }[] = [];
  readonly homeDirectory: string;
  private readonly files: Map<string, string>;
  constructor(private readonly world: FakeWorld = {}) {
    this.files = new Map(Object.entries(world.files ?? {}));
    this.homeDirectory = world.homeDirectory ?? "/home/zach";
  }
  async run(command: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<ProcessResult> {
    const commandLine = [command, ...args].join(" ");
    this.runs.push({ commandLine, env });
    return this.world.commands?.[commandLine] ?? { code: 127, stdout: "", stderr: `no fake for ${commandLine}` };
  }
  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  /** A directory is one listed in `directories` or one that holds a listed file or directory. */
  async isDirectory(path: string): Promise<boolean> {
    return (await this.listDirectory(path)).length > 0 || (this.world.directories?.includes(path) ?? false);
  }
  async isFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async listDirectory(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const paths = [...this.files.keys(), ...(this.world.directories ?? [])];
    const names = paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0] as string);
    return [...new Set(names)].sort();
  }
}

// ---- targeting (ported from Mastra's targeting.test.ts)
{
  const reply = (change: Partial<ObjectiveReply>): ObjectiveReply => ({
    title: "Rank local models last when TypeSafe answers",
    outcome: "Local models rank after TypeSafe when TypeSafe answers.",
    acceptance: ["ollama/nimble is ranked after every API model"],
    draft: false,
    draft_reason: "",
    proof: "",
    regression: "",
    regression_size: "small",
    rationale: "The named test fails while nimble ranks first.",
    ...change,
  });

  const goScene: Scene = {
    goal: "select_model ranks ollama/nimble last when TypeSafe answers",
    context: goProject,
    changedFiles: [],
  };
  const goReply = reply({
    proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast",
    regression: "go_test: ./internal/capability",
    regression_size: "medium",
  });

  const typescriptScene: Scene = {
    goal: "get_recent_turns marks a typed slash command like /compact as system, not user",
    context: typescriptProject,
    changedFiles: [],
  };
  const CLASSIFY_TEST = "test/workflows/get_recent_turns/classify_turns.test.ts";
  const typescriptReply = reply({
    proof: `run: cd mastra && aube exec vitest run ${CLASSIFY_TEST}`,
    regression:
      "run: cd mastra && aube exec vitest run test/workflows/get_recent_turns test/transcript/turn_source.test.ts",
  });

  describe("objectiveProblems in a Go project", () => {
    it("accepts a proof that runs one named test and a regression that runs its package", () => {
      expect(objectiveProblems(goReply, goScene)).toEqual([]);
    });

    it.each([
      ["the whole-suite preset", "ci:"],
      ["every package", "go_test: ./... name=TestRankedModelsPutLocalLast"],
      ["the project's gate", "run: mise run ci"],
      ["the project's tests", "run: mise run test"],
    ])("refuses a proof that runs %s, instead of resizing it", (_name, proof) => {
      expect(objectiveProblems({ ...goReply, proof }, goScene).join(";")).toMatch(/proof .* runs a whole suite/);
    });

    it("refuses a package with no test file, naming the ones that have tests", () => {
      const problems = objectiveProblems({ ...goReply, proof: "go_test: ./internal/ids name=TestX" }, goScene);
      expect(problems.join(";")).toMatch(/proof runs tests at "internal\/ids", which holds no test file/);
    });

    it("refuses the whole suite as a regression for a goal in one package, and says what to run", () => {
      const problems = objectiveProblems(
        { ...goReply, regression: "run: go test ./...", regression_size: "large" },
        goScene,
      );
      expect(problems.join(";")).toMatch(/regression runs the whole suite.*internal\/capability/);
    });

    it("accepts the whole suite as the regression of a cross-cutting goal when it is size large", () => {
      const crossing: Scene = { ...goScene, changedFiles: ["cmd/a.go", "internal/b.go", "docs/c.md"] };
      const whole = { ...goReply, regression: "run: go test ./...", regression_size: "large" };
      expect(objectiveProblems(whole, crossing)).toEqual([]);
      expect(objectiveProblems({ ...whole, regression_size: "medium" }, crossing).join(";")).toMatch(
        /must be size "large"/,
      );
    });

    it("refuses size large for a regression that is not the whole suite", () => {
      expect(objectiveProblems({ ...goReply, regression_size: "large" }, goScene).join(";")).toMatch(
        /"large" is for the whole suite/,
      );
    });

    it("refuses a size written inside a check, because the size field sets it", () => {
      const sized = { ...goReply, proof: `${goReply.proof} size=small` };
      expect(objectiveProblems(sized, goScene).join(";")).toMatch(/proof must not carry size=/);
    });
  });

  describe("objectiveProblems in a TypeScript project", () => {
    it("accepts a vitest file run from the directory that holds the config", () => {
      expect(objectiveProblems(typescriptReply, typescriptScene)).toEqual([]);
    });

    it("refuses vitest run with no file", () => {
      const proof = "run: cd mastra && aube exec vitest run";
      expect(objectiveProblems({ ...typescriptReply, proof }, typescriptScene).join(";")).toMatch(/runs a whole suite/);
    });

    it("refuses a test file the project does not have", () => {
      const proof = "run: cd mastra && aube exec vitest run test/capability/nope.test.ts";
      expect(objectiveProblems({ ...typescriptReply, proof }, typescriptScene).join(";")).toMatch(
        /runs tests at "mastra\/test\/capability\/nope.test.ts", which holds no test file/,
      );
    });

    it("cannot disprove a test file when the list of test files was cut short", () => {
      const cut: Scene = { ...typescriptScene, context: { ...typescriptProject, TestFilesTruncated: true } };
      const proof = "run: cd mastra && aube exec vitest run test/capability/nope.test.ts";
      expect(objectiveProblems({ ...typescriptReply, proof }, cut)).toEqual([]);
    });
  });

  describe("objectiveProblems in a Python project", () => {
    const scene: Scene = { goal: "the invoice total is wrong in the export", context: pythonProject, changedFiles: [] };
    const spec = reply({
      proof: "py_test: tests/test_invoice_total.py name=total",
      regression: "py_test: tests/test_export.py",
    });

    it("accepts a pytest file with a name filter", () => {
      expect(objectiveProblems(spec, scene)).toEqual([]);
    });

    it("refuses bare pytest as a proof and a test file that does not exist", () => {
      expect(objectiveProblems({ ...spec, proof: "run: pytest" }, scene).join(";")).toMatch(/runs a whole suite/);
      expect(objectiveProblems({ ...spec, proof: "py_test: tests/test_nope.py" }, scene).join(";")).toMatch(
        /holds no test file/,
      );
    });
  });

  describe("objectiveProblems in a mise project", () => {
    const scene: Scene = { goal: "Limit Jellyfin memory to stop OOM", context: miseProject, changedFiles: [] };
    const spec = reply({
      proof: "run: mise run test:jellyfin-memory",
      regression: "run: mise run test",
      regression_size: "large",
    });

    it("accepts the whole suite as the regression when nothing narrower covers the work", () => {
      expect(objectiveProblems(spec, scene)).toEqual([]);
    });

    it("refuses the whole suite when a narrower test sits near the goal", () => {
      const near = { ...miseProject, TestFiles: [...miseProject.TestFiles!, "tests/jellyfin-limits.test.sh"] };
      const problems = objectiveProblems(spec, { ...scene, context: near });
      expect(problems.join(";")).toMatch(/regression runs the whole suite.*tests\/jellyfin-limits.test.sh/);
    });

    it("refuses a mise task the project does not define", () => {
      expect(objectiveProblems({ ...spec, proof: "run: mise run test:jellyfin-cpu" }, scene).join(";")).toMatch(
        /mise task "test:jellyfin-cpu"/,
      );
    });
  });

  describe("objectiveProblems for a draft", () => {
    it("accepts a draft with a reason and no checks", () => {
      const draft = reply({ draft: true, draft_reason: "no test covers page copy" });
      expect(objectiveProblems(draft, { ...goScene, goal: "write the 2027 registration page copy" })).toEqual([]);
    });

    it("asks for the reason and refuses a bad title", () => {
      const problems = objectiveProblems(reply({ draft: true, title: "Writing copy" }), goScene);
      expect(problems.join(";")).toMatch(/draft_reason is empty/);
      expect(problems.join(";")).toMatch(/title must be imperative/);
    });

    it("refuses a draft when a test file of the goal's area is listed, naming it", () => {
      const draft = reply({ draft: true, draft_reason: "no test covers it" });
      expect(objectiveProblems(draft, typescriptScene).join(";")).toMatch(
        /draft is refused: mastra\/test\/workflows\/get_recent_turns\/classify_turns.test.ts is the test of this goal's area/,
      );
    });

    it("accepts a draft when the test files near the goal share only a word with it", () => {
      const weak: Scene = { ...typescriptScene, goal: "write the page copy for the context screen" };
      expect(objectiveProblems(reply({ draft: true, draft_reason: "no test covers page copy" }), weak)).toEqual([]);
    });

    it("asks for a proof and a regression when it is not a draft", () => {
      expect(objectiveProblems(reply({}), goScene).join(";")).toMatch(/proof must be/);
    });

    it("asks for an outcome and acceptance", () => {
      const problems = objectiveProblems({ ...goReply, outcome: " ", acceptance: [] }, goScene);
      expect(problems).toEqual(
        expect.arrayContaining(["outcome is empty", "acceptance is empty: list what must be true"]),
      );
    });
  });

  describe("sizedChecks", () => {
    it("gives the proof its preset's time class and the regression the size the writer chose", () => {
      expect(sizedChecks(goReply)).toEqual({
        proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast size=small",
        regression: "go_test: ./internal/capability size=medium",
      });
    });

    it("never gives a check less time than its preset needs", () => {
      const build = reply({ proof: "build:", regression: "rs_test: crates/a", regression_size: "small" });
      expect(sizedChecks(build)).toEqual({ proof: "build: size=medium", regression: "rs_test: crates/a size=medium" });
    });
  });

  describe("targetingOf", () => {
    it("names the runner, the test the proof runs and the package the regression covers", () => {
      expect(targetingOf(goReply, goScene)).toEqual({
        runner: "go",
        changed_paths: [],
        test_files_considered: [
          "delegate_select_model_test.go",
          "internal/capabilities/select_model_test.go",
          "internal/capability/ranked_models_test.go",
          "internal/capability/answer_subject_test.go",
          "internal/model/run_test.go",
        ],
        chosen_test: "internal/capability/ranked_models_test.go",
        chosen_scope: "internal/capability",
      });
    });

    it("follows a cd to the vitest file and the paths the regression runs", () => {
      const targeting = targetingOf(typescriptReply, typescriptScene);
      expect(targeting.runner).toBe("vitest");
      expect(targeting.chosen_test).toBe(`mastra/${CLASSIFY_TEST}`);
      expect(targeting.chosen_scope).toBe(
        "mastra/test/workflows/get_recent_turns mastra/test/transcript/turn_source.test.ts",
      );
    });

    it("calls the scope of a project-wide regression the whole suite and of a mise task its name", () => {
      const miseScene: Scene = { goal: "Limit Jellyfin memory", context: miseProject, changedFiles: ["compose/a.yml"] };
      const wide = reply({ proof: "run: mise run test:jellyfin-memory", regression: "run: mise run test" });
      expect(targetingOf(wide, miseScene)).toMatchObject({
        runner: "mise",
        changed_paths: ["compose/a.yml"],
        chosen_test: "",
        chosen_scope: "whole suite",
      });
      expect(targetingOf({ ...wide, regression: "run: mise run test:media-routes" }, miseScene).chosen_scope).toBe(
        "mise run test:media-routes",
      );
    });
  });

  describe("objectiveProblems where the runner's config is below the project root", () => {
    const scene: Scene = { goal: "Limit Jellyfin memory to stop OOM", context: nestedModuleProject, changedFiles: [] };
    const spec = reply({
      proof: "run: cd services/desired-state && go test ./internal/declaration -run TestJellyfinMemory",
      regression: "run: mise run test:media-routes",
    });

    it("accepts a test run from the Go module's directory, and the mise task for it", () => {
      expect(objectiveProblems(spec, scene)).toEqual([]);
      expect(objectiveProblems({ ...spec, proof: "run: mise run test:jellyfin-memory" }, scene)).toEqual([]);
    });

    it("refuses go_test at the project root for a package in a nested module, and says where to run it", () => {
      const proof = "go_test: ./services/desired-state/internal/declaration name=TestJellyfinMemory";
      expect(objectiveProblems({ ...spec, proof }, scene).join(";")).toMatch(
        /proof runs go tests of "services\/desired-state\/internal\/declaration" from the project root, but their go config is in services\/desired-state: write "run: cd services\/desired-state && go test/,
      );
    });

    it("refuses a cd to a directory other than the one with the config, and a cd where none is needed", () => {
      const wrongDirectory = {
        ...typescriptReply,
        proof: `run: cd mastra/test && aube exec vitest run ${CLASSIFY_TEST}`,
      };
      expect(objectiveProblems(wrongDirectory, typescriptScene).join(";")).toMatch(/config is in mastra/);
      const needlessCd = { ...goReply, proof: "run: cd internal && go test ./capability -run TestX" };
      expect(objectiveProblems(needlessCd, goScene).join(";")).toMatch(/run it from the project root, without cd/);
    });
  });
}

// ---- test_index
{
  const SLASH_GOAL = "get_recent_turns marks a typed slash command like /compact as system, not user";

  describe("tokensOf", () => {
    it("splits words, identifiers and paths, and drops filler and file-type words", () => {
      const tokens = tokensOf(SLASH_GOAL);
      expect(tokens).toEqual(expect.arrayContaining(["get", "recent", "turns", "compact", "slash", "system"]));
      expect(tokens).not.toContain("as");
      expect(tokens).not.toContain("not");
      expect(tokensOf("mastra/test/runtime/gather/project_context.test.ts")).toEqual([
        "mastra",
        "runtime",
        "gather",
        "project",
        "context",
      ]);
    });

    it("splits camelCase and lists each token once", () => {
      expect(tokensOf("SelectModel ranksOllama select")).toEqual(["select", "model", "ranks", "ollama"]);
    });
  });

  describe("testIndexNearGoal", () => {
    it("puts the test files that share the most words with the goal first and leaves out unrelated ones", () => {
      expect(testIndexNearGoal(typescriptProject.TestFiles!, SLASH_GOAL, [])).toEqual([
        "mastra/test/workflows/get_recent_turns/classify_turns.test.ts",
        "mastra/test/transcript/turn_source.test.ts",
        "mastra/test/runtime/gather/system_prompt.test.ts",
      ]);
    });

    it("prefers the tests beside a changed file", () => {
      const near = testIndexNearGoal(goProject.TestFiles!, "make it faster", ["internal/model/run.go"]);
      expect(near[0]).toBe("internal/model/run_test.go");
    });

    it("returns nothing when no test shares a word with the goal", () => {
      expect(testIndexNearGoal(typescriptProject.TestFiles!, "write the 2027 registration page copy", [])).toEqual([]);
    });

    it("is capped", () => {
      const many = Array.from({ length: NEAR_GOAL_LIMIT + 10 }, (_, i) => `pkg/billing_${i}_test.go`);
      expect(testIndexNearGoal(many, "billing", [])).toHaveLength(NEAR_GOAL_LIMIT);
    });
  });

  describe("rankByRelevance", () => {
    it("keeps the listed order among equally relevant paths", () => {
      expect(rankByRelevance(["b_test.go", "a_test.go", "billing_test.go"], "billing")).toEqual([
        "billing_test.go",
        "b_test.go",
        "a_test.go",
      ]);
    });
  });

  describe("plural and past-tense words", () => {
    it("count as the same word", () => {
      expect(testIndexNearGoal(["pkg/ranked_models_test.go", "pkg/other_test.go"], "ranks the model", [])).toEqual([
        "pkg/ranked_models_test.go",
      ]);
    });
  });
}

// ---- test_invocation
{
  describe("testInvocations", () => {
    it("reads a preset's subject as the packages or files it runs", () => {
      expect(testInvocations("go_test: ./internal/capability name=TestX")).toEqual([
        { runner: "go", dir: "", targets: ["./internal/capability"] },
      ]);
    });

    it("follows cd in a shell command and drops flags and their values", () => {
      expect(testInvocations("run: cd mastra && aube exec vitest run test/a.test.ts -t slow --reporter dot")).toEqual([
        { runner: "vitest", dir: "mastra", targets: ["test/a.test.ts"] },
      ]);
    });

    it("reads mise, make, npm and pytest invocations", () => {
      expect(testInvocations("run: mise run test:jellyfin-memory")).toEqual([
        { runner: "mise", dir: "", targets: ["test:jellyfin-memory"] },
      ]);
      expect(testInvocations("run: python -m pytest tests/test_x.py -k total")).toEqual([
        { runner: "pytest", dir: "", targets: ["tests/test_x.py"] },
      ]);
      expect(testInvocations("run: npm test -- src/a.test.ts")).toEqual([
        { runner: "npm", dir: "", targets: ["src/a.test.ts"] },
      ]);
      expect(testInvocations("run: make test")).toEqual([{ runner: "make", dir: "", targets: ["test"] }]);
    });

    it("finds nothing in a check that is not a test run", () => {
      expect(testInvocations("file_exists: docs/automations.md")).toEqual([]);
      expect(testInvocations("run: bash tests/qb-config.test.sh")).toEqual([]);
    });
  });

  describe("namesWholeSuite", () => {
    it.each([
      "ci:",
      "run: mise run ci",
      "run: mise run test",
      "go_test: ./... name=TestX",
      "run: go test ./...",
      "run: cd mastra && aube exec vitest run",
      "run: aube run test",
      "run: npm test",
      "run: pytest",
      "run: pytest -q",
      "py_test: .",
      "run: make test",
      "run: cargo test",
      "rs_test:",
    ])("%j runs the whole suite", (check) => {
      expect(namesWholeSuite(check)).toBe(true);
    });

    it.each([
      "go_test: ./internal/capability name=TestX",
      "run: go test ./internal/capability -run TestX",
      "run: mise run test:jellyfin-memory",
      "run: cd mastra && aube exec vitest run test/a.test.ts",
      "run: npm test -- src/a.test.ts",
      "run: pytest tests/test_x.py -k total",
      "py_test: tests/test_x.py name=total",
      "file_exists: docs/automations.md",
      "run: bash tests/qb-config.test.sh",
      "grep: compose/media.yml pattern=memory",
      "http_ok: http://jellyfin.lan/health",
    ])("%j runs something narrower", (check) => {
      expect(namesWholeSuite(check)).toBe(false);
    });
  });

  describe("testTargets", () => {
    it("joins each target to the directory the command ran in and drops globs and ids", () => {
      expect(testTargets("run: cd mastra && aube exec vitest run test/a.test.ts test/dir")).toEqual([
        "mastra/test/a.test.ts",
        "mastra/test/dir",
      ]);
      expect(testTargets("go_test: ./internal/capability/... name=TestX")).toEqual(["internal/capability"]);
      expect(testTargets("run: pytest tests/test_x.py::test_y")).toEqual(["tests/test_x.py"]);
    });

    it("has no targets for a suite, a mise task or a check that runs no tests", () => {
      expect(testTargets("run: go test ./...")).toEqual([]);
      expect(testTargets("run: mise run test:x")).toEqual([]);
      expect(testTargets("grep: a.yml pattern=x")).toEqual([]);
    });
  });

  describe("crossCuttingReason", () => {
    it("says so when the changed files span three top-level areas", () => {
      expect(crossCuttingReason("tidy", ["cmd/a.go", "internal/b.go", "docs/c.md"])).toMatch(/cmd, internal, docs/);
      expect(crossCuttingReason("tidy", ["cmd/a.go", "cmd/b.go", "docs/c.md"])).toBeUndefined();
    });

    it("says so when the goal is about config, the build or CI", () => {
      expect(crossCuttingReason("Fix the CI pipeline", [])).toMatch(/ci/i);
      expect(crossCuttingReason("Limit Jellyfin memory to stop OOM", [])).toBeUndefined();
    });
  });
}

// ---- checked paths and project context (ported from plan_tasks/project_context.test.ts)
{
  const HOME = "/h/homelab";

  const context: ProjectContext = {
    Home: HOME,
    Layout: [
      "README.md",
      "compose/",
      "compose/media.yml",
      "docs/",
      "docs/automations.md",
      "homelab.cue",
      "mise.toml",
      "scripts/",
      "scripts/start-all.sh",
      "services/",
    ],
    Unlisted: ["services"],
    MiseTasks: ["ci", "lint", "state-check", "test"],
    OpenTasks: [{ id: "at-3qzne0", title: "Make wt done work for the homelab repo" }],
  };

  const spec: TaskSpec = {
    title: "Raise the Jellyfin memory limit",
    proof: "grep: compose/media.yml pattern=memory",
    regression: "run: mise run test",
    size: "large",
    rationale: "The compose file sets a memory limit.",
  };

  const problems = (change: Partial<TaskSpec>, within: ProjectContext = context): string[] =>
    taskSpecProblems({ ...spec, ...change }, within);

  describe("pathsNamedBy", () => {
    it.each([
      ["grep: homelab.cue pattern=jellyfin", ["homelab.cue"]],
      ["file_exists: docs/automations.md", ["docs/automations.md"]],
      ["run: bash scripts/start-all.sh --dry-run", ["scripts/start-all.sh"]],
      [`run: cat ${HOME}/docs/automations.md`, ["docs/automations.md"]],
      ["run: shellcheck ./scripts/*.sh", ["scripts"]],
      ["go_test: ./services/desired-state name=TestX", ["services/desired-state"]],
    ])("finds the project paths of %j", (check, paths) => {
      expect(pathsNamedBy(check, HOME)).toEqual(paths);
    });

    it.each([
      "http_ok: http://jellyfin.lan.zachandaj.com/health",
      "run: curl -s tv.lan.zachandaj.com/api",
      "run: docker inspect -f '{{.State.OOMKilled}}' jellyfin",
      "run: docker image inspect linuxserver/jellyfin:latest",
      "run: test -f /etc/hosts",
      "run: ls ~/Library/LaunchAgents",
      "run: mise run state-check",
      "run: test \"$(dig +short tv.lan)\" = 10.0.0.5",
      "lint:",
    ])("names no project path in %j", (check) => {
      expect(pathsNamedBy(check, HOME)).toEqual([]);
    });
  });

  describe("layoutAccepts", () => {
    it.each(["homelab.cue", "docs/automations.md", "docs", "scripts/start-all.sh"])("accepts the listed %s", (path) => {
      expect(layoutAccepts(path, context)).toBe(true);
    });

    it.each(["docs/missing.md", "jellyfin.cue", "compose/media.yaml", "README.md/x"])("refuses the absent %s", (path) => {
      expect(layoutAccepts(path, context)).toBe(false);
    });

    it("cannot disprove a path below a directory whose contents are not all listed", () => {
      expect(layoutAccepts("services/desired-state/main.go", context)).toBe(true);
    });

    it("cannot disprove a top-level path when the top level was cut short", () => {
      expect(layoutAccepts("zzz/file.sh", { ...context, Unlisted: [""] })).toBe(true);
    });
  });

  describe("grounded task validation", () => {
    it("accepts a proof that names listed files and the project's own test task", () => {
      expect(problems({})).toEqual([]);
    });

    it("refuses a proof path that is not in the listing, with the reason", () => {
      const refused = problems({ proof: "run: grep -q memory compose/jellyfin.yml" });
      expect(refused).toEqual([
        "proof names \"compose/jellyfin.yml\", which is not in the project's file listing: use a path from the listing",
      ]);
    });

    it("refuses a regression path that is not in the listing", () => {
      expect(problems({ regression: "run: bash tests/missing.test.sh" }).join(";")).toMatch(
        /regression names "tests\/missing.test.sh"/,
      );
    });

    it("refuses a mise task the project does not define, naming the ones it does", () => {
      expect(problems({ proof: "run: mise run verify-jellyfin" })).toEqual([
        "proof runs mise task \"verify-jellyfin\", which the project does not define: its tasks are ci, lint, state-check, test",
      ]);
    });

    it("accepts a mise task the project defines", () => {
      expect(problems({ proof: "run: mise run state-check" })).toEqual([]);
    });

    it("refuses the bare lint preset as a regression, whatever the project", () => {
      expect(problems({ regression: "lint:" }).join(";")).toMatch(/bare lint preset/);
      expect(taskSpecProblems({ ...spec, regression: "lint:" }).join(";")).toMatch(/bare lint preset/);
    });

    it("does not hold the regression to the project's mise gate: the work decides what it must run", () => {
      expect(problems({ regression: "run: mise run ci" })).toEqual([]);
      expect(problems({ regression: "http_ok: http://jellyfin.lan/health" })).toEqual([]);
      expect(problems({ regression: "run: bash scripts/start-all.sh --check" }, { ...context, MiseTasks: [] })).toEqual(
        [],
      );
    });
  });

  describe("contextLines", () => {
    it("shows the files, the tasks and the open tasks, and prescribes no regression command", () => {
      const text = contextLines(context).join("\n");
      expect(text).toContain("docs/automations.md");
      expect(text).toContain("services/ …");
      expect(text).toContain("Mise tasks: ci, lint, state-check, test");
      expect(text).not.toContain("Regression commands");
      expect(text).toContain("- at-3qzne0 Make wt done work for the homelab repo");
    });
  });

  describe("duplicateOf", () => {
    const open = context.OpenTasks;

    it.each([
      "Make wt done work for the homelab repo.",
      "make WT done work for the homelab repo",
      "Please make wt done work for the homelab repo today",
    ])("finds the open task a goal restates: %j", (outcome) => {
      expect(duplicateOf(outcome, open)).toBe("at-3qzne0");
    });

    it("finds a goal that is a part of an open task's title", () => {
      expect(duplicateOf("wt done work", [{ id: "at-1", title: "Make wt done work for the homelab repo" }])).toBe("at-1");
    });

    it("does not match a different goal or a title too short to mean anything", () => {
      expect(duplicateOf("Stop Jellyfin from running out of memory.", open)).toBeUndefined();
      expect(duplicateOf("Fix the DNS record", [{ id: "at-2", title: "Fix" }])).toBeUndefined();
    });
  });
}

// ---- task_spec (ported; the plan-only prerequisites tests are left behind with plan_tasks)
{
  const GOOD = {
    title: "Add a CSV export of invoice data",
    proof: "run: test -s out/invoices.csv",
    regression: "go_test: ./internal/invoice",
    size: "small",
    rationale: "The export file exists and has rows.",
  };

  const problemsWith = (change: Partial<typeof GOOD>): string[] => taskSpecProblems({ ...GOOD, ...change });

  describe("taskSpecProblems", () => {
    it("accepts a spec atask will take", () => {
      expect(taskSpecProblems(GOOD)).toEqual([]);
    });

    it.each([
      ["", /title is empty/],
      ["x".repeat(81), /81 characters; keep it to 80/],
      ["Fixing the DNS record", /must be imperative/],
      ["Fixed the DNS record", /must be imperative/],
      ["The DNS record is wrong", /must be imperative/],
      ["-rf the record", /must start with a verb/],
      ["Fix it\nand more", /one line/],
    ])("refuses the title %j", (title, reason) => {
      expect(problemsWith({ title }).join(";")).toMatch(reason);
    });

    it.each(["Bring the record back", "Embed the logo", "Speed up the scan", "Add a field"])(
      "accepts the imperative %j",
      (title) => {
        expect(problemsWith({ title })).toEqual([]);
      },
    );

    it.each([
      ["no colon", "go test ./..."],
      ["an unknown preset", "pytest: tests"],
      ["an empty command", "run:"],
      ["a command that cannot fail", "run: echo done"],
      ["true", "run: true"],
      ["a subject-less file check", "file_exists:"],
      ["a go_test with no name filter", "go_test: ./internal/invoice"],
      ["a lint with a subject", "lint: ."],
      ["a ci with a subject", "ci: ./..."],
    ])("refuses a proof with %s", (_name, proof) => {
      expect(problemsWith({ proof })).not.toEqual([]);
    });

    it("accepts a go_test proof that names its test", () => {
      expect(problemsWith({ proof: "go_test: ./internal/invoice name=TestPDF" })).toEqual([]);
    });

    it("accepts a go_test regression without a name filter, because its size sets the time class", () => {
      expect(problemsWith({ regression: "go_test: ./..." })).toEqual([]);
    });

    it("tells the model what to write instead of a subject on lint", () => {
      expect(problemsWith({ regression: "lint: ." }).join(";")).toMatch(/write "lint:" alone, not "lint: \."/);
    });

    it("accepts presets that need no subject", () => {
      expect(problemsWith({ regression: "ci:" })).toEqual([]);
    });

    it.each(["lint:", "  lint:  ", ""])("refuses the bare lint preset or nothing as a regression: %j", (regression) => {
      expect(problemsWith({ regression }).join(";")).toMatch(/regression "lint:" is the bare lint preset|regression/);
      expect(problemsWith({ regression })).not.toEqual([]);
    });

    it("allows shell syntax in a run command, because atask runs it with sh -c", () => {
      expect(problemsWith({ proof: "run: dig +short tv.lan | grep -q 10.0.0.5" })).toEqual([]);
    });

    it("refuses a proof identical to the regression, ignoring spacing", () => {
      expect(problemsWith({ proof: "ci:", regression: "ci:  " }).join(";")).toMatch(/must differ/);
    });

    it("refuses a size outside small, medium, large and an empty rationale", () => {
      expect(problemsWith({ size: "tiny" }).join(";")).toMatch(/small, medium, large/);
      expect(problemsWith({ rationale: " " }).join(";")).toMatch(/rationale is empty/);
    });
  });
}

// ---- the checkout gatherers (ported from runtime/gather/project_context.test.ts)
{
  const HOME = "/p/homelab";
  const LIST_OPEN = "atask --project proj-1 list open";

  const MISE_TOML = `[tools]
  go = "latest"

  [tasks.lint]
  description = "check"
  run = "dprint check"

  [tasks."state-check"]
  run = "x"

  [tasks.test] # all tests
  run = ["a"]

  [tasks.test.env]
  A = "1"
  `;

  const world = new FakeHostMachine({
    files: {
      [`${HOME}/README.md`]: "# homelab",
      [`${HOME}/homelab.cue`]: "",
      [`${HOME}/mise.toml`]: MISE_TOML,
      [`${HOME}/.env`]: "SECRET=1",
      [`${HOME}/docs/automations.md`]: "",
      [`${HOME}/docs/network.md`]: "",
      [`${HOME}/scripts/start-all.sh`]: "",
      [`${HOME}/services/a/main.go`]: "",
      [`${HOME}/node_modules/x/index.js`]: "",
      [`${HOME}/mise-tasks/test/unit.sh`]: "",
      [`${HOME}/mise-tasks/deploy`]: "",
    },
    directories: [
      `${HOME}/docs`,
      `${HOME}/scripts`,
      `${HOME}/services`,
      `${HOME}/services/a`,
      `${HOME}/node_modules`,
      `${HOME}/mise-tasks`,
      `${HOME}/mise-tasks/test`,
    ],
    commands: {
      [LIST_OPEN]: ok(JSON.stringify({
        ok: true,
        result: { tasks: [{ id: "at-1", title: "Make wt done work", status: "interrupted" }] },
      })),
    },
  });

  describe("projectLayout", () => {
    it("lists the top level with directories marked, hidden files and node_modules left out", async () => {
      const { Layout } = await projectLayout(HOME, world);
      expect(Layout.filter((path) => !path.includes("/") || path.endsWith("/") && path.split("/").length === 2))
        .toEqual(["README.md", "docs/", "homelab.cue", "mise-tasks/", "mise.toml", "scripts/", "services/"]);
    });

    it("opens docs and scripts one level and leaves other directories unexpanded", async () => {
      const { Layout, Unlisted } = await projectLayout(HOME, world);
      expect(Layout).toContain("docs/automations.md");
      expect(Layout).toContain("scripts/start-all.sh");
      expect(Layout).not.toContain("services/a/");
      expect(Unlisted.sort()).toEqual(["mise-tasks", "services"]);
    });

    it("puts each expanded directory's entries right after it", async () => {
      const { Layout } = await projectLayout(HOME, world);
      expect(Layout.slice(Layout.indexOf("docs/"), Layout.indexOf("docs/") + 3)).toEqual([
        "docs/",
        "docs/automations.md",
        "docs/network.md",
      ]);
    });

    it("cuts the top level and an expanded directory short and says so", async () => {
      const files = Object.fromEntries([
        ...Array.from({ length: TOP_LEVEL_LIMIT + 5 }, (_, i) => [`${HOME}/f${String(i).padStart(3, "0")}.txt`, ""]),
        ...Array.from({ length: EXPANDED_LIMIT + 3 }, (_, i) => [`${HOME}/zdocs/d${String(i).padStart(3, "0")}.md`, ""]),
      ]);
      const machine = new FakeHostMachine({ files, directories: [`${HOME}/docs`] });
      const { Layout, Unlisted } = await projectLayout(HOME, machine);
      expect(Layout).toHaveLength(TOP_LEVEL_LIMIT);
      expect(Unlisted).toContain("");
    });

    it("marks an expanded directory partial when it holds more than the cap", async () => {
      const files = Object.fromEntries(
        Array.from({ length: EXPANDED_LIMIT + 3 }, (_, i) => [`${HOME}/docs/d${String(i).padStart(3, "0")}.md`, ""]),
      );
      const machine = new FakeHostMachine({ files, directories: [`${HOME}/docs`] });
      const { Layout, Unlisted } = await projectLayout(HOME, machine);
      expect(Layout).toHaveLength(1 + EXPANDED_LIMIT);
      expect(Unlisted).toEqual(["docs"]);
    });

    it("lists nothing, and cannot disprove any path, for a home that does not exist or is empty", async () => {
      expect(await projectLayout("/nowhere", new FakeHostMachine())).toEqual({ Layout: [], Unlisted: [""] });
    });
  });

  describe("miseTasks", () => {
    it("reads the [tasks.NAME] tables, quoted names included, and the mise-tasks files", async () => {
      expect(await miseTasks(HOME, world)).toEqual(["lint", "state-check", "test", "deploy", "test:unit"]);
    });

    it("is empty when there is no mise.toml", async () => {
      expect(await miseTasks("/nowhere", new FakeHostMachine())).toEqual([]);
    });
  });

  describe("openTasks", () => {
    it("reads id and title of the project's unfinished tasks through atask", async () => {
      expect(await openTasks("proj-1", world)).toEqual([{ id: "at-1", title: "Make wt done work" }]);
      expect(world.runs.find((run) => run.commandLine === LIST_OPEN)!.env).toEqual({ ATASK_OUTPUT: "json" });
    });

    it("names the project and what atask said when it fails", async () => {
      const machine = new FakeHostMachine({
        commands: { [LIST_OPEN]: { code: 1, stdout: "", stderr: "no such project" } },
      });
      await expect(openTasks("proj-1", machine)).rejects.toThrow(
        /`atask --project proj-1 list open` failed \(exit 1\): no such project/,
      );
    });

    it("fails when atask prints something else", async () => {
      const machine = new FakeHostMachine({ commands: { [LIST_OPEN]: ok("[]") } });
      await expect(openTasks("proj-1", machine)).rejects.toThrow(/did not print the tasks/);
    });
  });

  describe("projectContext", () => {
    it("gathers the home, layout, mise tasks and open tasks of a project", async () => {
      const context = await projectContext("proj-1", HOME, world);
      expect(context.Home).toBe(HOME);
      expect(context.Layout).toContain("homelab.cue");
      expect(context.MiseTasks).toContain("state-check");
      expect(context.OpenTasks).toEqual([{ id: "at-1", title: "Make wt done work" }]);
    });
  });

  const listingOf = (home: string): string => `git -C ${home} ls-files -- ${TEST_FILE_PATHSPECS.join(" ")}`;
  const gitListing = (home: string, paths: readonly string[]) => ({ [listingOf(home)]: ok(`${paths.join("\n")}\n`) });

  describe("listTestFiles", () => {
    it("lists the tracked test files, sorted, without the helpers and fixtures beside them", async () => {
      const machine = new FakeHostMachine({
        commands: gitListing(HOME, [
          "mastra/test/support/fakes.ts",
          "mastra/test/runtime/b.test.ts",
          "internal/model/run_test.go",
          "mastra/test/capability/a.test.ts",
          "tests/fixtures/data.json",
          "tests/qb-config.test.sh",
          "tests/notes.md",
          "tests/test_export.py",
        ]),
      });
      expect(await listTestFiles(HOME, "", machine)).toEqual({
        files: [
          "internal/model/run_test.go",
          "mastra/test/capability/a.test.ts",
          "mastra/test/runtime/b.test.ts",
          "tests/qb-config.test.sh",
          "tests/test_export.py",
        ],
        truncated: false,
      });
    });

    it("keeps the files most relevant to the words when there are more than the cap, and says so", async () => {
      const many = Array.from({ length: TEST_FILE_LIMIT + 20 }, (_, i) => `pkg/a${String(i).padStart(4, "0")}_test.go`);
      const machine = new FakeHostMachine({ commands: gitListing(HOME, [...many, "zz/jellyfin_memory_test.go"]) });
      const { files, truncated } = await listTestFiles(HOME, "jellyfin memory", machine);
      expect(truncated).toBe(true);
      expect(files).toHaveLength(TEST_FILE_LIMIT);
      expect(files).toContain("zz/jellyfin_memory_test.go");
    });

    it("knows nothing of the tests when git cannot list them", async () => {
      expect(await listTestFiles("/nowhere", "", new FakeHostMachine())).toEqual({ files: undefined, truncated: false });
    });
  });

  describe("extractTestNames", () => {
    it("reads Go, script and Python test names", () => {
      expect(
        extractTestNames("a_test.go", "func TestOne(t *testing.T) {}\nfunc helper() {}\nfunc TestTwo(t *testing.T) {}"),
      )
        .toEqual(["TestOne", "TestTwo"]);
      expect(
        extractTestNames(
          "a.test.ts",
          "describe(\"x\", () => {\n  it(\"marks /compact as system\", () => {});\n  test.skip('is pending', () => {});\n});",
        ),
      )
        .toEqual(["marks /compact as system", "is pending"]);
      expect(extractTestNames("tests/test_x.py", "def test_total():\n    pass\nasync def test_export():\n    pass"))
        .toEqual([
          "test_total",
          "test_export",
        ]);
      expect(extractTestNames("tests/x.test.sh", "echo hi")).toEqual([]);
    });
  });

  describe("changedFilesSince", () => {
    it("lists the files changed against the target branch", async () => {
      const machine = new FakeHostMachine({
        commands: { [`git -C ${HOME} diff --name-only main...HEAD`]: ok("a/b.go\nc.md\n") },
      });
      expect(await changedFilesSince(HOME, "main", machine)).toEqual(["a/b.go", "c.md"]);
    });

    it("names the command and what git said when it fails", async () => {
      const machine = new FakeHostMachine({
        commands: { [`git -C ${HOME} diff --name-only nope...HEAD`]: { code: 128, stdout: "", stderr: "bad revision" } },
      });
      await expect(changedFilesSince(HOME, "nope", machine)).rejects.toThrow(
        /`git -C \/p\/homelab diff --name-only nope...HEAD` failed \(exit 128\): bad revision/,
      );
    });
  });

  describe("detectRunners", () => {
    it("reads go.mod for a Go module", async () => {
      const machine = new FakeHostMachine({
        files: { [`${HOME}/go.mod`]: "module github.com/zach/agentmux\n\ngo 1.25\n" },
      });
      expect(await detectRunners(HOME, ["internal/a_test.go"], [], machine)).toEqual([
        { Kind: "go", Dir: "", Command: "go test", Detail: "github.com/zach/agentmux" },
      ]);
    });

    it("finds vitest in the top-level directory that holds the tests, with the package manager it names", async () => {
      const packageJson = JSON.stringify({ packageManager: "aube@2.7.0", devDependencies: { vitest: "^5" } });
      const machine = new FakeHostMachine({ files: { [`${HOME}/mastra/package.json`]: packageJson } });
      expect(await detectRunners(HOME, ["mastra/test/a.test.ts", "tests/x.test.sh"], [], machine)).toEqual([
        { Kind: "vitest", Dir: "mastra", Command: "aube exec vitest run", Detail: "" },
      ]);
    });

    it("finds a Go module below the root, beside the test files nearest the goal", async () => {
      const machine = new FakeHostMachine({
        files: { [`${HOME}/services/desired-state/go.mod`]: "module homelab/desired-state\n" },
      });
      const tests = ["services/desired-state/internal/declaration/jellyfin_memory_test.go", "tests/a.test.sh"];
      expect(await detectRunners(HOME, tests, [tests[0]!], machine)).toEqual([
        { Kind: "go", Dir: "services/desired-state", Command: "go test", Detail: "homelab/desired-state" },
      ]);
    });

    it("falls back to jest, then to the test script, and to npx without a package manager", async () => {
      const jest = new FakeHostMachine({
        files: { [`${HOME}/package.json`]: JSON.stringify({ devDependencies: { jest: "1" } }) },
      });
      expect((await detectRunners(HOME, [], [], jest))[0]).toMatchObject({ Kind: "jest", Command: "npx jest" });
      const script = new FakeHostMachine({
        files: {
          [`${HOME}/package.json`]: JSON.stringify({ packageManager: "pnpm@9", scripts: { test: "node --test" } }),
        },
      });
      expect((await detectRunners(HOME, [], [], script))[0]).toEqual({
        Kind: "npm",
        Dir: "",
        Command: "pnpm run test --",
        Detail: "node --test",
      });
    });

    it("reads pytest, cargo, phpunit and make targets from their root files", async () => {
      const machine = new FakeHostMachine({
        files: {
          [`${HOME}/pyproject.toml`]: "[tool.pytest.ini_options]\naddopts = \"-q\"\n",
          [`${HOME}/Cargo.toml`]: "[package]",
          [`${HOME}/phpunit.xml.dist`]: "<phpunit/>",
          [`${HOME}/Makefile`]: "build:\n\tgo build\ntest-unit:\n\tx\ncheck:\n\ty\n",
        },
      });
      expect((await detectRunners(HOME, [], [], machine)).map(({ Kind, Command, Detail }) => [Kind, Command, Detail]))
        .toEqual([
          ["pytest", "pytest", ""],
          ["cargo", "cargo test", ""],
          ["phpunit", "vendor/bin/phpunit", ""],
          ["make", "make", "targets: test-unit, check"],
        ]);
    });

    it("finds nothing in a project with no runner config and ignores a broken package.json", async () => {
      const machine = new FakeHostMachine({ files: { [`${HOME}/package.json`]: "{not json" } });
      expect(await detectRunners(HOME, [], [], machine)).toEqual([]);
    });
  });

  describe("projectContext with tests", () => {
    const machine = new FakeHostMachine({
      files: {
        [`${HOME}/mise.toml`]: "[tasks.test]\nrun = \"x\"\n",
        [`${HOME}/go.mod`]: "module example.com/h\n",
        [`${HOME}/internal/capability/ranked_models_test.go`]: "func TestRankedModelsPutLocalLast(t *testing.T) {}\n",
      },
      commands: {
        [LIST_OPEN]: ok(JSON.stringify({ ok: true, result: { tasks: [] } })),
        ...gitListing(HOME, ["internal/capability/ranked_models_test.go", "internal/model/run_test.go"]),
      },
    });

    it("adds the runners, test files, the names found in the nearest ones and the changed files", async () => {
      const context = await projectContext("proj-1", HOME, machine, {
        words: "ranked models put local last",
        changedFiles: ["internal/capability/ranked.go"],
      });
      expect(context).toMatchObject({
        Runners: [{ Kind: "go", Dir: "", Command: "go test", Detail: "example.com/h" }],
        TestFiles: ["internal/capability/ranked_models_test.go", "internal/model/run_test.go"],
        TestFilesTruncated: false,
        TestNames: { "internal/capability/ranked_models_test.go": ["TestRankedModelsPutLocalLast"] },
        ChangedFiles: ["internal/capability/ranked.go"],
      });
    });

    it("reads the changed files from git when given the branch they merge into", async () => {
      const diff = new FakeHostMachine({
        commands: {
          [LIST_OPEN]: ok(JSON.stringify({ ok: true, result: { tasks: [] } })),
          [`git -C ${HOME} diff --name-only main...HEAD`]: ok("a.go\n"),
        },
      });
      expect((await projectContext("proj-1", HOME, diff, { targetBranch: "main" })).ChangedFiles).toEqual(["a.go"]);
    });

    it("leaves the test files out, rather than empty, when git cannot list them", async () => {
      const context = await projectContext("proj-1", HOME, world);
      expect(context.TestFiles).toBeUndefined();
      expect(context.Runners).toEqual([]);
      expect(context.ChangedFiles).toEqual([]);
    });
  });
}


// ---- define_objective itself (Mastra's define_objective.test.ts, on fakes of the model step and the machine)
const GOAL = "get_recent_turns marks a typed slash command like /compact as system, not user";
const CLASSIFY_TEST = "test/workflows/get_recent_turns/classify_turns.test.ts";

const spec = (change: Partial<ObjectiveReply> = {}): ObjectiveReply => ({
  title: "Mark typed slash commands as system turns",
  outcome: "A typed slash command such as /compact is classified as a system turn, not a user turn.",
  acceptance: ["/compact typed by the user is a system turn", "ordinary user text stays a user turn"],
  draft: false,
  draft_reason: "",
  proof: `run: cd mastra && aube exec vitest run ${CLASSIFY_TEST}`,
  regression: "run: cd mastra && aube exec vitest run test/workflows/get_recent_turns test/transcript/turn_source.test.ts",
  regression_size: "small",
  rationale: "The classify test feeds /compact and fails while it is read as a user turn.",
  ...change,
});

/** Runs define_objective against a writer that answers `replies` in turn (the last repeats), on `machine`. */
function objectiveWorld(replies: readonly (ObjectiveReply | string)[], machine: Machine = new FakeHostMachine()) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const reply = replies[Math.min(prompts.length, replies.length) - 1]!;
    return typeof reply === "string" ? reply : JSON.stringify({ ObjectiveSpec: reply });
  };
  const run = (input: Parameters<typeof runDefineObjective>[0]) => runDefineObjective(input, { step, machine });
  return { run, prompts };
}

const typescriptInput = { text: GOAL, project: "replicas", context: typescriptProject };

describe("define_objective", () => {
  it("shapes a goal into an objective whose proof runs one test file and whose regression stays in the area", async () => {
    const { run, prompts } = objectiveWorld([spec()]);
    const output = await run(typescriptInput);
    expect(output).toMatchObject({
      title: "Mark typed slash commands as system turns",
      draft: false,
      requires: [],
      applied: "",
      project: { id: "", name: "replicas", needsNewProject: false },
      targeting: {
        runner: "vitest",
        chosen_test: `mastra/${CLASSIFY_TEST}`,
        test_files_considered: [
          `mastra/${CLASSIFY_TEST}`,
          "mastra/test/transcript/turn_source.test.ts",
          "mastra/test/runtime/gather/system_prompt.test.ts",
        ],
      },
    });
    expect(output.proof).toBe(`run: cd mastra && aube exec vitest run ${CLASSIFY_TEST} size=small`);
    expect(output.regression).toMatch(/ size=small$/);
    expect(output.draft_reason).toBeUndefined();
    expect(prompts).toHaveLength(1);
  });

  it("shows the writer the runners, the tests near the goal and what the work changes, and no regression to copy", async () => {
    const { run, prompts } = objectiveWorld([spec()]);
    await run({ ...typescriptInput, changed_files: ["mastra/src/runtime/gather/classify.ts"], alongside: ["Fix the CLI"] });
    const prompt = prompts[0]!;
    expect(prompt).toContain('- vitest in mastra/ (run it after "cd mastra &&"): aube exec vitest run');
    expect(prompt).toContain("Test files near the goal (5 of 5 listed):");
    expect(prompt).toContain(`mastra/${CLASSIFY_TEST}`);
    expect(prompt).toContain("Changed files:\nmastra/src/runtime/gather/classify.ts");
    expect(prompt).toContain("Cross-cutting: no");
    expect(prompt).toContain("Other goals alongside (not part of this one):\n- Fix the CLI");
    expect(prompt).not.toContain("Regression commands");
  });

  it("asks with the question verbatim, its worked example, the brief, and the reply schema last", async () => {
    const { run, prompts } = objectiveWorld([spec()]);
    await run(typescriptInput);
    const prompt = prompts[0]!;
    expect(prompt.startsWith("## ObjectiveSpec\nShape the goal under \"The goal\" into one atask objective")).toBe(true);
    expect(prompt).toContain("Example:\nanswer:\n");
    expect(prompt).toContain("A proof that runs a whole suite (\"ci:\", \"mise run test\"");
    expect(prompt.indexOf("Prompt:\nProject: replicas")).toBeGreaterThan(prompt.indexOf("Example:"));
    expect(prompt.indexOf("The goal: " + GOAL)).toBeLessThan(prompt.lastIndexOf("Respond as JSON matching this schema:"));
    const schema = JSON.parse(prompt.slice(prompt.lastIndexOf("schema:\n") + "schema:\n".length));
    expect(schema.required).toEqual(["ObjectiveSpec"]);
    expect(schema.properties.ObjectiveSpec.properties.regression_size.enum).toEqual(["small", "medium", "large"]);
    expect(objectivePrompt("B")).toContain("Prompt:\nB\n");
  });

  it("shows the test names found in a near test file", async () => {
    const { run, prompts } = objectiveWorld([
      spec({ proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast", regression: "go_test: ./internal/capability" }),
    ]);
    await run({ text: "select_model ranks ollama/nimble last when TypeSafe answers", project: "agentmux", context: goProject });
    expect(prompts[0]).toContain("internal/capability/ranked_models_test.go [tests: TestRankedModelsPutLocalLast, TestRankedModelsKeepOrder]");
  });

  it("lists the project's mise test tasks that share a word with the goal", async () => {
    const { run, prompts } = objectiveWorld([
      spec({ proof: "run: mise run test:jellyfin-memory", regression: "run: mise run test:media-routes" }),
    ]);
    await run({ text: "Limit Jellyfin memory to stop OOM", project: "homelab", context: nestedModuleProject });
    expect(prompts[0]).toContain("Mise test tasks near the goal: test:jellyfin-memory\n");
  });

  it("asks again, showing the rejected reply and why, when the proof runs a whole suite", async () => {
    const { run, prompts } = objectiveWorld([spec({ proof: "run: cd mastra && aube exec vitest run" }), spec()]);
    const output = await run(typescriptInput);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous reply was rejected: fix the answer: proof");
    expect(prompts[1]).toContain("runs a whole suite");
    expect(prompts[1]).toContain("Previous reply:\n{\"ObjectiveSpec\"");
    expect(output.proof).toContain(CLASSIFY_TEST);
  });

  it("fails after three bad replies, naming the problems, and after a reply that is not the objective's shape", async () => {
    const bad = spec({ regression: "lint:" });
    const { run, prompts } = objectiveWorld([bad]);
    await expect(run(typescriptInput)).rejects.toThrow(/^no valid reply after 3 attempts: fix the answer: .*bare lint preset/);
    expect(prompts).toHaveLength(3);
    const prose = objectiveWorld(["Sure, here you go"]);
    await expect(prose.run(typescriptInput)).rejects.toThrow(/no valid reply after 3 attempts: the reply is not JSON/);
    const shape = objectiveWorld([JSON.stringify({ ObjectiveSpec: { ...spec(), draft: "no" } })]);
    await expect(shape.run(typescriptInput)).rejects.toThrow(/draft must be true or false/);
  });

  it("returns a draft without checks when the writer finds no targeted proof", async () => {
    const draft = spec({
      title: "Write the 2027 registration page copy",
      outcome: "The 2027 registration page has its copy.",
      acceptance: ["The page text is written"],
      draft: true,
      draft_reason: "no test or file in the project covers page copy",
      proof: "",
      regression: "",
    });
    const { run } = objectiveWorld([draft]);
    const output = await run({ ...typescriptInput, text: "write the 2027 registration page copy" });
    expect(output).toMatchObject({
      draft: true,
      draft_reason: "no test or file in the project covers page copy",
      proof: "",
      regression: "",
      targeting: { runner: "none", chosen_test: "", chosen_scope: "", test_files_considered: [] },
    });
    expect(output.acceptance).toEqual(["The page text is written"]);
  });

  it("marks a goal an open task already states", async () => {
    const open = { ...typescriptProject, OpenTasks: [{ id: "at-abc123", title: "A typed slash command such as /compact" }] };
    const { run } = objectiveWorld([spec()]);
    expect((await run({ ...typescriptInput, context: open })).duplicate_of).toBe("at-abc123");
  });

  it("allows the whole suite as the regression, at size large, when the changes span the project", async () => {
    const wide = spec({ regression: "run: cd mastra && aube exec vitest run", regression_size: "large" });
    const { run } = objectiveWorld([wide]);
    const output = await run({ ...typescriptInput, changed_files: ["mastra/src/a.ts", "scripts/b.sh", "docs/c.md"] });
    expect(output.regression).toBe("run: cd mastra && aube exec vitest run size=large");
    expect(output.targeting.chosen_scope).toBe("whole suite");
  });

  it("works without a project or a checkout, grounding nothing", async () => {
    const { run, prompts } = objectiveWorld([spec()]);
    const output = await run({ text: GOAL });
    expect(output.project).toEqual({ id: "", name: "", needsNewProject: false });
    expect(prompts[0]!.slice(prompts[0]!.lastIndexOf("Prompt:"))).not.toContain("Test runners");
  });

  it("refuses blank text before any model call", async () => {
    const { run, prompts } = objectiveWorld([spec()]);
    for (const text of ["", "  \n"]) await expect(run({ text })).rejects.toThrow("text must not be empty");
    expect(prompts).toHaveLength(0);
  });

  it("accepts the objective bare, without the ObjectiveSpec wrapper", () => {
    expect(parseObjectiveReply(spec()).title).toBe("Mark typed slash commands as system turns");
    expect(() => parseObjectiveReply("x")).toThrow(/JSON object/);
    expect(() => parseObjectiveReply({ ...spec(), acceptance: "none" })).toThrow(/acceptance must be an array of strings/);
    expect(() => parseObjectiveReply({ ...spec(), title: undefined })).toThrow(/title must be a string/);
  });
});

// ---- naming the project reads its checkout (Mastra's runtime/gather/define_objective.ts, on a scripted machine)
describe("define_objective's project", () => {
  const HOME_DIR = "/p/agentmux";
  const registry = {
    ok: true,
    result: [
      { id: "proj-1", name: "agentmux", root_path: HOME_DIR },
      { id: "proj-2", name: "general" },
      { id: "proj-3", name: "sah:devops" },
    ],
  };
  const machineOf = (extra: Record<string, ProcessResult> = {}, files: Record<string, string> = {}, directories: string[] = []) =>
    new FakeHostMachine({
      files: {
        [`${HOME_DIR}/README.md`]: "# agentmux\n\nDelegates work to coding agents.\n",
        [`${HOME_DIR}/go.mod`]: "module example.com/agentmux\n",
        [`${HOME_DIR}/mise.toml`]: "[tasks.test]\nrun = \"go test ./...\"\n",
        [`${HOME_DIR}/internal/capability/ranked_models_test.go`]: "func TestRankedModelsPutLocalLast(t *testing.T) {}\n",
        ...files,
      },
      directories: [`${HOME_DIR}/internal`, ...directories],
      commands: {
        "atask projects": ok(JSON.stringify(registry)),
        "atask --project proj-1 list open": ok(JSON.stringify({ ok: true, result: { tasks: [{ id: "at-1", title: "Something else entirely here" }] } })),
        [`git -C ${HOME_DIR} ls-files -- ${TEST_FILE_PATHSPECS.join(" ")}`]: ok("internal/capability/ranked_models_test.go\n"),
        ...extra,
      },
    });
  const goSpec = spec({
    proof: "go_test: ./internal/capability name=TestRankedModelsPutLocalLast",
    regression: "go_test: ./internal/capability",
    regression_size: "medium",
  });

  it("reads a registered project's checkout by name, id or case-insensitively, and tells the writer its home and goal", async () => {
    for (const project of ["agentmux", "proj-1", "AgentMux"]) {
      const machine = machineOf();
      const { run, prompts } = objectiveWorld([goSpec], machine);
      const output = await run({ text: "select_model ranks ollama/nimble last", project });
      expect(output.project).toEqual({ id: "proj-1", name: "agentmux", needsNewProject: false });
      expect(output.proof).toBe("go_test: ./internal/capability name=TestRankedModelsPutLocalLast size=small");
      expect(output.regression).toBe("go_test: ./internal/capability size=medium");
      expect(prompts[0]).toContain(`Project: agentmux\nProject home: ${HOME_DIR}\nProject goal: Delegates work to coding agents.\n`);
      expect(prompts[0]).toContain("- go in the project root (example.com/agentmux): go test");
      expect(prompts[0]).toContain("Open tasks already filed (do not repeat them):\n- at-1 Something else entirely here");
      expect(machine.runs.find((run) => run.commandLine === "atask projects")!.env).toEqual({ ATASK_OUTPUT: "json" });
    }
  });

  it("reads a checkout given by absolute path as it is, without asking atask, and names it by its directory", async () => {
    const machine = machineOf();
    const { run, prompts } = objectiveWorld([goSpec], machine);
    const output = await run({ text: "select_model ranks ollama/nimble last", project: `${HOME_DIR}/` });
    expect(output.project).toEqual({ id: "", name: "agentmux", needsNewProject: false });
    expect(machine.runs.some((run) => run.commandLine.startsWith("atask"))).toBe(false);
    expect(prompts[0]).toContain("Open tasks already filed: none");
  });

  it("passes the changed files to the checkout and to the brief", async () => {
    const { run, prompts } = objectiveWorld([goSpec], machineOf());
    const output = await run({ text: "select_model ranks ollama/nimble last", project: "agentmux", changed_files: ["internal/capability/ranked.go"] });
    expect(output.targeting.changed_paths).toEqual(["internal/capability/ranked.go"]);
    expect(prompts[0]).toContain("Changed files:\ninternal/capability/ranked.go");
  });

  it("FIXED: refuses a project that is neither a directory nor a registered project with a home, instead of silently grounding nothing", async () => {
    const { run, prompts } = objectiveWorld([goSpec], machineOf());
    await expect(run({ text: "x", project: "nope" })).rejects.toThrow(/project "nope" is neither an absolute path to a directory nor an atask project with a home directory/);
    await expect(run({ text: "x", project: "general" })).rejects.toThrow(/project "general" is neither/);
    await expect(run({ text: "x", project: "/missing/dir" })).rejects.toThrow(/project "\/missing\/dir" is neither/);
    expect(prompts).toHaveLength(0);
  });

  it("lets `context` stand in for reading the project, which then only names it", async () => {
    const machine = machineOf();
    const { run } = objectiveWorld([spec()], machine);
    const output = await run({ text: GOAL, project: "anything", context: typescriptProject });
    expect(output.project).toEqual({ id: "", name: "anything", needsNewProject: false });
    expect(machine.runs).toEqual([]);
  });

  it("fails with atask's own words when the registry cannot be read", async () => {
    const down = machineOf({ "atask projects": { code: 2, stdout: "", stderr: "daemon down" } });
    await expect(objectiveWorld([goSpec], down).run({ text: "x", project: "agentmux" })).rejects.toThrow("`atask projects` failed (exit 2): daemon down");
    const garbled = machineOf({ "atask projects": ok("not json") });
    await expect(objectiveWorld([goSpec], garbled).run({ text: "x", project: "agentmux" })).rejects.toThrow(/did not print the project registry/);
    const noTasks = machineOf({ "atask --project proj-1 list open": { code: 1, stdout: "", stderr: "boom" } });
    await expect(objectiveWorld([goSpec], noTasks).run({ text: "x", project: "agentmux" })).rejects.toThrow("`atask --project proj-1 list open` failed (exit 1): boom");
  });

  it("finds a registered project's home by convention when the registry has no path, and its goal in README or AGENTS", async () => {
    const machine = new FakeHostMachine({
      homeDirectory: "/h",
      files: { "/h/Developer/Software-Automation-Holdings/devops/AGENTS.md": "# a\n\nRuns the platform.\n" },
      directories: ["/h/Developer/Software-Automation-Holdings/devops"],
      commands: { "atask projects": ok(JSON.stringify(registry)) },
    });
    expect(conventionalHome("sah:devops", "/h")).toBe("/h/Developer/Software-Automation-Holdings/devops");
    expect(conventionalHome("homelab", "/h")).toBe("/h/Developer/Personal/homelab");
    expect((await registeredProjects(machine)).map((p) => [p.name, p.home])).toEqual([
      ["agentmux", HOME_DIR],
      ["general", ""],
      ["sah:devops", "/h/Developer/Software-Automation-Holdings/devops"],
    ]);
    expect((await checkoutNamed("sah:devops", machine))?.home).toBe("/h/Developer/Software-Automation-Holdings/devops");
    expect(await repositoryGoal("/h/Developer/Software-Automation-Holdings/devops", machine)).toBe("Runs the platform.");
    expect(await repositoryGoal("", machine)).toBe("");
    expect(firstProse("# T\n\n[![b](u)](v)\n\nReal words.\n")).toBe("Real words.");
  });
});

// ---- the real machine and the model step
describe("the real machine and the model step", () => {
  let scratch = "";
  afterEach(async () => {
    if (scratch !== "") await rm(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("reads files and directories through node:fs and runs processes through pi.exec, with env as an env prefix", async () => {
    scratch = await mkdtemp(join(tmpdir(), "objective-"));
    await mkdir(join(scratch, "sub"));
    await writeFile(join(scratch, "b.txt"), "B");
    await writeFile(join(scratch, "a.txt"), "A");
    const seen: string[][] = [];
    const exec: Exec = async (command, args) => {
      seen.push([command, ...args]);
      if (args[0] === "boom") throw new Error("spawn failed");
      return { stdout: "out", stderr: "err", code: args[0] === "bad" ? 3 : 0, killed: args[0] === "slow" };
    };
    const machine = nodeMachine(exec, undefined, "/h");
    expect(machine.homeDirectory).toBe("/h");
    expect(await machine.listDirectory(scratch)).toEqual(["a.txt", "b.txt", "sub"]);
    expect(await machine.listDirectory(join(scratch, "missing"))).toEqual([]);
    expect(await machine.isDirectory(join(scratch, "sub"))).toBe(true);
    expect(await machine.isDirectory(join(scratch, "a.txt"))).toBe(false);
    expect(await machine.isFile(join(scratch, "a.txt"))).toBe(true);
    expect(await machine.readTextFile(join(scratch, "a.txt"))).toBe("A");
    expect(await machine.readTextFile(join(scratch, "missing"))).toBeUndefined();
    expect(await machine.run("git", ["status"])).toEqual({ code: 0, stdout: "out", stderr: "err" });
    await machine.run("atask", ["projects"], { ATASK_OUTPUT: "json" });
    expect(seen).toEqual([["git", "status"], ["env", "ATASK_OUTPUT=json", "atask", "projects"]]);
    expect((await machine.run("git", ["bad"])).code).toBe(3);
    expect((await machine.run("git", ["slow"])).code).toBe(-1);
    expect(await machine.run("git", ["boom"])).toEqual({ code: -1, stdout: "", stderr: "spawn failed" });
    const refused = await machine.run("sh", ["-c", "echo hi"]);
    expect(refused).toEqual({ code: -1, stdout: "", stderr: expect.stringContaining("is not a program the checkout may run") });
    expect(seen.some((call) => call[0] === "sh" || call.includes("sh"))).toBe(false);
  });

  it("spawns a bare omp -p on a private prompt file and removes it afterwards", async () => {
    let seen: { args: string[]; text: string; cwd?: string } | undefined;
    const exec: Exec = async (command, args, options) => {
      seen = { args: [command, ...args], text: await readFile(args[1]!.slice(1), "utf8"), cwd: options?.cwd };
      return { stdout: " reply \n", stderr: "", code: 0, killed: false };
    };
    expect(await ompModelStep(exec)("the prompt")).toBe("reply");
    expect(seen!.args.slice(0, 2)).toEqual(["omp", "-p"]);
    expect(seen!.args.slice(3)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen!.text).toBe("the prompt");
    expect(existsSync(seen!.cwd!)).toBe(false);
    const failing = (code: number, stdout = "", killed = false): Exec => async () => ({ stdout, stderr: "bad", code, killed });
    await expect(ompModelStep(failing(2))("p")).rejects.toThrow(/model step exited 2: bad/);
    await expect(ompModelStep(failing(-1, "", true), { timeoutMs: 2000 })("p")).rejects.toThrow(/killed after 2 s/);
    await expect(ompModelStep(failing(0, " "))("p")).rejects.toThrow(/returned no text/);
  });
});

// ---- the tool
describe("the define_objective tool", () => {
  function pi(exec: Exec) {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    return { zod: new Proxy({}, { get: () => () => chain }), exec, cwd: "/", logger: {} } as never;
  }

  it("describes itself in 80 to 250 words, naming its siblings", () => {
    const tool = factory(pi(async () => ({ stdout: "", stderr: "", code: 0, killed: false }))) as { name: string; description: string };
    expect(tool.name).toBe("define_objective");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const sibling of ["identify_goals", "interview", "crystallize_spec", "task"]) expect(tool.description).toContain(sibling);
  });

  it("runs through execute with a fake omp and an absolute checkout path, treating nulls as absent", async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), "objective-tool-"));
    await writeFile(join(scratchRoot, "README.md"), "# demo\n\nA demo project.\n");
    await writeFile(join(scratchRoot, "run_demo.sh"), "echo hi\n");
    const exec: Exec = async (command, args) => {
      if (command === "omp") {
        const draft = spec({ title: "Add demo copy", outcome: "Demo has copy.", draft: true, draft_reason: "no test covers copy", proof: "", regression: "" });
        return { stdout: JSON.stringify({ ObjectiveSpec: draft }), stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "not a git repository", code: 128, killed: false };
    };
    const tool = factory(pi(exec)) as unknown as {
      execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: undefined, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: DefinedObjective }>;
    };
    const result = await tool.execute("t1", { text: "add demo copy", project: scratchRoot, changed_files: null, context: null, alongside: null }, undefined, undefined);
    expect(result.details).toMatchObject({ draft: true, draft_reason: "no test covers copy", project: { name: scratchRoot.split("/").pop() } });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    await expect(tool.execute("t2", { text: " " }, undefined, undefined)).rejects.toThrow("text must not be empty");
    await rm(scratchRoot, { recursive: true, force: true });
  });
});
let scratchRoot = "";

describe("looksLikeHost", () => {
  it.each([
    ["example.org", true],
    ["a.b.c", true],
    ["Sub-Domain.Example.COM", true],
    ["x-1.y-2", true],
    ["localhost", false],
    ["", false],
    [".", false],
    ["a.", false],
    [".a", false],
    ["a..b", false],
    ["a_b.c", false],
    ["a.b/c", false],
    ["a b.c", false],
  ])("%j -> %j", (token, expected) => {
    expect(looksLikeHost(token)).toBe(expected);
  });
  it("answers a long near-miss in linear time", () => {
    expect(looksLikeHost(`${"a.".repeat(50_000)}!`)).toBe(false);
  });
});
