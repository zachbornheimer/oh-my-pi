import { describe, expect, it } from "bun:test";
import {
  dataDirectoryFacts,
  documentFacts,
  headCommentFacts,
  packageScriptFacts,
  sourceFacts,
  taskFacts,
} from "./folder_facts.js";

// Converted from Mastra's test/capability/propose_capabilities/folder_facts.test.ts: same inputs, same expected lines.

describe("documentFacts", () => {
  const text = "# shop\n\nMeasures pages.\n\n## Usage\n```sh\nshop run\n```\n";

  it("lists the headings with their line, and the opening prose only when asked", () => {
    expect(documentFacts("docs/a.md", text, false)).toEqual(["docs/a.md:1: # shop", "docs/a.md:5: ## Usage"]);
    expect(documentFacts("README.md", text, true).slice(0, 2)).toEqual([
      "README.md:3: Measures pages.",
      "README.md:7: shop run",
    ]);
  });
});

describe("taskFacts, packageScriptFacts and headCommentFacts", () => {
  it("reads mise tasks with their description, Makefile targets and package scripts", () => {
    const mise = '[tasks.measure]\ndescription = "Measure a page"\nrun = "x"\n\n[tasks."ci"]\nrun = "y"\n';
    expect(taskFacts("mise.toml", mise)).toEqual([
      "mise.toml:1: mise run measure -- Measure a page",
      "mise.toml:5: mise run ci",
    ]);
    expect(taskFacts("Makefile", "all: build\n\tx\nVAR := 1\ntest:\n")).toEqual([
      "Makefile:1: make all",
      "Makefile:4: make test",
    ]);
    expect(packageScriptFacts("package.json", '{"scripts":{"test":"bun test"}}')).toEqual(["package.json: test = bun test"]);
    expect(packageScriptFacts("package.json", "not json")).toEqual([]);
  });

  it("reads what a script opens with, after the shebang, and nothing past the first code line", () => {
    expect(headCommentFacts("scripts/p.sh", "#!/bin/bash\n# Publishes the site.\n# Needs a token.\nset -e\n# later\n")).toEqual([
      "scripts/p.sh: Publishes the site. Needs a token.",
    ]);
    expect(headCommentFacts("scripts/p.py", '"""Syncs rows."""\nimport os\n')).toEqual(["scripts/p.py: Syncs rows."]);
    expect(headCommentFacts("scripts/q.sh", "set -e\n")).toEqual([]);
  });
});

describe("sourceFacts", () => {
  it("lists exported names once with their line, in each language", () => {
    const text = [
      "export const Capability = z.enum([",
      '  "seo",',
      '  "mail",',
      "]);",
      "export type Capability = z.infer<typeof Capability>;",
      "export function runAll() {}",
    ].join("\n");
    const [header] = sourceFacts("src/profile.ts", text);
    expect(header).toBe("src/profile.ts: Capability (L1), runAll (L6)");
    expect(sourceFacts("a.go", "func (s *Store) Get() {}\nfunc helper() {}\nfunc NewStore() {}")[0]).toBe("a.go: Get (L1), NewStore (L3)");
    expect(sourceFacts("a.py", "def run(): pass\ndef _private(): pass\nclass Gate: pass")[0]).toBe("a.py: run (L1), Gate (L3)");
  });

  it("joins a multi-line list into one line and stops where it closes", () => {
    const text = 'export const Capability = z.enum([\n  "seo",\n  "mail",\n]);\nconst unrelated = 1;\n';
    expect(sourceFacts("src/profile.ts", text)).toContain('  src/profile.ts:1: export const Capability = z.enum([ "seo", "mail", ]);');
  });

  it("reads a one-line union, a multi-line union, an upper-case list and a Go const block", () => {
    const facts = sourceFacts(
      "src/x.ts",
      ['export type Health = "ok" | "broken";', "export function after() {}", "type Mode =", '  | "fast"', '  | "stop";', 'const ACTIONS = ["a", "b"];'].join("\n"),
    ).join("\n");
    expect(facts).toContain('src/x.ts:1: export type Health = "ok" | "broken";');
    expect(facts).not.toContain('Health = "ok" | "broken"; export function');
    expect(facts).toContain('type Mode = | "fast" | "stop";');
    expect(facts).toContain('const ACTIONS = ["a", "b"];');
    expect(sourceFacts("m.go", 'const (\n  modeFast = "fast"\n  modeStop = "stop"\n)\n').join("\n")).toContain(
      'm.go:1: const ( modeFast = "fast" modeStop = "stop" )',
    );
  });

  it("finds the verbs a CLI registers", () => {
    expect(sourceFacts("cmd/main.ts", 'program.command("check")\nsub.add_parser("init")\n&cobra.Command{Use: "audit"}\n')).toEqual([
      '  cmd/main.ts:1: .command("check"',
      '  cmd/main.ts:2: .add_parser("init"',
      '  cmd/main.ts:3: Use: "audit"',
    ]);
  });

  it("says nothing for a file that exports and registers nothing", () => {
    expect(sourceFacts("src/a.ts", "const x = 1;\nfunction local() {}\n")).toEqual([]);
  });
});

describe("dataDirectoryFacts", () => {
  it("reads a directory of data files as one line with a few examples", () => {
    const paths = ["rules/a.yml", "rules/b.yml", "rules/c.yml", "rules/d.yml", "rules/e.yml"];
    const texts = new Map(paths.map((path) => [path, `id: ${path}\ntitle: "T ${path}"\n`]));
    const lines = dataDirectoryFacts(paths, texts).join("\n").split("\n");
    expect(lines[0]).toBe("rules/: 5 files");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('  rules/a.yml: id: rules/a.yml | title: "T rules/a.yml"');
  });
});
