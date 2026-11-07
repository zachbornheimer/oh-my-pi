import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { additionDiff, applyInsertions } from "./additions.js";
import { applyPlan } from "./apply.js";
import { verificationChecks } from "./check_commands.js";
import { contentHash } from "./content_hash.js";
import { draftProblems, type DraftScene } from "./draft_checks.js";
import { examplesFor } from "./examples.js";
import { readConventions } from "./gather/read_conventions.js";
import { repoRootOf } from "./gather/repo_files.js";
import { namingOf } from "./gather/style.js";
import { nameProblem } from "./how_names.js";
import factory from "./index.js";
import { implementCode, repoPath } from "./implement.js";
import { locateProblems, type PlannedFile } from "./locate_checks.js";
import { mapLimit, modelOf } from "./model.js";
import { askAccepted, type Exec, type ModelStep, ompModelStep, parseJsonReply, withHeartbeat } from "./omp.js";
import { QUESTIONS } from "./questions.js";
import { conventionsFor, FakeMachine, FILES, LEAF_INDEX, ok, REPO, repoMachine, TRIM_TEXT_DESIGN } from "./repo_world.js";
import { type ImplementedCode, parseDesign, parseFindingsReply, parseInsertionsReply, parseLocateReply, parseRequest } from "./schemas.js";

// ---- additions (ported from the Mastra capability's tests) ----
{
describe("applyInsertions", () => {
  it("puts lines after the exact line they name and keeps everything else", () => {
    const result = applyInsertions(LEAF_INDEX, [
      {
        after: "import { shout_text } from \"./shout_text/shout_text.js\";",
        lines: ["import { trim_text } from \"./trim_text/trim_text.js\";"],
      },
      { after: "  shout_text,", lines: ["  trim_text,"] },
    ]);
    expect(result.text).toBe(
      LEAF_INDEX.replace(
        "shout_text.js\";\n",
        "shout_text.js\";\nimport { trim_text } from \"./trim_text/trim_text.js\";\n",
      ).replace(
        "  shout_text,\n",
        "  shout_text,\n  trim_text,\n",
      ),
    );
  });

  it("refuses an anchor that matches no line, or more than one", () => {
    expect(applyInsertions(LEAF_INDEX, [{ after: "nope", lines: ["x"] }]).problem).toContain("matches no line");
    expect(applyInsertions("a\na\n", [{ after: "a", lines: ["x"] }]).problem).toContain("matches 2 lines");
  });

  it("refuses an empty edit", () => {
    expect(applyInsertions(LEAF_INDEX, []).problem).toContain("at least one insertion");
    expect(applyInsertions(LEAF_INDEX, [{ after: "  shout_text,", lines: [] }]).problem).toContain("has no lines");
  });

  it("orders two insertions after the same line as given", () => {
    const result = applyInsertions("a\nb\n", [{ after: "a", lines: ["1"] }, { after: "a", lines: ["2"] }]);
    expect(result.text).toBe("a\n1\n2\nb\n");
  });
});

describe("additionDiff", () => {
  const edited = applyInsertions(LEAF_INDEX, [{ after: "  shout_text,", lines: ["  trim_text,"] }]).text!;

  it("is a unified diff holding only added lines", () => {
    const diff = additionDiff("src/leaf/index.ts", LEAF_INDEX, edited)!;
    expect(diff).toBe(
      [
        "--- a/src/leaf/index.ts",
        "+++ b/src/leaf/index.ts",
        "@@ -4,4 +4,5 @@",
        " export const leaves = [",
        "   count_words,",
        "   shout_text,",
        "+  trim_text,",
        " ];",
        "",
      ].join("\n"),
    );
    expect(diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"))).toEqual([]);
  });

  it("is undefined when a line was changed or removed, or the final newline moved", () => {
    expect(additionDiff("f", "a\nb\n", "a\nc\n")).toBeUndefined();
    expect(additionDiff("f", "a\nb\n", "a\n")).toBeUndefined();
    expect(additionDiff("f", "a\n", "a\nb")).toBeUndefined();
  });

  it("starts a hunk of a file filled from empty at line 0", () => {
    expect(additionDiff("f", "", "")).toBe("--- a/f\n+++ b/f\n");
  });

  it("splits changes far apart into two hunks", () => {
    const old = Array.from({ length: 20 }, (_unused, index) => `l${index}`);
    const next = [...old.slice(0, 2), "new1", ...old.slice(2, 18), "new2", ...old.slice(18)];
    const diff = additionDiff("f", `${old.join("\n")}\n`, `${next.join("\n")}\n`)!;
    expect(diff.match(/^@@/gm)).toHaveLength(2);
  });
});
}

// ---- check_commands (ported from the Mastra capability's tests) ----
{
const plan: PlannedFile[] = [
  { path: "src/leaf/trim_text/trim_text.ts", role: "module", reason: "r" },
  { path: "test/leaf/trim_text/trim_text.test.ts", role: "test", reason: "r" },
];

describe("verificationChecks", () => {
  it("builds the type and test commands from the manifest, the runner from the lockfile", async () => {
    expect(verificationChecks(await conventionsFor(), plan)).toEqual([
      { run: "pnpm run typecheck", why: "the new code type-checks" },
      { run: "pnpm exec vitest run test/leaf/trim_text/trim_text.test.ts", why: "the new tests pass" },
    ]);
  });

  it("knows Go: vet and test the packages of the new tests", async () => {
    const conventions = { ...(await conventionsFor()), language: "go" };
    const go: PlannedFile[] = [{ path: "internal/cli/funding.go", role: "module", reason: "r" }, {
      path: "internal/cli/funding_test.go",
      role: "test",
      reason: "r",
    }];
    expect(verificationChecks(conventions, go).map((check) => check.run)).toEqual([
      "go vet ./internal/cli",
      "go test ./internal/cli",
    ]);
  });

  it("offers nothing for a language it does not know", async () => {
    expect(verificationChecks({ ...(await conventionsFor()), language: "unknown" }, plan)).toEqual([]);
  });
});
}

// ---- draft_checks (ported from the Mastra capability's tests) ----
{
const module = (path: string): PlannedFile => ({ path, role: "module", reason: "r" });
const scene = (file: PlannedFile, extra: Partial<DraftScene> = {}): DraftScene => ({
  file,
  known: new Set(["src/leaf/shout_text/shout_text.ts"]),
  changeSet: new Set([file.path, "src/leaf/trim_text/schemas.ts"]),
  numbers: [],
  ...extra,
});
const TRIM = module("src/leaf/trim_text/trim_text.ts");

const CLEAN = `import { shout_text } from "../shout_text/shout_text.js";
import { trim_text_input_schema } from "./schemas.js";

const MAX_CHARS = 80;

export function trim_text(input: unknown): string {
  return shout_text(trim_text_input_schema.parse(input)).slice(0, MAX_CHARS).trim();
}
`;

describe("draftProblems", () => {
  it("accepts a clean module whose imports resolve to the repo or to the change", () => {
    expect(draftProblems(CLEAN, scene(TRIM, { numbers: ["80"] }))).toEqual([]);
  });

  it("refuses an empty file", () => {
    expect(draftProblems("  \n", scene(TRIM))).toEqual(["the file is empty"]);
  });

  it("refuses any, default exports and unresolved imports", () => {
    const text = `import { gone } from "./gone.js";\nexport default function f(x: any) { return gone(x); }\n`;
    expect(draftProblems(text, scene(TRIM))).toEqual([
      "use a precise type: no `any`",
      "use named exports only: no `export default`",
      "the import \"./gone.js\" is not a file of the repo or of this change",
    ]);
  });

  it("does not read `any` inside comments", () => {
    expect(draftProblems(`// x: any\nexport function f(): string { return ""; }\n`, scene(TRIM))).toEqual([]);
  });

  it("wants one exported concept per module file, not counting types or CONSTANTS", () => {
    const two = `export const MAX = 1;\nexport interface Shape {}\nexport function a() {}\nexport const b = () => 1;\n`;
    expect(draftProblems(two, scene(TRIM))).toEqual([
      "src/leaf/trim_text/trim_text.ts exports 2 concepts (a, b): a file does one thing, so move all but one to their own files",
    ]);
  });

  it("lets a declaration-only file export several schemas", () => {
    const schemas = `export const a_schema = {};\nexport const b_schema = {};\n`;
    expect(draftProblems(schemas, scene(module("src/leaf/trim_text/schemas.ts")))).toEqual([]);
  });

  it("wants every number the design mentions named", () => {
    const text = `export function f(x: string) { return x.slice(0, 80); }\n`;
    expect(draftProblems(text, scene(TRIM, { numbers: ["80", "5"] }))).toEqual([
      "the number 80 is written outside a named constant: declare const NAME = 80 and use the name",
    ]);
  });

  it("reads a test file for any, default exports and imports, not for concepts or numbers", () => {
    const test: PlannedFile = { path: "test/leaf/trim_text/trim_text.test.ts", role: "test", reason: "r" };
    const text =
      `import { trim_text } from "../../../src/leaf/trim_text/trim_text.js";\nexport function a() {}\nexport function b() { return 80; }\n`;
    expect(draftProblems(text, scene(test, { numbers: ["80"], changeSet: new Set([TRIM.path]) }))).toEqual([]);
  });

  it("only requires other languages to be non-empty", () => {
    const go = { path: "internal/cli/x.go", role: "module" as const, reason: "r" };
    expect(draftProblems("package cli\nvar x any\n", scene(go))).toEqual([]);
  });
});
}

// ---- examples (ported from the Mastra capability's tests) ----
{
describe("examplesFor", async () => {
  const { siblings } = await conventionsFor();

  it("shows the sibling file of the same role first", () => {
    const shown = examplesFor("src/leaf/trim_text/schemas.ts", "trim_text", siblings).map((file) => file.path);
    expect(shown.slice(0, 2).sort()).toEqual(["src/leaf/count_words/schemas.ts", "src/leaf/shout_text/schemas.ts"]);
  });

  it("adds the helpers the sibling tests import when the file is a test, and only then", () => {
    const forTest = examplesFor("test/leaf/trim_text/trim_text.test.ts", "trim_text", siblings).map((file) =>
      file.path
    );
    expect(forTest).toContain("test/leaf/shout_text/shout_text.test.ts");
    expect(forTest).toContain("test/support/harness.ts");
    const forModule = examplesFor("src/leaf/trim_text/trim_text.ts", "trim_text", siblings).map((file) => file.path);
    expect(forModule).not.toContain("test/support/harness.ts");
  });
});
}

// ---- locate_checks (ported from the Mastra capability's tests) ----
{
const file = (path: string, role: PlannedFile["role"]): PlannedFile => ({ path, role, reason: "r" });
const GOOD: PlannedFile[] = [
  file("src/leaf/trim_text/trim_text.ts", "module"),
  file("src/leaf/trim_text/schemas.ts", "module"),
  file("test/leaf/trim_text/trim_text.test.ts", "test"),
  file("src/leaf/index.ts", "registry"),
];

describe("locateProblems", async () => {
  const conventions = await conventionsFor();

  it("accepts a set that follows the siblings: new module and test, an existing registry", () => {
    expect(locateProblems(GOOD, conventions)).toEqual([]);
  });

  it("refuses paths outside the repo", () => {
    for (const path of ["/etc/x.ts", "../x.ts", "src/../../x.ts", "a\\b.ts"]) {
      expect(locateProblems([...GOOD, file(path, "doc")], conventions).join(" ")).toContain("inside the repo");
    }
  });

  it("refuses to overwrite an existing file, but lets a registry or a sibling file be edited", () => {
    const overwritten = locateProblems([...GOOD, file("src/leaf/shout_text/README.md", "doc")], conventions);
    expect(overwritten).toEqual([
      "\"src/leaf/shout_text/README.md\" already exists: choose a new path (only a registry or a call site may be edited)",
    ]);
    expect(locateProblems([...GOOD, file("src/leaf/shout_text/shout_text.ts", "registry")], conventions)).toEqual([]);
    expect(locateProblems([...GOOD, file("README.md", "registry")], conventions).join(" ")).toContain(
      "cannot be edited",
    );
  });

  it("leaves a manifest alone unless it names the siblings", async () => {
    expect(locateProblems([...GOOD, file("package.json", "registry")], conventions).join(" ")).toContain(
      "cannot be edited",
    );
    const naming = await conventionsFor(undefined, { ...FILES, "package.json": `{"scripts":{"shout_text":"x"}}` });
    expect(locateProblems([...GOOD, file("package.json", "registry")], naming)).toEqual([]);
  });

  it("wants what every sibling directory has, and nothing only some have", async () => {
    const shared = await conventionsFor(undefined, {
      ...FILES,
      "src/leaf/count_words/README.md": "# count_words\n",
    });
    expect(locateProblems(GOOD, shared)).toEqual([
      "every sibling directory has a file like README.md: add src/leaf/trim_text/README.md",
    ]);
    expect(locateProblems([...GOOD, file("src/leaf/trim_text/README.md", "doc")], shared)).toEqual([]);
    expect(locateProblems(GOOD, conventions)).toEqual([]);
  });

  it("does not ask for files below a sibling's directory, such as its fixtures", async () => {
    const withFixtures = await conventionsFor(undefined, {
      ...FILES,
      "src/leaf/shout_text/fixtures/data.md": "x\n",
      "src/leaf/count_words/fixtures/data.md": "x\n",
    });
    expect(locateProblems(GOOD, withFixtures)).toEqual([]);
  });

  it("refuses a registry that does not exist", () => {
    expect(locateProblems([...GOOD, file("src/leaf/other.ts", "registry")], conventions).join(" ")).toContain(
      "does not exist",
    );
  });

  it("wants a test for every module that is not declaration-only", () => {
    const withoutTest = GOOD.filter((planned) => planned.role !== "test");
    expect(locateProblems(withoutTest, conventions)).toEqual([
      "module \"src/leaf/trim_text/trim_text.ts\" has no test: add a test file whose name contains \"trim_text\"",
    ]);
  });

  it("wants tests where the repo keeps them", () => {
    const misplaced = GOOD.map((
      planned,
    ) => (planned.role === "test" ? file("src/leaf/trim_text/trim_text.test.ts", "test") : planned));
    expect(locateProblems(misplaced, conventions).join(" ")).toContain("under test/");
  });

  it("refuses names that say how or name no concept, and a file listed twice or no module at all", () => {
    expect(locateProblems([...GOOD, file("src/leaf/redis_cache/redis_cache.ts", "module")], conventions).join(" "))
      .toContain("says how (redis)");
    expect(locateProblems([file("test/leaf/x.test.ts", "test")], conventions)).toContain(
      "propose at least one module file",
    );
    expect(locateProblems([...GOOD, GOOD[0]!], conventions).join(" ")).toContain("listed twice");
  });

  it("refuses a set too big for one change", () => {
    const many = Array.from({ length: 13 }, (_unused, index) => file(`src/leaf/trim_text/part_${index}.ts`, "module"));
    expect(locateProblems(many, conventions).join(" ")).toContain("more than the 12");
  });
});

describe("nameProblem", () => {
  it("accepts names that say what", () => {
    expect(["trim_text", "capability_usage", "model-ranking"].map(nameProblem)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
  it("names the word that says how or says nothing", () => {
    expect(nameProblem("SqliteStore")).toContain("says how (sqlite)");
    expect(nameProblem("postgres_store")).toContain("says how (postgres)");
    expect(nameProblem("string_utils")).toContain("names no concept (utils)");
  });
});
}

// ---- the repo reader (ported from the Mastra gatherer's tests) ----

describe("the repo reader", () => {
  it("finds the home of the design and the siblings that share its shape, with their tests", async () => {
    const conventions = await conventionsFor();
    expect(conventions.layout.home).toBe("src/leaf");
    expect(conventions.layout.home_entries).toEqual(["count_words/", "index.ts", "shout_text/"]);
    expect(conventions.siblings.map((sibling) => sibling.name).sort()).toEqual(["count_words", "shout_text"]);
    const shout = conventions.siblings.find((sibling) => sibling.name === "shout_text")!;
    expect(shout.files.map((file) => file.path)).toEqual([
      "src/leaf/shout_text/shout_text.ts",
      "src/leaf/shout_text/schemas.ts",
      "src/leaf/shout_text/README.md",
    ]);
    expect(shout.tests.map((test) => test.path)).toEqual(["test/leaf/shout_text/shout_text.test.ts"]);
  });

  it("keeps the helpers the sibling tests import, so a new test can call them the same way", async () => {
    const { siblings } = await conventionsFor();
    const shout = siblings.find((sibling) => sibling.name === "shout_text")!;
    expect(shout.support.map((file) => file.path)).toEqual(["test/support/harness.ts"]);
    expect(siblings.find((sibling) => sibling.name === "count_words")!.support).toEqual([]);
  });

  it("lists every file of the repo so a path can be checked for existence", async () => {
    const conventions = await conventionsFor();
    expect(conventions.layout.known_files).toEqual(Object.keys(FILES));
    expect(conventions.layout.truncated).toBe(false);
  });

  it("reads the registries with the hash of the whole file", async () => {
    const conventions = await conventionsFor();
    const barrel = conventions.registries.find((registry) => registry.path === "src/leaf/index.ts")!;
    expect(barrel.sha256).toBe(contentHash(FILES["src/leaf/index.ts"]!));
    expect(conventions.registries.map((registry) => registry.path)).toContain("package.json");
  });

  it("reads style signals: language, naming, where tests live, named exports, formatter config", async () => {
    const { language, style } = await conventionsFor();
    expect(language).toBe("typescript");
    expect(style).toMatchObject({ test_layout: "separate_tree", test_root: "test", naming: "snake_case", named_exports_only: true });
    expect(style.config.map((config) => config.path)).toEqual(["dprint.jsonc"]);
  });

  it("keeps only the convention sections of the repo's guidance files", async () => {
    const { guidance } = await conventionsFor();
    expect(guidance.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
    expect(guidance[0]!.text).toContain("One leaf per directory");
    expect(guidance[0]!.text).not.toContain("Unrelated");
  });

  it("finds where a name the design replaces is still used", async () => {
    const { usages } = await conventionsFor();
    expect(usages).toEqual([{ name: "strip_text", files: ["src/leaf/shout_text/shout_text.ts", "src/leaf/legacy.ts"] }]);
  });

  it("puts a hinted directory first, and only reads", async () => {
    const machine = repoMachine();
    const conventions = await readConventions(machine, REPO, "something unrelated", { near: "test/leaf" });
    expect(conventions.layout.home).toBe("test/leaf");
    expect(machine.writes).toEqual([]);
  });

  it("names the repo when it is not a git checkout", async () => {
    await expect(readConventions(repoMachine(), "/elsewhere", "x", undefined)).rejects.toThrow("git -C /elsewhere ls-files");
    await expect(repoRootOf(repoMachine(), "/elsewhere")).rejects.toThrow("/elsewhere is not inside a git repo");
    expect(await repoRootOf(repoMachine(), REPO)).toBe(REPO);
  });

  it("resolves ~/, absolute and relative repo paths", () => {
    expect(repoPath("~/work/app", "/cwd", "/home/z")).toBe("/home/z/work/app");
    expect(repoPath("~", "/cwd", "/home/z")).toBe("/home/z");
    expect(repoPath("/abs/app", "/cwd", "/home/z")).toBe("/abs/app");
    expect(repoPath("app", "/cwd", "/home/z")).toBe("/cwd/app");
  });
});

// ---- the call and the replies ----

describe("reading the call", () => {
  it("takes words or a design object and trims the repo", () => {
    expect(parseRequest({ design: "a leaf", repo: " ~/app " })).toEqual({ design: "a leaf", repo: "~/app" });
    expect(parseRequest({ design: TRIM_TEXT_DESIGN, repo: null, hints: { near: "src", language: null } })).toEqual({
      design: TRIM_TEXT_DESIGN,
      hints: { near: "src" },
    });
  });

  it("refuses an empty design, a design object missing a field, and a repo that is not a path", () => {
    expect(() => parseRequest({ repo: "x" })).toThrow("design is required");
    expect(() => parseRequest({ design: "  ", repo: "x" })).toThrow("design must not be empty");
    expect(() => parseDesign({ name: "n", purpose: "p", input_summary: "", output_summary: "", pseudocode: "" })).toThrow("design.pseudocode must not be empty");
    expect(() => parseDesign({ name: "n", purpose: "p", input_summary: "", output_summary: "", pseudocode: "x", replaces: [1] })).toThrow("replaces");
    expect(() => parseDesign(7)).toThrow("design must be words or an object");
    expect(() => parseRequest({ design: "x", repo: " " })).toThrow("repo must be a non-empty path");
    expect(() => parseRequest({ design: "x", repo: 3 })).toThrow("repo must be a non-empty path");
    expect(() => parseRequest({ design: "x", hints: "near" })).toThrow("hints must be an object");
    expect(() => parseRequest({ design: "x", hints: { near: 1 } })).toThrow("hints.near");
  });

  it("checks each model reply and says what is wrong with it", () => {
    expect(parseLocateReply({ Files: [{ path: "a", role: "doc", reason: "r" }] })).toEqual([{ path: "a", role: "doc", reason: "r" }]);
    expect(() => parseLocateReply({ Files: [{ path: "a", role: "script", reason: "r" }] })).toThrow("Files[0].role");
    expect(() => parseLocateReply({ Files: [{ path: "", role: "doc", reason: "r" }] })).toThrow("Files[0].path");
    expect(() => parseLocateReply({ Files: [{ path: "a", role: "doc" }] })).toThrow("missing reason");
    expect(() => parseLocateReply([])).toThrow("JSON object");
    expect(() => parseLocateReply({ Files: "none" })).toThrow("Files must be an array");
    expect(parseInsertionsReply({ Insertions: [{ after: "x", lines: ["y"] }] })).toEqual([{ after: "x", lines: ["y"] }]);
    expect(() => parseInsertionsReply({ Insertions: [{ after: "x", lines: [1] }] })).toThrow("lines");
    expect(parseFindingsReply({ Findings: [] })).toEqual([]);
    expect(() => parseFindingsReply({ Findings: [{ principle: "p", file: "", finding: "f", confidence: 2 }] })).toThrow("confidence");
    expect(() => parseFindingsReply({ Findings: [{ principle: "p", file: "", finding: "f" }] })).toThrow("missing confidence");
  });

  it("keeps the copied question text: the four questions and their reply fields", () => {
    expect(Object.keys(QUESTIONS.locate)).toEqual(["Files"]);
    expect(Object.keys(QUESTIONS.draft)).toEqual(["Source"]);
    expect(Object.keys(QUESTIONS.registry_edit)).toEqual(["Insertions"]);
    expect(Object.keys(QUESTIONS.review)).toEqual(["Findings"]);
    expect(QUESTIONS.locate.Files!.instructions).toContain("Decide which files implementing the design below must be created");
    expect(QUESTIONS.locate.Files!.examples[0]).toContain("path: src/leaf/trim_text/trim_text.ts");
  });
});

// ---- the model plumbing ----

describe("model steps", () => {
  it("asks again with the reason and the previous reply when a reply is rejected, then fails after three", async () => {
    const prompts: string[] = [];
    const step: ModelStep = async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? "bad" : "good";
    };
    expect(await askAccepted(step, "ask", (reply) => {
      if (reply === "bad") throw new Error("not good");
      return reply;
    })).toBe("good");
    expect(prompts[1]).toContain("Previous reply:\nbad");
    expect(prompts[1]).toContain("was rejected: not good");
    let asked = 0;
    await expect(askAccepted(async () => (asked++, "bad"), "ask", () => { throw new Error("nope"); })).rejects.toThrow("no valid reply after 3 attempts: nope");
    expect(asked).toBe(3);
  });

  it("reads a JSON reply bare or as one fenced block and refuses prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(() => parseJsonReply('Here: {"a":1}')).toThrow("not JSON");
  });

  it("builds the JSON prompt as instructions, examples, the input and the reply schema", async () => {
    let seen = "";
    const model = modelOf(async (prompt) => ((seen = prompt), '{"Findings":[]}'));
    await model.json("review", "Findings", "THE BRIEF", parseFindingsReply, (findings) => findings);
    expect(seen.startsWith("## Findings\n")).toBe(true);
    expect(seen).toContain("\nPrompt:\nTHE BRIEF\n");
    expect(seen).toContain('Respond as JSON matching this schema:\n{"type":"object","properties":{"Findings":');
  });

  it("runs omp -p bare from a private prompt file and removes it afterwards", async () => {
    let file = "";
    let flags: string[] = [];
    const exec: Exec = async (command, args) => {
      expect(command).toBe("omp");
      file = args[1]!.slice(1);
      flags = args.slice(2);
      expect(await readFile(file, "utf8")).toBe("hello");
      return { stdout: " reply \n", stderr: "", code: 0, killed: false };
    };
    expect(await ompModelStep(exec)("hello")).toBe("reply");
    expect(flags).toContain("--no-tools");
    expect(flags).toContain("--no-extensions");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("fails on a killed, non-zero or empty model run", async () => {
    const run = (result: { stdout: string; stderr: string; code: number; killed: boolean }) => ompModelStep(async () => result)("p");
    await expect(run({ stdout: "", stderr: "", code: 0, killed: true })).rejects.toThrow("killed");
    await expect(run({ stdout: "", stderr: "boom", code: 3, killed: false })).rejects.toThrow("exited 3: boom");
    await expect(run({ stdout: " ", stderr: "", code: 0, killed: false })).rejects.toThrow("no text");
  });

  it("stops before spawning when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    await expect(ompModelStep(async () => ((spawned = true), { stdout: "x", stderr: "", code: 0, killed: false }))("p", controller.signal)).rejects.toThrow();
    expect(spawned).toBe(false);
  });

  it("runs at most the limit at a time, keeps the order, and waits for every job before failing", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      await Promise.resolve();
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
    await expect(mapLimit([1, 2, 3], 1, async (n) => { if (n === 2) throw new Error("two failed"); return n; })).rejects.toThrow("two failed");
  });

  it("sends heartbeats while work runs and clears the timer afterwards", async () => {
    const updates: string[] = [];
    const work = Promise.withResolvers<number>();
    const first = Promise.withResolvers<void>();
    const running = withHeartbeat((update) => { updates.push(update.content[0]!.text); first.resolve(); }, () => "working", () => work.promise, 5);
    await first.promise;
    work.resolve(7);
    expect(await running).toBe(7);
    const settled = updates.length;
    const after = Promise.withResolvers<void>();
    setTimeout(after.resolve, 30);
    await after.promise;
    expect(updates).toHaveLength(settled);
  });
});

// ---- applying a plan (ported from the Mastra apply tests) ----

describe("applyPlan", () => {
  const NEW_INDEX = LEAF_INDEX.replace("  shout_text,\n", "  shout_text,\n  trim_text,\n");
  const CHECK = "pnpm exec vitest run test/leaf/trim_text/trim_text.test.ts";
  const plan = (): ImplementedCode => ({
    repo: REPO,
    files: [
      { path: "src/leaf/trim_text/trim_text.ts", action: "create", role: "module", reason: "r", content: "export const x = 1;\n" },
      { path: "src/leaf/index.ts", action: "modify", role: "registry", reason: "r", content: NEW_INDEX, base_sha256: contentHash(LEAF_INDEX) },
    ],
    touchpoints: [],
    callers_to_update: [],
    checks: [{ run: CHECK, why: "the new tests pass" }],
    review: { findings: [], revised: false },
  });
  const machine = (checkResult = ok("1 passed")) =>
    new FakeMachine({ [REPO + "/src/leaf/index.ts"]: LEAF_INDEX }, { ["sh -c " + CHECK]: checkResult });

  it("writes the created and the edited file, then runs the checks from the repo and reports each", async () => {
    const world = machine();
    const applied = await applyPlan(plan(), world);
    expect(world.writes).toEqual([
      { path: REPO + "/src/leaf/trim_text/trim_text.ts", text: "export const x = 1;\n" },
      { path: REPO + "/src/leaf/index.ts", text: NEW_INDEX },
    ]);
    expect(applied.applied?.written).toEqual([
      { path: "src/leaf/trim_text/trim_text.ts", action: "create" },
      { path: "src/leaf/index.ts", action: "modify" },
    ]);
    expect(applied.applied?.checks).toEqual([{ run: CHECK, why: "the new tests pass", passed: true, exit_code: 0, output_tail: "1 passed" }]);
    expect(world.runs).toEqual([{ commandLine: "sh -c " + CHECK, cwd: REPO }]);
  });

  it("refuses, writing nothing, when an edited file changed since it was read", async () => {
    const world = machine();
    await world.writeTextFile(REPO + "/src/leaf/index.ts", LEAF_INDEX + "// someone else\n");
    world.writes.length = 0;
    await expect(applyPlan(plan(), world)).rejects.toThrow("src/leaf/index.ts changed since it was read");
    expect(world.writes).toEqual([]);
  });

  it("refuses, writing nothing, when a file to create now exists or an edited file is gone", async () => {
    const world = machine();
    await world.writeTextFile(REPO + "/src/leaf/trim_text/trim_text.ts", "mine");
    world.writes.length = 0;
    await expect(applyPlan(plan(), world)).rejects.toThrow("src/leaf/trim_text/trim_text.ts now exists");
    expect(world.writes).toEqual([]);
    await expect(applyPlan(plan(), new FakeMachine())).rejects.toThrow("src/leaf/index.ts is gone");
  });

  it("refuses a path that leaves the repo before reading or writing anything", async () => {
    const world = machine();
    const escaping = plan();
    escaping.files[0]!.path = "../outside.ts";
    await expect(applyPlan(escaping, world)).rejects.toThrow("../outside.ts is outside the repo");
    expect(world.writes).toEqual([]);
  });

  it("reports a failing check instead of throwing, and never commits", async () => {
    const world = machine({ code: 1, stdout: "", stderr: "boom" });
    const applied = await applyPlan(plan(), world);
    expect(applied.applied?.checks[0]).toMatchObject({ passed: false, exit_code: 1, output_tail: "boom" });
    expect(world.runs.some((run) => run.commandLine.includes("git"))).toBe(false);
  });

  it("keeps only the last 2000 characters of a check's output", async () => {
    const applied = await applyPlan(plan(), machine(ok("x".repeat(5000))));
    expect(applied.applied?.checks[0]!.output_tail).toHaveLength(2000);
  });
});

// ---- the whole run, with a fake model and a fake machine (ported from the Mastra capability's test) ----

const PLAN = [
  { path: "src/leaf/trim_text/trim_text.ts", role: "module", reason: "the leaf" },
  { path: "src/leaf/trim_text/schemas.ts", role: "module", reason: "its shapes" },
  { path: "test/leaf/trim_text/trim_text.test.ts", role: "test", reason: "covers the leaf" },
  { path: "src/leaf/index.ts", role: "registry", reason: "lists every leaf" },
];
const TRIM_TEXT = "import { trim_text_input_schema } from \"./schemas.js\";\n\nconst MAX_CHARS = 80;\n\nexport function trim_text(input: unknown): string {\n  return trim_text_input_schema.parse(input).text.trim().slice(0, MAX_CHARS);\n}\n";
const SCHEMAS = "import { z } from \"zod\";\n\nexport const trim_text_input_schema = z.object({ text: z.string() });\n";
const TEST = "import { expect, it } from \"bun:test\";\nimport { trim_text } from \"../../../src/leaf/trim_text/trim_text.js\";\n\nit(\"trims\", () => {\n  expect(trim_text({ text: \" a \" })).toBe(\"a\");\n});\n";
const INSERTIONS = [
  { after: "import { shout_text } from \"./shout_text/shout_text.js\";", lines: ["import { trim_text } from \"./trim_text/trim_text.js\";"] },
  { after: "  shout_text,", lines: ["  trim_text,"] },
];
const SOURCES: Readonly<Record<string, string>> = {
  "src/leaf/trim_text/trim_text.ts": TRIM_TEXT,
  "src/leaf/trim_text/schemas.ts": SCHEMAS,
  "test/leaf/trim_text/trim_text.test.ts": TEST,
};

type Responder = (prompt: string, call: number) => string | undefined;

/** The model of a well-behaved day: the plan above, good sources, the registry edit, no findings. */
function wellBehaved(override: Responder = () => undefined) {
  const requests: string[] = [];
  const step: ModelStep = async (prompt) => {
    requests.push(prompt);
    const overridden = override(prompt, requests.length);
    if (overridden !== undefined) return overridden;
    if (prompt.includes("## Files")) return JSON.stringify({ Files: PLAN });
    if (prompt.includes("## Insertions")) return JSON.stringify({ Insertions: INSERTIONS });
    if (prompt.includes("## Findings")) return JSON.stringify({ Findings: [] });
    const path = Object.keys(SOURCES).find((candidate) => prompt.includes("The file:\n" + candidate + " "));
    return path === undefined ? "unexpected prompt" : SOURCES[path]!;
  };
  return { step, requests };
}

const noExec: Exec = async () => {
  throw new Error("the fake machine answers every command");
};

async function run(world: ReturnType<typeof wellBehaved>, params: Record<string, unknown> = {}, machine = repoMachine()) {
  const phases: string[] = [];
  const output = await implementCode(
    { design: TRIM_TEXT_DESIGN, repo: REPO, ...params },
    { exec: noExec, cwd: "/elsewhere", home: "/home/z", model: world.step, machine, onPhase: (name) => phases.push(name) },
  );
  return { output, phases, machine };
}

describe("implementCode", () => {
  it("places the files like the siblings, drafts each, and edits the registry by insertion only", async () => {
    const { output } = await run(wellBehaved());
    expect(output.repo).toBe(REPO);
    expect(output.files.map((file) => [file.path, file.action, file.role])).toEqual([
      ["src/leaf/trim_text/trim_text.ts", "create", "module"],
      ["src/leaf/trim_text/schemas.ts", "create", "module"],
      ["test/leaf/trim_text/trim_text.test.ts", "create", "test"],
      ["src/leaf/index.ts", "modify", "registry"],
    ]);
    const registry = output.files.at(-1)!;
    expect(registry.content).toContain("  trim_text,\n");
    expect(registry.base_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.touchpoints).toEqual([{ path: "src/leaf/index.ts", diff: registry.diff! }]);
    const changed = registry.diff!.split("\n").filter((line) => /^[-+][^-+]/.test(line));
    expect(changed).toEqual(["+import { trim_text } from \"./trim_text/trim_text.js\";", "+  trim_text,"]);
  });

  it("lists the targeted checks, and the callers of a name the design replaces", async () => {
    const { output } = await run(wellBehaved());
    expect(output.checks.map((check) => check.run)).toEqual([
      "pnpm run typecheck",
      "pnpm exec vitest run test/leaf/trim_text/trim_text.test.ts",
    ]);
    expect(output.callers_to_update).toEqual([{ name: "strip_text", files: ["src/leaf/shout_text/shout_text.ts", "src/leaf/legacy.ts"] }]);
  });

  it("asks the model once to locate, once per file, once for the registry and once to review, and writes nothing", async () => {
    const world = wellBehaved();
    const { phases, machine, output } = await run(world);
    const kinds = world.requests.map((prompt) => (prompt.split("\n")[0]));
    expect(kinds.sort()).toEqual(["## Files", "## Findings", "## Insertions", "## Source", "## Source", "## Source"]);
    expect(phases).toEqual(["read-repo", "read-conventions", "locate", "draft", "touchpoints", "review"]);
    expect(machine.writes).toEqual([]);
    expect(output.applied).toBeUndefined();
  });

  it("asks again when the proposed set overwrites a file, with the reason", async () => {
    const bad = [...PLAN, { path: "src/leaf/shout_text/README.md", role: "doc", reason: "x" }];
    const world = wellBehaved((prompt, call) => (prompt.includes("## Files") && call === 1 ? JSON.stringify({ Files: bad }) : undefined));
    const { output } = await run(world);
    expect(output.files).toHaveLength(4);
    const locates = world.requests.filter((prompt) => prompt.startsWith("## Files"));
    expect(locates).toHaveLength(2);
    expect(locates[1]).toContain("was rejected");
    expect(locates[1]).toContain("already exists");
  });

  it("asks again when a draft uses any", async () => {
    let drafted = 0;
    const world = wellBehaved((prompt) =>
      prompt.includes("The file:\nsrc/leaf/trim_text/trim_text.ts ") && drafted++ === 0 ? TRIM_TEXT.replace("input: unknown", "input: any") : undefined
    );
    const { output } = await run(world);
    expect(output.files[0]!.content).not.toContain("any");
    expect(world.requests.filter((prompt) => prompt.includes("The file:\nsrc/leaf/trim_text/trim_text.ts "))).toHaveLength(2);
  });

  it("unwraps a draft the model fenced and ends it with a newline", async () => {
    const fenced = "```ts\n" + TRIM_TEXT.trimEnd() + "\n```";
    const world = wellBehaved((prompt) => (prompt.includes("The file:\nsrc/leaf/trim_text/trim_text.ts ") ? fenced : undefined));
    const { output } = await run(world);
    expect(output.files[0]!.content).toBe(TRIM_TEXT);
  });

  it("refuses a registry edit whose anchor is not a line of the file", async () => {
    const world = wellBehaved((prompt) => (prompt.includes("## Insertions") ? JSON.stringify({ Insertions: [{ after: "nowhere", lines: ["x"] }] }) : undefined));
    await expect(run(world)).rejects.toThrow("\"nowhere\" matches no line of the file");
  });

  it("redrafts a file once when a sure finding names it, and reports the revision", async () => {
    const finding = { principle: "SRP", file: "src/leaf/trim_text/trim_text.ts", finding: "does two things", confidence: 0.9 };
    const weak = { principle: "DRY", file: "src/leaf/trim_text/schemas.ts", finding: "maybe", confidence: 0.3 };
    const world = wellBehaved((prompt) => {
      if (prompt.includes("## Findings")) return JSON.stringify({ Findings: [finding, weak] });
      if (prompt.includes("Fix these findings")) return TRIM_TEXT.replace("trim()", "trim() /* split */");
      return undefined;
    });
    const { output, phases } = await run(world);
    expect(output.review).toEqual({ findings: [finding, weak], revised: true });
    expect(output.files[0]!.content).toContain("/* split */");
    expect(world.requests.filter((prompt) => prompt.includes("Fix these findings"))).toHaveLength(1);
    expect(phases).toContain("revise");
    expect(phases).not.toContain("touchpoints_revised");
  });

  it("does not redraft for a finding below the confidence bar", async () => {
    const world = wellBehaved((prompt) =>
      prompt.includes("## Findings") ? JSON.stringify({ Findings: [{ principle: "DRY", file: "", finding: "x", confidence: 0.4 }] }) : undefined
    );
    const { output } = await run(world);
    expect(output.review.revised).toBe(false);
  });

  it("rejects a review that names a file outside the change, naming the files that are in it", async () => {
    const world = wellBehaved((prompt) =>
      prompt.includes("## Findings") ? JSON.stringify({ Findings: [{ principle: "SRP", file: "src/other.ts", finding: "x", confidence: 0.9 }] }) : undefined
    );
    await expect(run(world)).rejects.toThrow("is not a file of this change; name one of: src/leaf/trim_text/trim_text.ts");
  });

  it("fails naming the last reason when the model never produces a valid plan", async () => {
    const world = wellBehaved((prompt) => (prompt.includes("## Files") ? "not json" : undefined));
    await expect(run(world)).rejects.toThrow("no valid reply after 3 attempts: the reply is not JSON");
  });

  it("writes the files and runs the planned checks only when apply is true", async () => {
    const world = wellBehaved();
    const machine = new FakeMachine(
      Object.fromEntries(Object.entries(FILES).map(([path, text]) => [REPO + "/" + path, text])),
      {
        ...repoMachine().commands,
        "sh -c pnpm run typecheck": ok("types ok"),
        "sh -c pnpm exec vitest run test/leaf/trim_text/trim_text.test.ts": { code: 1, stdout: "", stderr: "1 failed" },
      },
    );
    const { output, phases } = await run(world, { apply: true }, machine);
    expect(phases.at(-1)).toBe("apply");
    expect(output.applied?.written.map((entry) => entry.path)).toEqual(output.files.map((file) => file.path));
    expect(machine.writes.map((write) => write.path)).toEqual(output.files.map((file) => REPO + "/" + file.path));
    expect(output.applied?.checks.map((check) => [check.passed, check.output_tail])).toEqual([[true, "types ok"], [false, "1 failed"]]);
  });

  it("resolves a repo given relative to the call directory, and the call directory's repo when none is given", async () => {
    const machine = repoMachine();
    const named = await implementCode({ design: TRIM_TEXT_DESIGN, repo: "repo" }, { exec: noExec, cwd: "/", model: wellBehaved().step, machine });
    expect(named.repo).toBe("/repo");
    const implied = await implementCode({ design: TRIM_TEXT_DESIGN }, { exec: noExec, cwd: REPO, model: wellBehaved().step, machine });
    expect(implied.repo).toBe(REPO);
    expect(machine.runs.some((entry) => entry.commandLine === "git -C /repo rev-parse --show-toplevel")).toBe(true);
  });

  it("stops at the first phase when cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      implementCode({ design: "x", repo: REPO }, { exec: noExec, cwd: REPO, model: wellBehaved().step, machine: repoMachine(), signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});

// ---- the tool, end to end on a real temporary git repo, a fake omp, and real git ----

describe("the tool", () => {
  const chain: Record<string, unknown> = new Proxy(() => chain, {
    get: (_target, key) => (key === "then" ? undefined : chain),
    apply: () => chain,
  }) as never;
  const zod = new Proxy({}, { get: () => () => chain }) as never;

  /** Real processes for everything but omp, which answers from the fake model. */
  function realExec(step: ModelStep): Exec {
    return async (command, args, options) => {
      if (command === "omp") return { stdout: await step(await readFile(args[1]!.slice(1), "utf8")), stderr: "", code: 0, killed: false };
      return new Promise((resolve) => {
        const child = command === "sh" ? spawn("sh", args, { cwd: options?.cwd }) : spawn("git", args, { cwd: options?.cwd });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => resolve({ stdout, stderr: String(error), code: -1, killed: false }));
        child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1, killed: false }));
      });
    };
  }

  it("reads a real repo, plans, and with apply writes the files into it", async () => {
    const root = await mkdtemp(join(tmpdir(), "implement-code-test-"));
    try {
      for (const [path, text] of Object.entries(FILES)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const git = (...args: string[]) => realExec(async () => "")("git", ["-C", root, ...args]);
      expect((await git("init", "-q")).code).toBe(0);
      const world = wellBehaved();
      const tool = factory({ zod, cwd: root, exec: realExec(world.step) } as never) as unknown as {
        name: string;
        description: string;
        execute: (id: string, params: unknown, onUpdate: undefined, ctx: undefined, signal: undefined) => Promise<{ content: { text: string }[]; details: ImplementedCode }>;
      };
      expect(tool.name).toBe("implement_code");
      const planned = await tool.execute("id", { design: TRIM_TEXT_DESIGN }, undefined, undefined, undefined);
      expect(planned.details.files).toHaveLength(4);
      expect(planned.details.repo).toBe(await realpath(root)); // the repo of the call directory, as git names it
      expect(JSON.parse(planned.content[0]!.text)).toEqual(planned.details);
      await expect(readFile(join(root, "src/leaf/trim_text/trim_text.ts"), "utf8")).rejects.toThrow();

      const applied = await tool.execute("id", { design: TRIM_TEXT_DESIGN, apply: true, repo: root }, undefined, undefined, undefined);
      expect(applied.details.applied?.written).toHaveLength(4);
      expect(await readFile(join(root, "src/leaf/trim_text/trim_text.ts"), "utf8")).toBe(TRIM_TEXT);
      expect(await readFile(join(root, "src/leaf/index.ts"), "utf8")).toContain("  trim_text,\n");
      expect(applied.details.applied?.checks.every((check) => check.exit_code !== undefined)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails rather than returning a failure as success", async () => {
    const tool = factory({ zod, cwd: "/", exec: realExec(wellBehaved().step) } as never) as unknown as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    await expect(tool.execute("id", { design: "  " })).rejects.toThrow("design must not be empty");
    await expect(tool.execute("id", { repo: "/nowhere" })).rejects.toThrow("design is required");
  });
});

describe("namingOf", () => {
  const cases: [string, string][] = [
    ["fooBar", "camelCase"], ["fooBarBaz2", "camelCase"], ["fooB", "camelCase"], ["fooBAR", "camelCase"],
    ["FooBar", "PascalCase"], ["Foo", "PascalCase"], ["Foo2Bar", "PascalCase"], ["FooBAR", "PascalCase"],
    ["foo", "unknown"], ["FOO", "unknown"], ["F", "unknown"], ["FBar", "unknown"], ["foo_bar", "snake_case"], ["foo-bar", "kebab-case"],
  ];
  for (const [name, naming] of cases) {
    it(`reads ${name} as ${naming}`, () => {
      expect(namingOf([name])).toBe(naming as never);
    });
  }
});
