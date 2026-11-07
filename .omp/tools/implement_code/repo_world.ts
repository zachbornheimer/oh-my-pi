import type { Conventions } from "./conventions.js";
import { readConventions } from "./gather/read_conventions.js";
import type { HostMachine, ProcessResult } from "./machine.js";
import type { Design } from "./schemas.js";

/** A repo for tests: a small TypeScript repo whose leaves live in src/leaf/<name>/ with tests in test/leaf/<name>/. */
export const REPO = "/repo";

export const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });

/** A scripted machine: answers commands from a table, keeps files in memory, records every run and write. */
export class FakeMachine implements HostMachine {
  readonly runs: { commandLine: string; cwd?: string }[] = [];
  readonly writes: { path: string; text: string }[] = [];
  private readonly files: Map<string, string>;

  constructor(
    files: Readonly<Record<string, string>> = {},
    readonly commands: Readonly<Record<string, ProcessResult>> = {},
  ) {
    this.files = new Map(Object.entries(files));
  }

  async run(command: string, args: readonly string[], options: { cwd?: string } = {}): Promise<ProcessResult> {
    const commandLine = [command, ...args].join(" ");
    this.runs.push({ commandLine, cwd: options.cwd });
    return this.commands[commandLine] ?? { code: 127, stdout: "", stderr: `no fake for ${commandLine}` };
  }

  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    this.writes.push({ path, text });
    this.files.set(path, text);
  }
}

export const SHOUT_TEXT = `import { shout_text_input_schema } from "./schemas.js";

const SUFFIX = "!";

/** Upper-cases the text. */
export function shout_text(input: unknown): string {
  return shout_text_input_schema.parse(input).text.toUpperCase() + SUFFIX;
}
`;

export const LEAF_INDEX = `import { count_words } from "./count_words/count_words.js";
import { shout_text } from "./shout_text/shout_text.js";

export const leaves = [
  count_words,
  shout_text,
];
`;

const PACKAGE_JSON = JSON.stringify({
  scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
  devDependencies: { vitest: "^5.0.0" },
});

/** The files of a small repo whose leaves live in src/leaf/<name>/ with tests in test/leaf/<name>/. */
export const FILES: Readonly<Record<string, string>> = {
  "README.md": "# repo\n",
  "AGENTS.md":
    "# Agents\n\n## Conventions\n\nOne leaf per directory under src/leaf. Names say what, not how. Tests live in test/.\n\n## Other\n\nUnrelated.\n",
  "dprint.jsonc": "{ \"lineWidth\": 120 }\n",
  "package.json": PACKAGE_JSON,
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "src/leaf/index.ts": LEAF_INDEX,
  "src/leaf/shout_text/shout_text.ts": SHOUT_TEXT,
  "src/leaf/shout_text/schemas.ts":
    "import { z } from \"zod\";\n\nexport const shout_text_input_schema = z.object({ text: z.string() });\n",
  "src/leaf/shout_text/README.md": "# shout_text\n\nShouts.\n",
  "src/leaf/count_words/count_words.ts":
    "export function count_words(text: string): number {\n  return text.split(\" \").length;\n}\n",
  "src/leaf/count_words/schemas.ts": "export const count_words_schema = {};\n",
  "test/support/harness.ts":
    "export function leafHarness(input: unknown): { input: unknown } {\n  return { input };\n}\n",
  "test/leaf/shout_text/shout_text.test.ts":
    "import { expect, it } from \"vitest\";\nimport { shout_text } from \"../../../src/leaf/shout_text/shout_text.js\";\nimport { leafHarness } from \"../../support/harness.js\";\n\nit(\"shouts\", () => {\n  expect(shout_text({ text: \"a\" })).toBe(\"A!\");\n});\n",
  "test/leaf/count_words/count_words.test.ts":
    "import { expect, it } from \"vitest\";\n\nit(\"counts\", () => {\n  expect(1).toBe(1);\n});\n",
};

export const TRIM_TEXT_DESIGN = {
  name: "trim_text",
  purpose: "Returns the text without surrounding blanks.",
  input_summary: "{ text }",
  output_summary: "{ text }",
  pseudocode: "trim the text; if longer than 80 characters keep the first 80",
  replaces: ["strip_text"],
};


/** A machine holding `files` (plus `extra`) in the repo at /repo, answering git for it. */
export function repoMachine(files: Readonly<Record<string, string>> = FILES, extra: Record<string, string> = {}): FakeMachine {
  const all = { ...files, ...extra };
  return new FakeMachine(
    Object.fromEntries(Object.entries(all).map(([path, text]) => [`${REPO}/${path}`, text])),
    {
      [`git -C ${REPO} ls-files --cached --others --exclude-standard`]: ok(Object.keys(all).join("\n") + "\n"),
      [`git -C ${REPO} rev-parse --show-toplevel`]: ok(`${REPO}\n`),
      [`git -C ${REPO} grep -lw -F -- strip_text`]: ok("src/leaf/shout_text/shout_text.ts\nsrc/leaf/legacy.ts\n"),
    },
  );
}

/** The conventions of the small repo, as the reader finds them for `design`. */
export async function conventionsFor(
  design: Design = TRIM_TEXT_DESIGN,
  files: Readonly<Record<string, string>> = FILES,
): Promise<Conventions> {
  return readConventions(repoMachine(files), REPO, design, undefined);
}
