import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conversationSource } from "./conversation_digest.js";
import type { Turn } from "./context.js";
import { folderSource } from "./folder_inventory.js";
import { MAX_WALKED_FILES, walkFolder } from "./folder_walk.js";
import { fileSource, pathOf, resolveSource, resolveSources, sourceFrom } from "./gather.js";
import { type DirEntry, type Machine, osMachine } from "./machine.js";
import { CONVERSATION_REF, humanAsk, readTurns, recordTurns } from "./transcript.js";

const HOME = "/home/zach";
const SHOP = `${HOME}/Developer/shop`;
const FIXTURE = join(import.meta.dir, "fixtures", "claude-tool-calls.jsonl");

const shopFiles: Record<string, string> = {
  [`${SHOP}/README.md`]: "# shop\n\nMeasures pages and conforms their brand.\n\n## Usage\n",
  [`${SHOP}/AGENTS.md`]: "# Agents\n\nTrack work with atask.\n",
  [`${SHOP}/mise.toml`]: '[tasks.measure]\ndescription = "Measure a page"\n',
  [`${SHOP}/package.json`]: '{"scripts":{"build":"tsc"}}',
  [`${SHOP}/scripts/publish.sh`]: "#!/bin/bash\n# Publishes the site to the gallery.\nset -e\n",
  [`${SHOP}/src/jobs/measure.ts`]: 'export const CHECKS = ["seo", "speed"] as const;\nexport function measurePage() {}\n',
  [`${SHOP}/src/jobs/measure.test.ts`]: "export function testOnly() {}\n",
  [`${SHOP}/src/util.ts`]: "export function pad() {}\n",
  [`${SHOP}/.github/workflows/ci.yml`]: "name: CI\non: push\n",
  [`${SHOP}/rules/brand.yml`]: 'id: brand/palette\ntitle: "Palette is on brand"\n',
  [`${SHOP}/node_modules/dep/index.js`]: "export function leaked() {}\n",
  [`${SHOP}/.git/config`]: "[core]\n",
  [`${SHOP}/.env`]: "TOKEN=hunter2\n",
  [`${SHOP}/.worktrees/other/README.md`]: "# other checkout\n",
};

/** An in-memory filesystem that records every file it was asked to read. */
class RecordingMachine implements Machine {
  readonly homeDirectory = HOME;
  readonly workingDirectory = "/work";
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string>) {}
  async readTextFile(path: string): Promise<string | undefined> {
    this.reads.push(path);
    return this.files[path];
  }
  async isDirectory(path: string): Promise<boolean> {
    return Object.keys(this.files).some((file) => file.startsWith(`${path}/`));
  }
  async listDirectory(path: string): Promise<DirEntry[]> {
    const entries = new Map<string, boolean>();
    for (const file of Object.keys(this.files)) {
      if (!file.startsWith(`${path}/`)) continue;
      const [head, ...rest] = file.slice(path.length + 1).split("/");
      entries.set(head!, rest.length > 0);
    }
    return [...entries].map(([name, directory]) => ({ name, directory })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

const shopMachine = (extra: Record<string, string> = {}) => new RecordingMachine({ ...shopFiles, ...extra });

// Mastra: test/capability/propose_capabilities/gather.test.ts, folder_facts.test.ts
describe("walkFolder", () => {
  it("lists files shallow first and skips dependencies, history, hidden entries and other checkouts", async () => {
    const { files, truncated } = await walkFolder(SHOP, shopMachine());
    expect(truncated).toBe(false);
    expect(files).toEqual([
      "AGENTS.md",
      "README.md",
      "mise.toml",
      "package.json",
      "rules/brand.yml",
      "scripts/publish.sh",
      "src/util.ts",
      ".github/workflows/ci.yml",
      "src/jobs/measure.test.ts",
      "src/jobs/measure.ts",
    ]);
  });

  it("stops at the file limit and says so", async () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_WALKED_FILES + 50 }, (_, index) => [`/big/f${String(index).padStart(5, "0")}.txt`, "x"]),
    );
    const { files, truncated } = await walkFolder("/big", new RecordingMachine(many));
    expect(files).toHaveLength(MAX_WALKED_FILES);
    expect(truncated).toBe(true);
  });

  it("stops at an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(walkFolder(SHOP, shopMachine(), controller.signal)).rejects.toThrow(/stop/);
  });
});

describe("folderSource", () => {
  it("builds a bounded inventory of what the folder documents, runs and exports", async () => {
    const source = await folderSource("~/Developer/shop", SHOP, shopMachine());
    expect(source).toMatchObject({ ref: "~/Developer/shop", kind: "folder", truncated: false });
    expect(source.body).toContain(`Folder: ${SHOP}`);
    expect(source.body).toContain("README.md:3: Measures pages and conforms their brand.");
    expect(source.body).toContain("README.md:5: ## Usage");
    expect(source.body).not.toContain("AGENTS.md:3");
    expect(source.body).toContain("AGENTS.md:1: # Agents");
    expect(source.body).toContain("mise.toml:1: mise run measure -- Measure a page");
    expect(source.body).toContain("package.json: build = tsc");
    expect(source.body).toContain("scripts/publish.sh: Publishes the site to the gallery.");
    expect(source.body).toContain("src/jobs/measure.ts: CHECKS (L1), measurePage (L2)");
    expect(source.body).toContain('src/jobs/measure.ts:1: export const CHECKS = ["seo", "speed"] as const;');
    expect(source.body).toContain("rules/: 1 files");
    expect(source.body).toContain(".github/workflows/: 1 files");
    expect(source.body).not.toContain("testOnly");
    expect(source.anchors).toEqual(expect.arrayContaining(["README.md", "src/jobs/measure.ts", "rules/brand.yml"]));
  });

  it("reads each kind of file once, never a dependency, a secret or a hidden file", async () => {
    const machine = shopMachine();
    await folderSource("shop", SHOP, machine);
    expect(machine.reads.some((path) => /node_modules|\/\.git\/|\.env|\.worktrees/.test(path))).toBe(false);
    expect(new Set(machine.reads).size).toBe(machine.reads.length);
    expect(machine.reads).not.toContain(`${SHOP}/src/jobs/measure.test.ts`);
  });

  it("reads the files that enumerate values before the ones that only export names, and says when it cut", async () => {
    const noisy = Object.fromEntries(
      Array.from({ length: 700 }, (_, index) => [
        `${SHOP}/src/m${index}.ts`,
        `export function name${index}Something${"x".repeat(60)}() {}\n`,
      ]),
    );
    const source = await folderSource("shop", SHOP, shopMachine(noisy));
    expect(source.truncated).toBe(true);
    expect(source.body).toMatch(/\(\d+ more lines left out\)/);
    expect(source.body.indexOf("src/jobs/measure.ts:1:")).toBeGreaterThan(-1);
    expect(source.body.length).toBeLessThan(80000);
  });
});

describe("conversationSource", () => {
  const user = (text: string): Turn => ({ role: "user", text });

  it("numbers what the user asked, what the agent said and every tool call by turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "pc-home-"));
    try {
      const session = join(home, ".claude/projects/-app/abc12345.jsonl");
      await mkdir(dirname(session), { recursive: true });
      await writeFile(session, await readFile(FIXTURE, "utf8"));
      const source = conversationSource("claude:abc12345", await readTurns("claude", "abc12345", home));
      expect(source).toMatchObject({ ref: "claude:abc12345", kind: "conversation", truncated: false });
      const lines = source.body.split("\n");
      expect(lines.some((line) => /^\[\d+\] user: /.test(line))).toBe(true);
      expect(lines.some((line) => /^\[\d+\] tool \w+: /.test(line))).toBe(true);
      expect(lines.every((line) => /^\[(\d+)\] /.test(line))).toBe(true);
      expect(source.anchors).toEqual(lines.map((line) => /^\[(\d+)\]/.exec(line)![1]!));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps the start and more of the end of a conversation too long to read, and says how many it left out", () => {
    const turns = Array.from({ length: 2000 }, (_, index) => user(`ask number ${index + 1} ${"word ".repeat(40)}`));
    const source = conversationSource("claude:long", turns);
    expect(source.truncated).toBe(true);
    expect(source.body).toMatch(/\(\d+ turns left out\)/);
    expect(source.body).toContain("[1] user: ask number 1 ");
    expect(source.body).toContain("[2000] user: ask number 2000 ");
    expect(source.anchors).toContain("1");
    expect(source.anchors).not.toContain("1000");
  });
});

describe("the transcript reader", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pc-home-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const jsonl = (records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), text);
  }

  it("reads the fixture Claude session: the ask, the agent's words and each tool call with its input, not the results", async () => {
    await put(".claude/projects/-app/abc12345.jsonl", await readFile(FIXTURE, "utf8"));
    const turns = await readTurns("claude", "abc12345", home);
    expect(turns[0]).toEqual({ role: "user", text: "build the app and deploy it to shop.example.com, then smoke it" });
    const calls = turns.filter((turn) => turn.role === "tool").map((turn) => turn.tool_call!.name);
    expect(calls).toEqual(["Read", "Bash", "Bash", "Bash", "Edit", "Bash", "Bash", "Bash", "Bash"]);
    expect(turns.find((turn) => turn.tool_call?.id === "toolu_03")!.tool_call!.input).toEqual({ command: "rg -n deploy scripts" });
    expect(turns.filter((turn) => turn.role === "agent").map((turn) => turn.text)).toEqual([
      "Looking at the repo first.",
      "A type is missing.",
      "Deployed and smoked.",
    ]);
    expect(turns.some((turn) => turn.text.includes("total 8"))).toBe(false);
  });

  it("finds a session by prefix, by `latest` and by the harness's own order", async () => {
    await put(".claude/projects/-a/older0001.jsonl", jsonl([{ type: "user", message: { role: "user", content: "older ask" } }]));
    await put(".claude/projects/-a/newer0002.jsonl", jsonl([{ type: "user", message: { role: "user", content: "newer ask" } }]));
    expect((await readTurns("claude", "older00", home))[0]!.text).toBe("older ask");
    const { utimes } = await import("node:fs/promises");
    await utimes(join(home, ".claude/projects/-a/newer0002.jsonl"), new Date(), new Date(Date.now() + 60_000));
    expect((await readTurns("claude", "latest", home))[0]!.text).toBe("newer ask");
    await expect(readTurns("claude", "zzzz9999", home)).rejects.toThrow(/No claude session matched 'zzzz9999'/);
  });

  it("reads an omp session along the branch of its last entry, with toolCall blocks", async () => {
    await put(
      ".omp/agent/sessions/-proj/2026-01-01T00-00-00-000Z_0123456789abcdef.jsonl",
      jsonl([
        { type: "session", id: "s" },
        { id: "1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "find the dupes" }] } },
        {
          id: "2",
          parentId: "1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "fd -e jpg" } }],
          },
        },
        { id: "3", parentId: "1", type: "message", message: { role: "user", content: "abandoned branch" } },
        { id: "4", parentId: "2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
      ]),
    );
    const turns = await readTurns("omp", "0123456789abcdef", home);
    expect(turns.map((turn) => [turn.role, turn.tool_call?.name ?? turn.text])).toEqual([
      ["user", "find the dupes"],
      ["agent", "On it."],
      ["tool", "bash"],
      ["agent", "Done."],
    ]);
  });

  it("drops what the harness wrote and no person asked", () => {
    for (const text of ["<system-reminder>x</system-reminder>", "<local-command-stdout>y</local-command-stdout>", "[Request interrupted by user]", "Heartbeat (12s)", "   "]) {
      expect(humanAsk(text)).toBeUndefined();
    }
    expect(humanAsk("<user_query>\n the real ask \n</user_query>")).toBe("the real ask");
    expect(recordTurns("claude", { type: "user", isSidechain: true, message: { role: "user", content: "side" } })).toEqual([]);
  });

  it("reads codex and grok records into turns", () => {
    expect(
      recordTurns("codex", { type: "response_item", payload: { type: "function_call", call_id: "k", name: "shell", arguments: '{"cmd":"ls"}' } }),
    ).toEqual([{ role: "tool", text: "", tool_call: { id: "k", name: "shell", input: { cmd: "ls" } } }]);
    expect(recordTurns("grok", { type: "user", content: "hi <system-reminder>skip</system-reminder>" })).toEqual([{ role: "user", text: "hi" }]);
  });

  it("refuses an unknown harness, an unsafe identifier and a missing store, before reading anything", async () => {
    await expect(readTurns("vim" as never, "x", home)).rejects.toThrow(/not a conversation harness/);
    await expect(readTurns("claude", "../etc/passwd", home)).rejects.toThrow(/not allowed/);
    await expect(readTurns("cursor", "abc12345", home)).rejects.toThrow(/No cursor transcripts found/);
  });

  it("recognises conversation refs", () => {
    for (const ref of ["claude:abc", "omp:latest", "codex:019d-xyz"]) expect(CONVERSATION_REF.test(ref)).toBe(true);
    for (const ref of ["notes.md", "~/dev/x", "vim:abc", "claude:", "claude:a b"]) expect(CONVERSATION_REF.test(ref)).toBe(false);
  });
});

describe("resolveSource and the real filesystem", () => {
  const turnsOf = async (): Promise<Turn[]> => [
    { role: "user", text: "ask" },
    { role: "tool", text: "", tool_call: { id: "1", name: "Bash", input: { command: "ls" } } },
  ];
  const deps = (machine: Machine) => ({ machine, readConversation: turnsOf });
  const machine = () => new RecordingMachine({ ...shopFiles, "/work/notes.md": "one\ntwo\n" });

  it("turns each argument into a source: a conversation, a folder and a file, in the order given", async () => {
    const sources = await resolveSources(["claude:abc", "~/Developer/shop", "notes.md"], deps(machine()));
    expect(sources.map((source) => [source.ref, source.kind])).toEqual([
      ["claude:abc", "conversation"],
      ["~/Developer/shop", "folder"],
      ["notes.md", "file"],
    ]);
    expect(sources[2]).toMatchObject({ body: "File: /work/notes.md\n1: one\n2: two\n3: ", anchors: ["/work/notes.md", "notes.md"] });
  });

  it("names the argument it cannot read, and a conversation with nothing to read", async () => {
    await expect(resolveSource("nowhere.md", deps(machine()))).rejects.toThrow(/propose_capabilities: cannot read \/work\/nowhere\.md/);
    await expect(resolveSource("claude:abc", { machine: machine(), readConversation: async () => [] })).rejects.toThrow(
      /has no user, agent or tool-call turns/,
    );
  });

  it("resolves paths: ~ and ~/ from home, absolute as given, relative from the working directory, trailing slashes dropped", () => {
    const m = machine();
    expect(pathOf("~/a/b/", m)).toBe(`${HOME}/a/b`);
    expect(pathOf("~", m)).toBe(HOME);
    expect(pathOf("/x/y", m)).toBe("/x/y");
    expect(pathOf("rel/p", m)).toBe("/work/rel/p");
    expect(pathOf("/", m)).toBe("/");
  });

  it("keeps a source the caller already read once its shape is checked", () => {
    const given = { ref: "kept", kind: "file" as const, body: "b", anchors: ["a"], truncated: false };
    expect(sourceFrom(given, 0)).toEqual(given);
    expect(() => sourceFrom({ ...given, anchors: [1] }, 2)).toThrow(/sources\[2\]\.anchors must be an array of strings/);
    expect(() => sourceFrom("s", 0)).toThrow(/sources\[0\] must be a string to read or a source object/);
    expect(() => sourceFrom({ ...given, truncated: "no" }, 0)).toThrow(/truncated must be true or false/);
  });

  it("cuts a long file at its size limit and clips long lines, saying so", () => {
    const text = Array.from({ length: 4000 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n");
    const source = fileSource("big.txt", "/work/big.txt", text);
    expect(source.truncated).toBe(true);
    expect(source.body.length).toBeLessThanOrEqual(40100);
    expect(fileSource("w", "/w", "y".repeat(500)).body).toContain(`1: ${"y".repeat(300)}…`);
  });

  it("walks and reads a real folder through the OS machine without following links, hidden entries or dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pc-folder-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "node_modules/dep"), { recursive: true });
      await mkdir(join(root, "outside"), { recursive: true });
      await writeFile(join(root, "README.md"), "# demo\n\nMeasures things.\n");
      await writeFile(join(root, "src/a.ts"), "export function measure() {}\n");
      await writeFile(join(root, "node_modules/dep/x.js"), "export function leaked() {}\n");
      await writeFile(join(root, ".env"), "SECRET=1\n");
      await symlink(join(root, "outside"), join(root, "src/link"));
      const real = osMachine(root, HOME);
      const { files } = await walkFolder(root, real);
      expect(files).toEqual(["README.md", "src/a.ts"]);
      expect(await real.isDirectory(root)).toBe(true);
      expect(await real.readTextFile(join(root, "README.md"))).toContain("Measures things.");
      expect(await real.readTextFile(join(root, "missing"))).toBeUndefined();
      expect(await real.readTextFile(join(root, "src"))).toBeUndefined();
      const source = await resolveSource(root, { machine: real, readConversation: turnsOf });
      expect(source.kind).toBe("folder");
      expect(source.body).toContain("src/a.ts: measure (L1)");
      expect(source.body).not.toContain("leaked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
