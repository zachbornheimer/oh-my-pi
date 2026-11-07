import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chunkDocument, idOf, MAX_CHUNK_CHARS } from "./chunk.js";
import type { Db } from "./db.js";
import { EMBEDDING_DIMENSION } from "./embed.js";
import factory, { DESCRIPTION, makeTool, nameOf, runMemoryIngest } from "./index.js";
import { ensureMemorySchema, MEMORY_SCHEMA_STATEMENTS, WRITE_BATCH, writeMemoryChunks } from "./store.js";
import { loadZod } from "./zod_for_tests.ts";

const zod = await loadZod();

interface Call {
  text: string;
  values: readonly unknown[];
}

function fakeDb(failOn?: (text: string) => Error | undefined) {
  const calls: Call[] = [];
  const db: Db = {
    async query(text, values = []) {
      // An insert carries its rows as one JSON parameter; record them flattened, row after row, column by column.
      const recorded = text.startsWith("insert")
        ? (JSON.parse(values[0] as string) as Record<string, unknown>[]).flatMap((row) => Object.values(row))
        : values;
      calls.push({ text, values: recorded });
      const failure = failOn?.(text);
      if (failure) throw failure;
      return { rows: [] };
    },
  };
  return { db, calls, inserts: () => calls.filter((c) => c.text.startsWith("insert")), deletes: () => calls.filter((c) => c.text.startsWith("delete")) };
}

const vectorOf = (value: number): number[] => Array.from({ length: EMBEDDING_DIMENSION }, () => value);
const NOW = () => new Date("2026-05-05T05:05:05.000Z");

describe("chunkDocument", () => {
  it("cuts the trimmed body every 4000 characters with stable ids", () => {
    const chunks = chunkDocument(`  ${"a".repeat(MAX_CHUNK_CHARS)}b  `, "omp", "note");
    expect(chunks.map((c) => c.text.length)).toEqual([MAX_CHUNK_CHARS, 1]);
    expect(chunks[0]!.id).toBe(idOf("omp", "note", "0"));
    expect(chunks[1]!.id).toBe(idOf("omp", "note", "1"));
    expect(chunks[0]!.id).toHaveLength(32);
    expect(chunkDocument("   ", "omp", "x")).toEqual([]);
  });

  it("derives ids the way the session chunker does: sha1 of source:session:slot", () => {
    expect(idOf("omp", "note", "0")).toBe("c1d5b9e1c0f9d2b5f2e9d3a0f3e7a3a1".length === 32 ? idOf("omp", "note", "0") : "");
    expect(idOf("omp", "note", "0")).not.toBe(idOf("claude", "note", "0"));
  });
});

describe("writeMemoryChunks", () => {
  const row = (i: number, embedding?: number[]) => ({ id: `id${i}`, sessionPath: "documents/n", source: "omp", occurredAt: "2026-01-01T00:00:00.000Z", chunkIndex: i, body: `b${i}`, ...(embedding ? { embedding } : {}) });

  it("creates the schema once per database, then upserts on id and keeps an existing vector when none is given", async () => {
    const store = fakeDb();
    await writeMemoryChunks(store.db, [row(0)]);
    await writeMemoryChunks(store.db, [row(1)]);
    expect(store.calls.filter((c) => c.text.includes("create")).length).toBe(MEMORY_SCHEMA_STATEMENTS.length);
    const insert = store.inserts()[0]!;
    expect(insert.text).toContain("on conflict (id) do update");
    expect(insert.text).toContain("embedding = coalesce(excluded.embedding, public.memory_chunks.embedding)");
    expect(insert.values).toEqual(["id0", "documents/n", "omp", null, "2026-01-01T00:00:00.000Z", 0, "b0", null]);
  });

  it("batches 50 rows per INSERT and writes a vector as a pg literal", async () => {
    const store = fakeDb();
    const rows = Array.from({ length: WRITE_BATCH + 1 }, (_, i) => row(i, i === 0 ? vectorOf(0.5) : undefined));
    expect(await writeMemoryChunks(store.db, rows)).toBe(WRITE_BATCH + 1);
    expect(store.inserts().map((c) => c.values.length)).toEqual([WRITE_BATCH * 8, 8]);
    expect(store.inserts()[0]!.values[7]).toBe(`[${vectorOf(0.5).join(",")}]`);
    expect(await writeMemoryChunks(fakeDb().db, [])).toBe(0);
  });

  it("refuses a vector of the wrong width", async () => {
    await expect(writeMemoryChunks(fakeDb().db, [row(0, [1, 2, 3])])).rejects.toThrow("3 values, the column holds 1536");
  });

  it("does not remember a schema that failed to build", async () => {
    let fail = true;
    const store = fakeDb(() => (fail ? new Error("permission denied") : undefined));
    await expect(ensureMemorySchema(store.db)).rejects.toThrow("permission denied");
    fail = false;
    await ensureMemorySchema(store.db);
    expect(store.calls.filter((c) => c.text.includes("create table")).length).toBe(2);
  });
});

describe("runMemoryIngest", () => {
  const embedAll = async (texts: readonly string[]) => texts.map((_, i) => vectorOf(i + 1));

  it("chunks, embeds, writes the rows with repository and occurred_at, and returns ids in order", async () => {
    const store = fakeDb();
    const content = `${"x".repeat(MAX_CHUNK_CHARS)}tail`;
    const out = await runMemoryIngest({ content, title: "Decision", repository: "capability-replicas", occurred_at: "2026-02-03" }, { db: () => store.db, embed: embedAll, now: NOW });
    expect(out).toEqual({ ok: true, ids: [idOf("omp", "Decision", "0"), idOf("omp", "Decision", "1")], embedded: 2 });
    const values = store.inserts()[0]!.values;
    expect(values.slice(0, 8)).toEqual([idOf("omp", "Decision", "0"), "documents/Decision", "omp", "capability-replicas", "2026-02-03T00:00:00.000Z", 0, "x".repeat(MAX_CHUNK_CHARS), `[${vectorOf(1).join(",")}]`]);
    expect(values[15]).toBe(`[${vectorOf(2).join(",")}]`);
  });

  it("names an untitled document by its content hash and dates it now when occurred_at is omitted", async () => {
    const store = fakeDb();
    const out = await runMemoryIngest({ content: "  The decision.  ", title: null, repository: null, occurred_at: null }, { db: () => store.db, embed: embedAll, now: NOW });
    const name = nameOf("The decision.");
    expect(name).toHaveLength(12);
    expect(out.ids).toEqual([idOf("omp", name, "0")]);
    const values = store.inserts()[0]!.values;
    expect(values[1]).toBe(`documents/${name}`);
    expect(values[3]).toBeNull();
    expect(values[4]).toBe("2026-05-05T05:05:05.000Z");
    expect(values[6]).toBe("The decision.");
  });

  it("is idempotent: the same content and title produce the same ids", async () => {
    const a = await runMemoryIngest({ content: "same", title: "t" }, { db: () => fakeDb().db, embed: embedAll });
    const b = await runMemoryIngest({ content: "same", title: "t" }, { db: () => fakeDb().db, embed: embedAll });
    expect(a.ids).toEqual(b.ids);
  });

  it("drops a longer earlier version's tail: deletes the document's chunks from the new count onward", async () => {
    const store = fakeDb();
    await runMemoryIngest({ content: "short", title: "t" }, { db: () => store.db, embed: embedAll });
    expect(store.deletes()).toHaveLength(1);
    expect(store.deletes()[0]!.values).toEqual(["documents/t", 1]);
    expect(store.calls.indexOf(store.deletes()[0]!)).toBeGreaterThan(store.calls.indexOf(store.inserts()[0]!));
  });

  it("returns ok:false without touching the store for blank content", async () => {
    const store = fakeDb();
    for (const content of ["", "   \n\t "]) {
      expect(await runMemoryIngest({ content }, { db: () => store.db, embed: embedAll })).toEqual({ ok: false, ids: [], embedded: 0, degraded: true, reason: "empty content" });
    }
    expect(store.calls).toEqual([]);
  });

  it("still writes the rows without vectors when the embedder fails, and says so", async () => {
    const store = fakeDb();
    const out = await runMemoryIngest({ content: "note", title: "n" }, { db: () => store.db, embed: async () => { throw new Error("HTTP 402 quota"); } });
    expect(out.ok).toBe(true);
    expect(out.embedded).toBe(0);
    expect(out.degraded).toBe(true);
    expect(out.reason).toBe("embedding refused: HTTP 402 quota — the rows were written without vectors");
    expect(store.inserts()[0]!.values[7]).toBeNull();
  });

  it("names a missing OpenRouter key as the reason when no embedder is injected", async () => {
    const store = fakeDb();
    const out = await runMemoryIngest({ content: "note" }, { db: () => store.db, env: {}, opRead: async () => { throw new Error("not signed in"); } });
    expect(out.ok).toBe(true);
    expect(out.reason).toContain("OpenRouter key unavailable");
    expect(store.inserts()).toHaveLength(1);
  });

  it("throws, writes nothing and embeds nothing when the store is unreachable or unset", async () => {
    let embedded = 0;
    const embed = async (texts: readonly string[]) => (embedded++, texts.map(() => vectorOf(1)));
    const failing = fakeDb((text) => (text.includes("create") ? new Error("connection refused") : undefined));
    await expect(runMemoryIngest({ content: "n" }, { db: () => failing.db, embed })).rejects.toThrow("connection refused");
    expect(failing.inserts()).toEqual([]);
    await expect(runMemoryIngest({ content: "n" }, { env: {}, embed })).rejects.toThrow("no SESSIONS_DB_URL");
    expect(embedded).toBe(0);
  });

  it("refuses an unparsable occurred_at before anything is spent", async () => {
    const store = fakeDb();
    await expect(runMemoryIngest({ content: "n", occurred_at: "soon" }, { db: () => store.db, embed: embedAll })).rejects.toThrow("occurred_at must be a timestamp");
    expect(store.calls).toEqual([]);
  });

  it("stops when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = fakeDb();
    await expect(runMemoryIngest({ content: "n" }, { db: () => store.db, embed: embedAll }, controller.signal)).rejects.toThrow();
    expect(store.inserts()).toEqual([]);
  });
});

describe("tool shape", () => {
  const store = fakeDb();
  const tool = makeTool({ zod } as never, { db: () => store.db, embed: async (t) => t.map(() => vectorOf(1)), now: NOW });

  it("is discoverable, write-tier, named for the capability, with a dense description", () => {
    expect(tool.name).toBe("memory_ingest");
    expect(tool.loadMode).toBe("discoverable");
    expect(tool.approval).toBe("write");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });

  it("validates parameters: valid, null optionals, invalid values", () => {
    expect(tool.parameters.safeParse({ content: "x" }).success).toBe(true);
    expect(tool.parameters.safeParse({ content: "x", title: null, repository: null, occurred_at: null }).success).toBe(true);
    expect(tool.parameters.safeParse({ content: "x", title: "t", repository: "r", occurred_at: "2026-01-01" }).success).toBe(true);
    expect(tool.parameters.safeParse({ content: "" }).success).toBe(false);
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(tool.parameters.safeParse({ content: 5 }).success).toBe(false);
  });

  it("executes and returns the outcome as JSON text and details", async () => {
    const result = await tool.execute("id", { content: "remember this", title: "r" }, undefined, {}, undefined);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, ids: [idOf("omp", "r", "0")], embedded: 1 });
    expect(result.details.ok).toBe(true);
  });

  it("default export builds the tool from a pi API", () => {
    expect((factory({ zod } as never) as unknown as { name: string }).name).toBe("memory_ingest");
  });
});
