import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import factory from "./index.js";
import { annotatedDirectory, annotatedPathOf, annotateTranscript, annotationOf, reviewPathOf, transcriptDigest, writeAnnotated } from "./annotated.js";
import { annotateSource, annotateSources, mapLimit, TRANSCRIPT_CONCURRENCY } from "./annotate_sources.js";
import type { TranscriptTurn } from "./reader/schemas.js";
import type { TurnSource } from "./reader/turn_source.js";
import { exportOf, exportProblem, itemsOf, loadTranscript, ompTurnsOf, type Item, type SessionExport } from "./session_export.js";
import { estimateUsd, priceOf } from "./pricing.js";
import { loadZod } from "./zod_for_tests.js";

const scratch = mkdtempSync(join(tmpdir(), "get-annotated-transcript-"));
const realDirectory = process.env.CAPABILITY_ANNOTATED_DIR;
process.env.CAPABILITY_ANNOTATED_DIR = join(scratch, "annotated");
afterAll(() => {
  if (realDirectory === undefined) delete process.env.CAPABILITY_ANNOTATED_DIR;
  else process.env.CAPABILITY_ANNOTATED_DIR = realDirectory;
  rmSync(scratch, { recursive: true, force: true });
});

const put = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const jsonl = (...records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const noSource: TurnSource = {
  async readTurns(conversation) {
    throw new Error(`no transcript source in this test: ${conversation}`);
  },
};

const turns: TranscriptTurn[] = [
  { role: "user", text: "fix the failing test", timestamp: "2026-10-20T10:00:00Z" },
  { role: "agent", text: "Looking.", timestamp: "2026-10-20T10:00:05Z", message_id: "m1", usage: { input: 100, output: 20, cache_read: 1000, cache_write: 50, model: "claude-sonnet-4-5" } },
  { role: "tool", text: "", timestamp: "2026-10-20T10:00:06Z", message_id: "m1", usage: { input: 100, output: 20, cache_read: 1000, cache_write: 50, model: "claude-sonnet-4-5" }, tool_call: { id: "c1", name: "read", input: { path: "a.ts" } } },
  { role: "tool", text: "", timestamp: "2026-10-20T10:00:07Z", tool_result: { id: "c1", output: "contents", is_error: false } },
  { role: "tool", text: "", timestamp: "2026-10-20T10:00:08Z", tool_call: { id: "c2", name: "bash", input: { command: "rm -rf x" } } },
  { role: "tool", text: "", timestamp: "2026-10-20T10:00:09Z", tool_result: { id: "c2", output: "permission denied", is_error: true } },
  { role: "user", text: "no, don't do that", timestamp: "2026-10-20T10:03:09Z" },
  { role: "context", text: "earlier turns were summarized", synthetic_reason: "compaction-summary", timestamp: "2026-10-20T10:03:10Z" },
  { role: "reasoning", text: "hidden", timestamp: "2026-10-20T10:03:11Z" },
];

describe("exportOf: turns become a session export", () => {
  const session = exportOf("claude:abc", "/path/raw.jsonl", turns);

  it("a person's text opens a turn; an agent's text takes the tool calls after it; a result is a system item", () => {
    expect(session.conversation).toBe("claude:abc");
    expect(session.source).toBe("/path/raw.jsonl");
    expect(session.turns).toHaveLength(2);
    const first = session.turns[0]!;
    expect(first.user).toEqual([{ id: 1, timestamp: Date.parse("2026-10-20T10:00:00Z") / 1000, text: "fix the failing test" }]);
    const [agent, ok, call2, denied] = first.response as Record<string, unknown>[];
    expect(agent).toMatchObject({ id: 2, source: "agent", text: "Looking." });
    expect((agent!.tool_calls as unknown[]).length).toBe(1);
    expect(ok).toMatchObject({ source: "system", tool_call_id: "c1", content: "contents" });
    expect(call2).toMatchObject({ source: "agent", text: "" });
    expect(denied).toMatchObject({ source: "system", tool_call_id: "c2", is_error: true });
  });

  it("keeps the harness's compaction summary as its own item and leaves reasoning out", () => {
    const second = session.turns[1]!;
    expect((second.response as Record<string, unknown>[])[0]).toMatchObject({ source: "system", synthetic_reason: "compaction-summary", content: "earlier turns were summarized" });
    expect(itemsOf(session).some((item) => item.text === "hidden")).toBe(false);
  });

  it("bills a message's usage once, on its first item", () => {
    const usages = itemsOf(session).filter((item) => item.usage !== undefined);
    expect(usages).toHaveLength(1);
    expect(usages[0]!.usage).toMatchObject({ input: 100, output: 20, model: "claude-sonnet-4-5" });
  });

  it("an export with no turns before any user text still opens one turn for the agent's items", () => {
    const solo = exportOf("x:1", "p", [{ role: "agent", text: "hello" }]);
    expect(solo.turns).toHaveLength(1);
    expect(solo.turns[0]!.user).toEqual([]);
  });
});

describe("ompTurnsOf: an omp session file as turns", () => {
  const raw = jsonl(
    { type: "session", id: "s", cwd: "/p" },
    { type: "message", id: "e1", timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "  do it  " }] } },
    {
      type: "message", id: "e2", timestamp: "2026-10-20T10:00:05Z",
      message: {
        role: "assistant", model: "anthropic/claude-sonnet-5-5",
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7 },
        content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
      },
    },
    { type: "message", id: "e3", timestamp: "2026-10-20T10:00:06Z", message: { role: "toolResult", toolCallId: "t1", isError: true, content: [{ type: "text", text: "boom" }] } },
    { type: "model_usage", id: "u", usage: { input: 1 } },
    "not json",
  );
  const read = ompTurnsOf(raw.replace("\nnot json", ""));

  it("emits user and agent text, tool calls and results; drops thinking and bookkeeping", () => {
    expect(read.map((turn) => [turn.role, turn.text, turn.tool_call?.name, turn.tool_result?.is_error])).toEqual([
      ["user", "do it", undefined, undefined],
      ["agent", "ok", undefined, undefined],
      ["tool", "", "read", undefined],
      ["tool", "boom", undefined, true],
    ]);
  });

  it("carries the assistant message's recorded usage, model and id so the annotator can read it", () => {
    expect(read[1]!.usage).toEqual({ input: 10, output: 5, cache_read: 100, cache_write: 7, model: "anthropic/claude-sonnet-5-5" });
    expect(read[1]!.message_id).toBe("e2");
    expect(read[2]!.message_id).toBe("e2");
    expect(read[0]!.usage).toBeUndefined();
  });

  it("skips lines that are not JSON", () => {
    expect(ompTurnsOf("garbage\n{\"type\":\"message\"}\n")).toEqual([]);
  });
});

describe("annotationOf", () => {
  const agent = (text: string, extra: Record<string, unknown> = {}): Item => ({ id: 2, source: "agent", text, tool_calls: [], ...extra });

  it("describes each kind of item", () => {
    expect(annotationOf({ id: 1, text: "hi" }, undefined).happened).toBe("Asked: hi");
    expect(annotationOf({ id: 1, text: "" }, undefined).happened).toBe("User sent an empty turn");
    expect(annotationOf(agent("done"), undefined).happened).toBe("Replied: done");
    expect(annotationOf(agent(""), undefined).happened).toBe("Agent sent an empty reply");
    expect(annotationOf(agent("", { tool_calls: [{ id: "1", name: "read" }, { id: "2", name: "edit" }] }), undefined).happened).toBe("Called read, edit");
    expect(annotationOf({ id: 3, source: "system", tool_call_id: "1", content: "ok" }, undefined).happened).toBe("Returned: ok");
    expect(annotationOf({ id: 3, source: "system", tool_call_id: "1", content: "" }, undefined).happened).toBe("A tool returned nothing");
    expect(annotationOf({ id: 3, source: "system", is_error: true, content: "" }, undefined).happened).toBe("A tool failed");
    expect(annotationOf({ id: 3, source: "system", synthetic_reason: "compaction-summary", text: "gist", content: "gist" }, undefined).happened).toBe("Compacted earlier turns: gist");
  });

  it("clips happened to 160 characters in `default` and keeps it whole in `raw`; the item is never clipped", () => {
    const text = "word ".repeat(100);
    const clipped = annotationOf({ id: 1, text }, undefined, "default").happened;
    expect(Array.from(clipped).length).toBe("Asked: ".length + 160);
    expect(clipped.endsWith("…")).toBe(true);
    expect(annotationOf({ id: 1, text }, undefined, "raw").happened).toBe(`Asked: ${text.trim()}`);
  });

  it("flags a denied or failed tool as waste, a user's course correction, and a large output or a long wait as cost", () => {
    expect(annotationOf({ id: 3, source: "system", tool_call_id: "1", content: "Permission denied: x" }, undefined)).toMatchObject({ waste: "denied tool", happened: "Failed: Permission denied: x" });
    expect(annotationOf({ id: 3, source: "system", tool_call_id: "1", is_error: true, content: "boom" }, undefined).waste).toBe("tool failed");
    expect(annotationOf({ id: 1, text: "no, stop doing that" }, undefined).correction).toBe(true);
    expect(annotationOf(agent("no no no"), undefined).correction).toBe(false);
    expect(annotationOf({ id: 3, source: "system", tool_call_id: "1", content: "x".repeat(8000) }, undefined).cost).toBe("output of 8000 characters");
    expect(annotationOf({ id: 3, source: "system", tool_call_id: "1", content: "x".repeat(7999) }, undefined).cost).toBeUndefined();
  });

  it("FIXED: a wait of a minute or more shows as cost whether the times are Unix seconds (what the export writes) or ISO strings", () => {
    const before = { id: 1, timestamp: 1_792_000_000 };
    expect(annotationOf({ id: 2, timestamp: 1_792_000_000 + 59 }, before).cost).toBeUndefined();
    expect(annotationOf({ id: 2, timestamp: 1_792_000_000 + 61 }, before).cost).toBe("waited 61s");
    expect(annotationOf({ id: 2, timestamp: "2026-10-20T10:02:00Z" }, { id: 1, timestamp: "2026-10-20T10:00:00Z" }).cost).toBe("waited 120s");
    expect(annotationOf({ id: 2, timestamp: 1_792_000_100_000 }, { id: 1, timestamp: 1_792_000_000_000 }).cost).toBe("waited 100s");
    expect(annotationOf({ id: 2, timestamp: "not a time" }, { id: 1, timestamp: "2026-10-20T10:00:00Z" }).cost).toBeUndefined();
  });

  it("reads recorded usage as tokens, and prices it only for a model with a price row", () => {
    const usage = { input: 1000, output: 500, cache_read: 10_000, cache_write: 100, model: "anthropic/claude-sonnet-5-5" };
    const known = annotationOf(agent("x", { usage }), undefined);
    expect(known.tokens).toEqual({ in: 1000, out: 500, cache_read: 10_000, cache_write: 100 });
    expect(known.est_usd).toBe(estimateUsd(usage, usage.model));
    expect(priceOf(usage.model).known).toBe(true);
    const unknown = annotationOf(agent("x", { usage: { ...usage, model: "some-future-model" } }), undefined);
    expect(unknown.tokens).toBeDefined();
    expect(unknown.est_usd).toBeUndefined();
    expect(annotationOf(agent("x"), undefined).tokens).toBeUndefined();
    expect(annotationOf(agent("x", { usage: "bad" }), undefined).tokens).toBeUndefined();
  });

  it("writes keys in the Mastra annotation's order so the exported JSON is byte-identical", () => {
    const annotation = annotationOf(
      { id: 3, source: "system", tool_call_id: "1", is_error: true, content: "x".repeat(8000), usage: { input: 1, output: 1, model: "claude-opus-4-5" } },
      undefined,
    );
    expect(Object.keys(annotation)).toEqual(["happened", "cost", "waste", "correction", "tokens", "est_usd"]);
  });
});

describe("annotateTranscript and the annotated file", () => {
  const session = exportOf("claude:abc", "/raw", turns);

  it("annotates every item, changes nothing else, leaves the input untouched, and is deterministic", async () => {
    const before = JSON.stringify(session);
    const annotated = await annotateTranscript(session);
    expect(JSON.stringify(session)).toBe(before);
    expect(itemsOf(annotated).every((item) => item.annotation !== undefined)).toBe(true);
    const stripped = JSON.parse(JSON.stringify(annotated, (key, value) => (key === "annotation" ? undefined : value)));
    expect(stripped).toEqual(JSON.parse(before));
    expect(JSON.stringify(await annotateTranscript(session))).toBe(JSON.stringify(annotated));
  });

  it("the annotated path embeds the transcript digest, so a grown session lands on a different file", async () => {
    const annotated = await annotateTranscript(session);
    expect(transcriptDigest(annotated)).toBe(transcriptDigest(session));
    const grown = exportOf("claude:abc", "/raw", [...turns, { role: "user", text: "one more" }]);
    expect(annotatedPathOf(grown)).not.toBe(annotatedPathOf(session));
    expect(annotatedPathOf(annotated)).toBe(annotatedPathOf(session));
    expect(annotatedPathOf(session)).toMatch(/claude_abc-[0-9a-f]{16}\.annotated\.json$/);
    expect(reviewPathOf("claude:abc/../x")).toBe(join(annotatedDirectory(), "claude_abc_.._x.review.md"));
  });

  it("writeAnnotated creates the directory and writes JSON with a trailing newline", async () => {
    const annotated = await annotateTranscript(session);
    const path = await writeAnnotated(annotated);
    expect(path.startsWith(process.env.CAPABILITY_ANNOTATED_DIR!)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(annotated)));
  });
});

describe("loadTranscript", () => {
  it("a session-export .json path is read as it is", async () => {
    const path = put(join(scratch, "in/export.json"), JSON.stringify({ conversation: "x:1", turns: [{ user: [{ id: 1, text: "hi" }], response: [{ id: 2, text: "yo" }], extra: true }], note: "kept" }));
    const loaded = await loadTranscript(path, noSource);
    expect(loaded.note).toBe("kept");
    expect(itemsOf(loaded)).toHaveLength(2);
  });

  it("an export that is not one is refused, naming the file and the problem", async () => {
    const notJson = put(join(scratch, "in/bad.json"), "{nope");
    await expect(loadTranscript(notJson, noSource)).rejects.toThrow(/bad\.json is not a session export/);
    const wrong = put(join(scratch, "in/wrong.json"), JSON.stringify({ conversation: "x:1", turns: [{ user: [{ text: "no id" }] }] }));
    await expect(loadTranscript(wrong, noSource)).rejects.toThrow(/needs an `id`/);
    expect(exportProblem({ conversation: 5, turns: [] })).toMatch(/conversation/);
    expect(exportProblem({ conversation: "a", turns: "x" })).toMatch(/turns/);
    expect(exportProblem({ conversation: "a", turns: [] })).toBeUndefined();
  });

  it("an omp session file path reads natively, naming the file as the conversation", async () => {
    const path = put(join(scratch, "in/session.jsonl"), jsonl({ type: "message", id: "a", message: { role: "user", content: "hello" } }));
    const loaded = await loadTranscript(path, noSource);
    expect(loaded.conversation).toBe(path);
    expect(loaded.source).toBe(path);
    expect(itemsOf(loaded)[0]).toMatchObject({ text: "hello" });
  });

  const id = "01a1b213-6584-733d-9c27-0a45dea42aac";
  it("omp:<uuid> and a bare uuid find the session file under the omp sessions directory", async () => {
    const home = join(scratch, "home");
    const file = put(join(home, `.omp/agent/sessions/-proj/2026-10-20T10-00-00-000Z_${id}.jsonl`), jsonl({ type: "message", id: "a", message: { role: "user", content: "hello from omp" } }));
    for (const source of [`omp:${id}`, id]) {
      const loaded = await loadTranscript(source, noSource, home);
      expect(loaded.conversation).toBe(`omp:${id}`);
      expect(loaded.source).toBe(file);
    }
    await expect(loadTranscript("omp:01a1b213-6584-733d-9c27-000000000000", noSource, home)).rejects.toThrow(/no session file under/);
  });

  it("any other ref goes through the transcript source with tool calls on", async () => {
    const asked: unknown[] = [];
    const source: TurnSource = {
      async readTurns(conversation, options) {
        asked.push([conversation, options]);
        return { path: "/found.jsonl", conversation: "claude:full-id", turns: [{ role: "user", text: "q" }], skipped_lines: 0 };
      },
    };
    const loaded = await loadTranscript("claude:latest", source);
    expect(asked).toEqual([["claude:latest", { toolCalls: true }]]);
    expect(loaded.conversation).toBe("claude:full-id");
    expect(loaded.source).toBe("/found.jsonl");
  });

  it("refuses a Mastra chat thread ref or Studio URL, and anything that is not a conversation ref", async () => {
    await expect(loadTranscript("mastra:thread:abc123", noSource)).rejects.toThrow(/Mastra chat thread/);
    await expect(loadTranscript("https://studio.example.com/agents/a/threads/t1", noSource)).rejects.toThrow(/Mastra chat thread/);
    await expect(loadTranscript("not-a-ref", noSource)).rejects.toThrow(/is not a conversation ref/);
  });
});

describe("annotateSources", () => {
  const exportAt = (name: string, items: Record<string, unknown>[]): string =>
    put(join(scratch, `sources/${name}.json`), JSON.stringify({ conversation: `test:${name}`, turns: [{ user: [{ id: 1, text: "ask" }], response: items }] }));

  it("mapLimit never runs more than the limit at once, keeps input order, and stops starting work after a failure", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      // Yield to the microtask queue so the other lanes start while this one is open; no wall-clock wait.
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
    const started: number[] = [];
    await expect(mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error("boom");
      return n;
    })).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
    expect(TRANSCRIPT_CONCURRENCY).toBe(4);
  });

  it("annotates, writes and summarises each session in order", async () => {
    const a = exportAt("a", [{ id: 2, source: "agent", text: "done", tool_calls: [], usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, model: "claude-haiku-4-5" } }, { id: 3, source: "system", tool_call_id: "x", is_error: true, content: "bad" }]);
    const b = exportAt("b", [{ id: 2, source: "agent", text: "ok", tool_calls: [] }]);
    const result = await annotateSources([a, b], "default", noSource);
    expect(result.map((session) => session.conversation)).toEqual(["test:a", "test:b"]);
    expect(result[0]).toMatchObject({ turns: 1, items: 3, wasted: 1, corrections: 0, already_annotated: false, source: null });
    expect(result[0]!.tokens).toEqual({ in: 10, out: 5, cache_read: 0, cache_write: 0 });
    expect(result[0]!.est_usd).toBeGreaterThan(0);
    expect(result[1]!.tokens).toBeNull();
    expect(result[1]!.est_usd).toBeNull();
    const written = JSON.parse(readFileSync(result[0]!.path, "utf8")) as SessionExport;
    expect(itemsOf(written).every((item) => item.annotation !== undefined)).toBe(true);
  });

  it("an export that is already fully annotated passes through unchanged", async () => {
    const first = await annotateSource(exportAt("pre", [{ id: 2, source: "agent", text: "k", tool_calls: [] }]), "default", noSource);
    const again = await annotateSource(first.path, "raw", noSource);
    expect(again.already).toBe(true);
    expect(JSON.stringify(again.session)).toBe(JSON.stringify(first.session));
    expect(again.path).toBe(first.path);
  });

  it("an unreadable source fails the whole call: no partial list", async () => {
    const good = exportAt("good", [{ id: 2, source: "agent", text: "k", tool_calls: [] }]);
    await expect(annotateSources([good, join(scratch, "sources/missing.json")], "default", noSource)).rejects.toThrow();
  });
});

describe("the tool", () => {
  type Tool = {
    name: string;
    description: string;
    parameters: { safeParse?: (value: unknown) => { success: boolean } };
    execute(id: string, params: unknown, onUpdate: undefined, ctx: unknown, signal: AbortSignal | undefined): Promise<{ content: { text: string }[]; details: { directory: string; sessions: { conversation: string; path: string }[] } }>;
  };
  let tool: Tool;
  beforeAll(async () => {
    tool = factory({ zod: await loadZod() } as never) as unknown as Tool;
  });

  it("loads against omp's own pi.zod and validates its parameters", () => {
    expect(tool.name).toBe("get_annotated_transcript");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    const ok = (value: unknown): boolean => tool.parameters.safeParse!(value).success;
    expect(ok({ sources: ["claude:latest"], format: "raw" })).toBe(true);
    expect(ok({ sources: ["omp:latest"], format: null })).toBe(true);
    expect(ok({ sources: ["omp:latest"] })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ sources: "claude:latest" })).toBe(false);
    expect(ok({ sources: ["x"], format: "pretty" })).toBe(false);
  });

  it("annotates a source and returns paths and counts, not the items", async () => {
    const path = put(join(scratch, "tool/s.json"), JSON.stringify({ conversation: "t:1", turns: [{ user: [{ id: 1, text: "no, stop" }], response: [] }] }));
    const result = await tool.execute("c", { sources: [path], format: null }, undefined, {}, undefined);
    expect(result.details.directory).toBe(annotatedDirectory());
    expect(result.details.sessions[0]).toMatchObject({ conversation: "t:1", items: 1, corrections: 1 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    expect(result.content[0]!.text).not.toContain("no, stop");
  });

  it("refuses an empty list, a blank source and an aborted call", async () => {
    await expect(tool.execute("c", { sources: [] }, undefined, {}, undefined)).rejects.toThrow(/at least one/);
    await expect(tool.execute("c", { sources: ["  "] }, undefined, {}, undefined)).rejects.toThrow(/blank/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(tool.execute("c", { sources: ["x"] }, undefined, {}, aborted.signal)).rejects.toThrow();
  });

  it("a source that cannot be read fails the call", async () => {
    await expect(tool.execute("c", { sources: [join(scratch, "nope.json")] }, undefined, {}, undefined)).rejects.toThrow(/not a conversation ref/);
  });
});
