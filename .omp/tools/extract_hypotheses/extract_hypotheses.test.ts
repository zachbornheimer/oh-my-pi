import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { reviewPathOf } from "./annotated.js";
import { hermesTurns } from "./reader/hermes.js";
import { opencodeTurns } from "./reader/opencode.js";
import { extractHypotheses, REVIEW_CONCURRENCY } from "./extract.js";
import factory from "./index.js";
import { type AgentStep, type Exec, mapLimit, ompSessionStep, withHeartbeat } from "./omp_session.js";
import { osHostMachine } from "./reader/host_machine.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";
import { reviewPrompt, sessionPrompt, sharedInstructions } from "./review_prompt.js";

let root: string;
let previousDirectory: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "extract-hypotheses-test-"));
  previousDirectory = process.env.CAPABILITY_ANNOTATED_DIR;
  process.env.CAPABILITY_ANNOTATED_DIR = join(root, "annotated");
  await Bun.write(join(root, "home", ".agents", "AGENTS.md"), "Be careful.\n");
});

afterEach(async () => {
  if (previousDirectory === undefined) delete process.env.CAPABILITY_ANNOTATED_DIR;
  else process.env.CAPABILITY_ANNOTATED_DIR = previousDirectory;
  await rm(root, { recursive: true, force: true });
});

/** An omp session file with one question and one answer; the name makes its conversation unique. */
async function sessionFile(name: string): Promise<string> {
  const file = join(root, `${name}.jsonl`);
  const lines = [
    { type: "message", id: "a1", message: { role: "user", content: [{ type: "text", text: `question ${name}` }] } },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: `answer ${name}` }] } },
  ];
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

const home = () => join(root, "home");
const transcripts = () => transcriptFilesTurnSource(osHostMachine(home()));

describe("review prompt", () => {
  it("opens with the shared instructions and carries the ask verbatim with the path filled in", async () => {
    const prompt = await reviewPrompt("/x/y.annotated.json", home());
    expect(prompt.startsWith("# Shared operating instructions\n\nBe careful.\n")).toBe(true);
    expect(prompt).toContain("Here's a transcript to review: /x/y.annotated.json\n\nIt's a large transcript.\n");
    expect(prompt).toContain('`echo "Hello, World" | tokuin --model gpt-4` via the run_command tool if needed');
    expect(prompt).toContain('\n\n" A tool or skill that does ___."\nThat implies that experimentation');
    expect(prompt.endsWith("things get meaningfully better for all agents in Mastra and on my machine.")).toBe(true);
  });

  it("falls back to an empty shared block when AGENTS.md is missing", async () => {
    expect(await sharedInstructions(join(root, "nowhere"))).toBe("# Shared operating instructions\n\n");
  });

  it("puts the forensics agent's instructions before the review message", async () => {
    const prompt = await sessionPrompt("/x/y.annotated.json", home());
    expect(prompt.startsWith("# Execution Forensics Analyst")).toBe(true);
    expect(prompt.indexOf("# Shared operating instructions")).toBeGreaterThan(prompt.indexOf("Execution Forensics Analyst"));
    expect(prompt.match(/# Shared operating instructions/g)?.length).toBe(1);
  });
});

describe("extractHypotheses", () => {
  it("annotates, writes the export, asks the agent once per session and writes the review", async () => {
    const file = await sessionFile("one");
    const prompts: string[] = [];
    const step: AgentStep = async (prompt) => {
      prompts.push(prompt);
      return "## Outcome\nreview text";
    };
    const [reviewed] = await extractHypotheses([file], { transcripts: transcripts(), step, home: home() });
    expect(reviewed!.conversation).toBe(file);
    expect(reviewed!.report_markdown).toBe("## Outcome\nreview text");
    expect(reviewed!.review_path).toBe(reviewPathOf(file));
    expect(await readFile(reviewed!.review_path, "utf8")).toBe("## Outcome\nreview text");
    const exported = JSON.parse(await readFile(reviewed!.annotated_path, "utf8")) as {
      turns: { user: { annotation: unknown }[] }[];
    };
    expect(exported.turns[0]!.user[0]!.annotation).toBeDefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`Here's a transcript to review: ${reviewed!.annotated_path}`);
  });

  it("reuses a non-blank review already on disk and asks again when it is blank", async () => {
    const file = await sessionFile("kept");
    let calls = 0;
    const step: AgentStep = async () => {
      calls += 1;
      return "fresh";
    };
    await extractHypotheses([file], { transcripts: transcripts(), step, home: home() });
    expect(calls).toBe(1);
    const again = await extractHypotheses([file], { transcripts: transcripts(), step, home: home() });
    expect(calls).toBe(1);
    expect(again[0]!.report_markdown).toBe("fresh");
    await writeFile(again[0]!.review_path, "  \n");
    await extractHypotheses([file], { transcripts: transcripts(), step, home: home() });
    expect(calls).toBe(2);
  });

  it("reads an already-annotated export as is", async () => {
    const file = await sessionFile("annotated");
    const step: AgentStep = async () => "review";
    const [first] = await extractHypotheses([file], { transcripts: transcripts(), step, home: home() });
    const [second] = await extractHypotheses([first!.annotated_path], { transcripts: transcripts(), step, home: home() });
    expect(second!.annotated_path).toBe(first!.annotated_path);
    expect(second!.conversation).toBe(first!.conversation);
  });

  it("runs two reviews at once, no more, and keeps the sources' order", async () => {
    const files = await Promise.all(["a", "b", "c", "d", "e"].map(sessionFile));
    let active = 0;
    let peak = 0;
    const bothRunning = Promise.withResolvers<void>();
    const step: AgentStep = async (prompt) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === REVIEW_CONCURRENCY) bothRunning.resolve();
      await bothRunning.promise;
      active -= 1;
      return `review of ${/review: (.*\.annotated\.json)/.exec(prompt)![1]}`;
    };
    const reviewed = await extractHypotheses(files, { transcripts: transcripts(), step, home: home() });
    expect(peak).toBe(REVIEW_CONCURRENCY);
    expect(reviewed.map((review) => review.conversation)).toEqual(files);
  });

  it("fails on an empty reply and writes no review", async () => {
    const file = await sessionFile("empty");
    const step: AgentStep = async () => "   ";
    await expect(extractHypotheses([file], { transcripts: transcripts(), step, home: home() })).rejects.toThrow("empty review");
    expect(await stat(reviewPathOf(file)).catch(() => undefined)).toBeUndefined();
  });

  it("fails the whole call on an unreadable source or a failing agent", async () => {
    const step: AgentStep = async () => {
      throw new Error("forensics session exited 1: boom");
    };
    await expect(
      extractHypotheses([join(root, "missing.jsonl")], { transcripts: transcripts(), step, home: home() }),
    ).rejects.toThrow();
    await expect(
      extractHypotheses([await sessionFile("x")], { transcripts: transcripts(), step, home: home() }),
    ).rejects.toThrow("boom");
  });

  it("stops when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const step: AgentStep = async () => "never";
    await expect(
      extractHypotheses([await sessionFile("abort")], {
        transcripts: transcripts(),
        step,
        home: home(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("ompSessionStep", () => {
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });

  it("runs a full omp session on the prompt file, without bare flags, and removes its directory", async () => {
    let seen: { args: string[]; cwd: string | undefined; prompt: string; timeout: number | undefined } | undefined;
    const exec: Exec = async (command, args, options) => {
      expect(command).toBe("omp");
      seen = { args, cwd: options?.cwd, prompt: await readFile(args[1]!.slice(1), "utf8"), timeout: options?.timeout };
      return ok("  the reply \n");
    };
    expect(await ompSessionStep(exec, { timeoutMs: 1234 })("hello prompt")).toBe("the reply");
    expect(seen!.args).toHaveLength(2);
    expect(seen!.args[0]).toBe("-p");
    expect(seen!.args[1]!.startsWith("@")).toBe(true);
    expect(seen!.prompt).toBe("hello prompt");
    expect(seen!.timeout).toBe(1234);
    expect(await stat(seen!.cwd!).catch(() => undefined)).toBeUndefined();
  });

  it("fails on a non-zero exit, a timeout and an empty reply", async () => {
    await expect(ompSessionStep(async () => ({ stdout: "", stderr: "bad", code: 2, killed: false }))("p")).rejects.toThrow(
      "exited 2: bad",
    );
    await expect(
      ompSessionStep(async () => ({ stdout: "", stderr: "", code: 143, killed: true }), { timeoutMs: 5000 })("p"),
    ).rejects.toThrow("killed after 5 s");
    await expect(ompSessionStep(async () => ok("  "))("p")).rejects.toThrow("returned no text");
  });

  it("leaves no temp directory behind when the exec throws", async () => {
    const count = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("omp-agent-session-")).length;
    const before = await count();
    await expect(
      ompSessionStep(async () => {
        throw new Error("spawn failed");
      })("p"),
    ).rejects.toThrow("spawn failed");
    expect(await count()).toBe(before);
  });
});

describe("helpers", () => {
  it("mapLimit stops starting items after a failure", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("no");
        return n;
      }),
    ).rejects.toThrow("no");
    expect(started).toEqual([1, 2]);
  });

  it("withHeartbeat sends updates and clears its timer", async () => {
    const texts: string[] = [];
    const beat = Promise.withResolvers<void>();
    const cleared: unknown[] = [];
    const realClear = globalThis.clearInterval;
    globalThis.clearInterval = ((handle: never) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearInterval;
    try {
      const result = await withHeartbeat(
        (update) => {
          texts.push(update.content[0]!.text);
          beat.resolve();
        },
        () => "working",
        async () => {
          await beat.promise;
          return 7;
        },
        1,
      );
      expect(result).toBe(7);
    } finally {
      globalThis.clearInterval = realClear;
    }
    expect(texts[0]).toStartWith("working (");
    expect(cleared).toHaveLength(1);
  });
});

/** A chainable stand-in for `pi.zod`: enough to build the schema. */
function stubZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}

describe("tool", () => {
  type Tool = {
    name: string;
    description: string;
    execute: (id: string, params: { sources: string[] }, onUpdate: undefined, ctx: undefined) => Promise<unknown>;
  };
  const tool = () =>
    factory({ zod: stubZod(), exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }), cwd: root } as never) as Tool;

  it("is named extract_hypotheses and its description is 80 to 250 words naming the boundary", () => {
    const { name, description } = tool();
    expect(name).toBe("extract_hypotheses");
    const words = description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(description).toContain("Mastra chat-thread refs");
  });

  it("refuses an empty list, a blank source and a Mastra thread ref before any work", async () => {
    const t = tool();
    await expect(t.execute("1", { sources: [] }, undefined, undefined)).rejects.toThrow("at least one");
    await expect(t.execute("1", { sources: ["  "] }, undefined, undefined)).rejects.toThrow("blank");
    await expect(t.execute("1", { sources: ["mastra:thread:abc"] }, undefined, undefined)).rejects.toThrow(
      "Mastra chat-thread ref",
    );
  });
});

describe("session databases", () => {
  it("reads the asked OpenCode session only, bounding tool output by a bound parameter", async () => {
    const home = join(root, "oc-home");
    await Bun.write(join(home, ".local", "share", "opencode", "placeholder"), "");
    const db = new Database(join(home, ".local", "share", "opencode", "opencode.db"));
    db.run("CREATE TABLE session (id TEXT, directory TEXT)");
    db.run("CREATE TABLE message (id TEXT, data TEXT, time_created INTEGER)");
    db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER)");
    db.run("INSERT INTO session VALUES ('s1', '/work'), ('s2', '/other')");
    db.run(`INSERT INTO message VALUES ('m1', '{"role":"user"}', 1), ('m2', '{"role":"user"}', 2)`);
    db.run(`INSERT INTO part VALUES ('p1', 'm1', 's1', '{"type":"text","text":"hello"}', 1), ('p2', 'm2', 's2', '{"type":"text","text":"elsewhere"}', 2)`);
    db.run("INSERT INTO part VALUES ('p3', 'm1', 's1', ?, 3)", [JSON.stringify({ type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: {}, output: "x".repeat(5000) } })]);
    db.close();
    const found = await opencodeTurns("s1", osHostMachine(home));
    expect(found?.turns.some((turn) => JSON.stringify(turn).includes("elsewhere"))).toBe(false);
    const output = found?.turns.find((turn) => turn.tool_result !== undefined)?.tool_result?.output;
    expect(output?.length).toBe(2000);
    expect(await opencodeTurns("missing", osHostMachine(home))).toBeUndefined();
    await expect(opencodeTurns("s1' OR '1'='1", osHostMachine(home))).rejects.toThrow("characters outside");
  });

  it("reads the asked Hermes session only", async () => {
    const home = join(root, "hermes-home");
    await Bun.write(join(home, ".hermes", "placeholder"), "");
    const db = new Database(join(home, ".hermes", "state.db"));
    db.run("CREATE TABLE sessions (id TEXT, cwd TEXT, git_branch TEXT)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, active INTEGER, display_kind TEXT)");
    db.run("INSERT INTO sessions VALUES ('h1', '/work', 'main'), ('h2', '/other', 'dev')");
    db.run("INSERT INTO messages (session_id, role, content, active) VALUES ('h1', 'user', 'asked', 1), ('h2', 'user', 'elsewhere', 1)");
    db.close();
    const found = await hermesTurns("h1", osHostMachine(home));
    expect(found?.turns.map((turn) => (turn as { text?: string }).text)).toEqual(["asked"]);
    expect(await hermesTurns("nope", osHostMachine(home))).toBeUndefined();
  });
});
