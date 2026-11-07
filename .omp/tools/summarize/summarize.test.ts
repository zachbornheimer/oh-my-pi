import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_TIMEOUT_MS, lineCount, prepare } from "./gather.js";
import factory, { DESCRIPTION, makeTool, runSummarize } from "./index.js";
import { askJson, BARE_OMP_FLAGS, type Exec, type ExecResult, type ModelStep, ompModelStep, parseJsonReply } from "./omp_model.js";
import { acceptSummary, summaryPrompt, summaryQuestion } from "./summary.js";
import { loadZod } from "./zod_for_tests.ts";

const zod = await loadZod();

const reply = (summary: string, focus: unknown[] = []) => JSON.stringify({ summary, focus });

/** A fake `pi.exec`: records calls, answers `result` (or the function's value) for everything. */
function fakeExec(result: Partial<ExecResult> | ((command: string, args: string[]) => Partial<ExecResult>)) {
  const calls: { command: string; args: string[]; options?: { signal?: AbortSignal; timeout?: number; cwd?: string } }[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, options });
    const value = typeof result === "function" ? result(command, args) : result;
    return { stdout: "", stderr: "", code: 0, killed: false, ...value };
  };
  return { exec, calls };
}

/** A fake model: answers each prompt in order from `replies` (the last repeats) and records the prompts. */
function fakeModel(replies: string[]) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    return replies[Math.min(prompts.length - 1, replies.length - 1)]!;
  };
  return { step, prompts };
}

async function scratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "summarize-test-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("lineCount", () => {
  it("counts a last line without a newline", () => {
    expect([lineCount(""), lineCount("a"), lineCount("a\n"), lineCount("a\nb"), lineCount("a\nb\n"), lineCount("\n")]).toEqual([0, 1, 1, 2, 2, 1]);
  });
});

describe("prepare", () => {
  it("reads a file relative to the session directory and returns its path and line count", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "build.log"), "one\ntwo\n");
      const out = await prepare({ file: "build.log" }, { exec: fakeExec({}).exec, cwd: dir });
      expect(out).toEqual({ argument: "build.log", text: "one\ntwo\n", raw_output: { path: join(dir, "build.log"), lines: 2 } });
    });
  });

  it("resolves ~/ against the home directory and refuses a path that is not a file", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "h.txt"), "x");
      const out = await prepare({ file: "~/h.txt" }, { exec: fakeExec({}).exec, cwd: "/nonexistent", home: dir });
      expect(out.raw_output.path).toBe(join(dir, "h.txt"));
      await expect(prepare({ file: "missing.txt" }, { exec: fakeExec({}).exec, cwd: dir })).rejects.toThrow(`summarize: not a file: ${join(dir, "missing.txt")}`);
      await expect(prepare({ file: dir }, { exec: fakeExec({}).exec, cwd: "/" })).rejects.toThrow("not a file");
    });
  });

  it("runs a command under sh -c in the session directory and saves stdout then stderr to a private temp file", async () => {
    await scratch(async (dir) => {
      const { exec, calls } = fakeExec({ stdout: "out line", stderr: "err line\n", code: 3 });
      const out = await prepare({ command: "  ps aux  " }, { exec, cwd: dir, tempDir: dir });
      expect(calls).toEqual([{ command: "sh", args: ["-c", "ps aux"], options: { cwd: dir, signal: undefined, timeout: COMMAND_TIMEOUT_MS } }]);
      expect(out.text).toBe("out line\nerr line\n");
      expect(out.argument).toBe("ps aux");
      expect(out.raw_output.lines).toBe(2);
      expect(out.raw_output.path.startsWith(dir)).toBe(true);
      expect(await readFile(out.raw_output.path, "utf8")).toBe("out line\nerr line\n");
      expect((await stat(out.raw_output.path)).mode & 0o777).toBe(0o600);
    });
  });

  it("fails on exit 127 and on a killed command, but summarizes any other exit code", async () => {
    await scratch(async (dir) => {
      await expect(prepare({ command: "nope" }, { exec: fakeExec({ code: 127, stderr: "sh: nope: not found" }).exec, cwd: dir, tempDir: dir })).rejects.toThrow("sh: nope: not found");
      await expect(prepare({ command: "nope" }, { exec: fakeExec({ code: 127 }).exec, cwd: dir, tempDir: dir })).rejects.toThrow("summarize: could not run nope");
      await expect(prepare({ command: "sleep 9" }, { exec: fakeExec({ killed: true, code: -1 }).exec, cwd: dir, tempDir: dir, commandTimeoutMs: 5000 })).rejects.toThrow("killed after 5 s");
      expect((await prepare({ command: "false" }, { exec: fakeExec({ code: 1 }).exec, cwd: dir, tempDir: dir })).raw_output.lines).toBe(0);
    });
  });

  it("treats an argument that names an existing file as that file and any other as a command", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "a.txt"), "a\n");
      const files = fakeExec({});
      expect((await prepare({ argument: "a.txt" }, { exec: files.exec, cwd: dir })).raw_output.path).toBe(join(dir, "a.txt"));
      expect(files.calls).toEqual([]);
      const cmd = fakeExec({ stdout: "ok\n" });
      const out = await prepare({ argument: "echo ok" }, { exec: cmd.exec, cwd: dir, tempDir: dir });
      expect(cmd.calls[0]!.args).toEqual(["-c", "echo ok"]);
      expect(out.text).toBe("ok\n");
    });
  });

  it("refuses file together with command, and nothing at all", async () => {
    const deps = { exec: fakeExec({}).exec, cwd: "/" };
    await expect(prepare({ file: "a", command: "b" }, deps)).rejects.toThrow("pass file or command, not both");
    await expect(prepare({}, deps)).rejects.toThrow("pass file, command or argument");
    await expect(prepare({ file: "  ", command: null, argument: "" }, deps)).rejects.toThrow("pass file, command or argument");
  });
});

describe("summaryQuestion and summaryPrompt", () => {
  it("loads the copied prompt and schema", () => {
    const question = summaryQuestion();
    expect(question.instructions).toContain("You are an expert command-output analyst");
    expect((question.schema as { required: string[] }).required).toEqual(["summary", "focus"]);
  });

  it("builds instructions, argument, focus, source text and the schema, in that order", () => {
    const prompt = summaryPrompt("ps aux", ["Is it loaded?", "Any duplicates?"], "load 4.2\n");
    const order = ["## Summary\nYou are an expert", "Prompt:\nArgument: ps aux\n\nFocus:\n- Is it loaded?\n- Any duplicates?\n\nload 4.2", "Respond as JSON matching this schema:\n{", "Reply with only the JSON object."].map((part) => prompt.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(summaryPrompt("x", [], "t")).not.toContain("Focus:");
  });
});

describe("acceptSummary", () => {
  const asked = ["Is the system overloaded", "Examine duplicate processes"];
  const answer = (question: string) => ({ question, answer: "a", relevant_data: "d" });

  it("returns summary and focus in order, dropping fields it does not know", () => {
    const out = acceptSummary({ summary: "S", focus: asked.map((q) => ({ ...answer(q), extra: 1 })), more: 2 }, asked, "/tmp/raw.txt");
    expect(out).toEqual({ summary: "S", focus: asked.map(answer) });
  });

  it("drops answers nobody asked for instead of refusing the reply", () => {
    expect(acceptSummary({ summary: "S", focus: [answer("Anything?")] }, [], "/tmp/r")).toEqual({ summary: "S", focus: [] });
  });

  it("rejects an empty summary, a quoted raw path, a missing focus, a wrong count, a wrong or reordered question, and blank fields", () => {
    const run = (value: unknown, list = asked) => () => acceptSummary(value, list, "/tmp/raw.txt");
    expect(run({ summary: "  ", focus: [] })).toThrow("summary must be a non-empty string");
    expect(run({ summary: "see /tmp/raw.txt", focus: [] })).toThrow("do not put the raw output path in the summary");
    expect(run({ summary: "S" })).toThrow("focus must be an array");
    expect(run("text")).toThrow("JSON object");
    expect(run({ summary: "S", focus: [answer(asked[0]!)] })).toThrow("asked 2, got 1");
    expect(run({ summary: "S", focus: [answer(asked[1]!), answer(asked[0]!)] })).toThrow('focus question 1 must be exactly "Is the system overloaded"');
    expect(run({ summary: "S", focus: [answer(asked[0]!), { question: asked[1], answer: "", relevant_data: "d" }] })).toThrow("focus[1].answer must be a non-empty string");
    expect(run({ summary: "S", focus: [1, 2] })).toThrow("focus[0] must be an object");
  });
});

describe("parseJsonReply and askJson", () => {
  it("accepts bare JSON or one fenced block and rejects prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply("Sure! {\"a\":1}")).toThrow("the reply is not JSON");
  });

  it("asks again with the rejected reply and the reason, and fails after three bad replies", async () => {
    const model = fakeModel(["not json", reply("")]);
    await expect(askJson(model.step, "P", (value) => acceptSummary(value, [], "/p"))).rejects.toThrow("no valid reply after 3 attempts: summary must be a non-empty string");
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[1]).toContain("Previous reply:\nnot json");
    expect(model.prompts[1]).toContain("was rejected: the reply is not JSON");
    const recovered = fakeModel(["nope", reply("fine")]);
    expect(await askJson(recovered.step, "P", (value) => acceptSummary(value, [], "/p"))).toEqual({ summary: "fine", focus: [] });
  });
});

describe("ompModelStep", () => {
  it("runs omp -p on a private prompt file with the bare flags, and removes the file afterwards", async () => {
    let file = "";
    let content = "";
    const { exec, calls } = fakeExec((_command, args) => {
      file = args[1]!.slice(1);
      content = readFileSync(file, "utf8");
      return { stdout: " the reply \n" };
    });
    expect(await ompModelStep(exec)("the prompt")).toBe("the reply");
    expect(calls[0]!.command).toBe("omp");
    expect(calls[0]!.args.slice(0, 1)).toEqual(["-p"]);
    expect(calls[0]!.args.slice(2)).toEqual([...BARE_OMP_FLAGS]);
    expect(content).toBe("the prompt");
    expect(existsSync(file)).toBe(false);
  });

  it("passes --model only when one is set, and names a failed, killed or empty run", async () => {
    const withModel = fakeExec({ stdout: "x" });
    await ompModelStep(withModel.exec, { model: " fast/model " })("p");
    expect(withModel.calls[0]!.args.slice(2, 4)).toEqual(["--model", "fast/model"]);
    await expect(ompModelStep(fakeExec({ code: 2, stderr: "bad flag" }).exec)("p")).rejects.toThrow("model step exited 2: bad flag");
    await expect(ompModelStep(fakeExec({ killed: true, code: -1 }).exec, { timeoutMs: 5000 })("p")).rejects.toThrow("killed after 5 s");
    await expect(ompModelStep(fakeExec({ stdout: "  \n" }).exec)("p")).rejects.toThrow("returned no text");
  });

  it("stops before spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { exec, calls } = fakeExec({ stdout: "x" });
    await expect(ompModelStep(exec)("p", controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("runSummarize", () => {
  it("summarizes a command's output, returns an empty focus when none was asked, and never shows the model the raw path", async () => {
    await scratch(async (dir) => {
      const model = fakeModel([reply("Two login workers are running.")]);
      const { exec } = fakeExec({ stdout: "login-worker 1\nlogin-worker 2\n" });
      const out = await runSummarize({ command: "ps aux" }, { exec, cwd: dir }, { step: model.step, tempDir: dir });
      expect(out.summary).toBe("Two login workers are running.");
      expect(out.focus).toEqual([]);
      expect(out.raw_output.lines).toBe(2);
      expect(model.prompts).toHaveLength(1);
      expect(model.prompts[0]).toContain("Argument: ps aux");
      expect(model.prompts[0]).toContain("login-worker 2");
      expect(model.prompts[0]).not.toContain(out.raw_output.path);
    });
  });

  it("returns one focus answer per question in order, and refuses a mismatch after three tries", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "load.txt"), "load 4.2\n");
      const asked = ["Is the system overloaded", "Examine duplicate processes"];
      const good = asked.map((question, i) => ({ question, answer: `a${i}`, relevant_data: `d${i}` }));
      const host = { exec: fakeExec({}).exec, cwd: dir };
      const ok = await runSummarize({ file: "load.txt", focus: asked }, host, { step: fakeModel([reply("Load is high.", good)]).step });
      expect(ok.focus).toEqual(good);
      const bad = fakeModel([reply("Load is high.", [good[0]])]);
      await expect(runSummarize({ file: "load.txt", focus: asked }, host, { step: bad.step })).rejects.toThrow("asked 2, got 1");
      expect(bad.prompts).toHaveLength(3);
    });
  });

  it("refuses a blank focus question before running anything", async () => {
    const { exec, calls } = fakeExec({});
    await expect(runSummarize({ command: "ls", focus: ["ok", " "] }, { exec, cwd: "/" }, { step: fakeModel([reply("x")]).step })).rejects.toThrow("every focus question must be a non-empty string");
    expect(calls).toEqual([]);
  });

  it("uses SUMMARIZE_MODEL for the omp run", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "f.txt"), "x\n");
      const { exec, calls } = fakeExec({ stdout: reply("S") });
      const out = await runSummarize({ file: "f.txt" }, { exec, cwd: dir }, { env: { SUMMARIZE_MODEL: "fast/model" } });
      expect(out.summary).toBe("S");
      expect(calls[0]!.args.slice(2, 4)).toEqual(["--model", "fast/model"]);
    });
  });
});

describe("tool shape", () => {
  it("is essential, exec-tier, named for the capability, with a dense description", () => {
    const tool = makeTool({ zod, exec: fakeExec({}).exec, cwd: "/" } as never);
    expect(tool.name).toBe("summarize");
    expect(tool.loadMode).toBe("essential");
    expect(tool.approval).toBe("exec");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });

  it("validates parameters: valid, null optionals, invalid values", () => {
    const tool = makeTool({ zod, exec: fakeExec({}).exec, cwd: "/" } as never);
    expect(tool.parameters.safeParse({ command: "ps aux", focus: ["q"] }).success).toBe(true);
    expect(tool.parameters.safeParse({ file: null, command: null, argument: null, focus: null }).success).toBe(true);
    expect(tool.parameters.safeParse({}).success).toBe(true);
    expect(tool.parameters.safeParse({ focus: "q" }).success).toBe(false);
    expect(tool.parameters.safeParse({ file: 5 }).success).toBe(false);
  });

  it("executes through pi.exec and returns JSON text plus details", async () => {
    await scratch(async (dir) => {
      const { exec } = fakeExec({ stdout: "hello\n" });
      const tool = makeTool({ zod, exec, cwd: dir } as never, { step: fakeModel([reply("Said hello.")]).step, tempDir: dir });
      const result = await tool.execute("id", { command: "echo hello" }, undefined, {}, undefined);
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.summary).toBe("Said hello.");
      expect(parsed.raw_output.lines).toBe(1);
      expect(result.details).toEqual(parsed);
    });
  });

  it("default export builds the tool from a pi API", () => {
    expect((factory({ zod, exec: fakeExec({}).exec, cwd: homedir() } as never) as unknown as { name: string }).name).toBe("summarize");
  });
});
