import { beforeEach, describe, expect, it } from "bun:test";
import { bunDb, type Db, sessionsDbUrl } from "./db.js";
import { EMBEDDING_DIMENSION, openRouterEmbedder } from "./embed.js";
import factory, { DESCRIPTION, isoInstant, makeTool, runMemorySearch } from "./index.js";
import { resetCachedKey } from "./openrouter_key.js";
import { ARM_DEPTH, EVIDENCE_CHARS, fuseByReciprocalRank, recallMemory, RRF_K, termsOf } from "./search.js";
import { loadZod } from "./zod_for_tests.ts";

const zod = await loadZod();

interface Call {
  text: string;
  values: readonly unknown[];
}

const row = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  session_path: `/sessions/${id}.jsonl`,
  source: "omp",
  repository: "capability-replicas",
  occurred_at: new Date(at),
  chunk_index: 0,
  body: `body of ${id}`,
  ...extra,
});

/** A fake store: the BM25 query returns `bm25`, the vector query `vector`; either may be an Error to throw. */
function fakeDb(bm25: unknown[] | Error, vector: unknown[] | Error) {
  const calls: Call[] = [];
  const db: Db = {
    async query(text, values = []) {
      calls.push({ text, values });
      const answer = text.includes("to_bm25query") ? bm25 : vector;
      if (answer instanceof Error) throw answer;
      return { rows: answer as Record<string, unknown>[] };
    },
  };
  return { db, calls, bm25Call: () => calls.find((c) => c.text.includes("to_bm25query")), vectorCall: () => calls.find((c) => c.text.includes("<=>")) };
}

const vectorOf = (value: number): number[] => Array.from({ length: EMBEDDING_DIMENSION }, () => value);

describe("termsOf", () => {
  it("OR's the lexemes, drops one-letter words, dedupes, and escapes quotes", () => {
    expect(termsOf("What did we decide about the memory backend?")).toBe("'what' | 'did' | 'we' | 'decide' | 'about' | 'the' | 'memory' | 'backend'");
    expect(termsOf("a I x 7 foo.bar. Foo")).toBe("'7' | 'foo.bar' | 'foo'");
    expect(termsOf("???")).toBe("");
  });

  it("carries at most 24 terms", () => {
    const query = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");
    expect(termsOf(query).split(" | ")).toHaveLength(24);
  });
});

describe("fuseByReciprocalRank", () => {
  it("scores 1/(k+rank) per arm so two arms agreeing beat one arm's top hit", () => {
    const fused = fuseByReciprocalRank([["a", "b"], ["b", "c"]]);
    expect(fused.get("a")).toBeCloseTo(1 / (RRF_K + 1));
    expect(fused.get("b")).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect([...fused.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe("b");
  });
});

describe("recallMemory", () => {
  it("fuses both arms, ranks agreement first, and cites session, instant and repository", async () => {
    const store = fakeDb([row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-02T00:00:00Z", { repository: null })], [row("b", "2026-01-02T00:00:00Z", { repository: null }), row("c", "2026-01-03T00:00:00Z")]);
    const out = await recallMemory({ query: "memory backend" }, { db: store.db, embed: async () => [vectorOf(0.1)] });
    expect(out.arms).toEqual({ bm25: { used: true, count: 2 }, vector: { used: true, count: 2 } });
    expect(out.degraded).toBeUndefined();
    expect(out.evidence.map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(out.evidence[1]).toEqual({ id: "a", score: Number((1 / 61).toFixed(6)), source: "omp", session: "/sessions/a.jsonl", at: "2026-01-01T00:00:00.000Z", repository: "capability-replicas", text: "body of a" });
    expect("repository" in out.evidence[0]!).toBe(false);
    expect(store.bm25Call()?.values[0]).toBe("'memory' | 'backend'");
    expect(store.vectorCall()?.values.at(-1)).toBe(`[${vectorOf(0.1).join(",")}]`);
  });

  it("filters both arms by repository and as_of with the right placeholders, and orders newest first under as_of", async () => {
    const store = fakeDb([row("old", "2026-01-01T00:00:00Z"), row("new", "2026-01-05T00:00:00Z")], []);
    const out = await recallMemory({ query: "x1 y2", repository: "repo", asOf: "2026-02-01T00:00:00.000Z", limit: 1 }, { db: store.db });
    expect(store.bm25Call()?.text).toContain("repository = $2 and occurred_at <= $3::timestamptz");
    expect(store.bm25Call()?.values).toEqual(["'x1' | 'y2'", "repo", "2026-02-01T00:00:00.000Z"]);
    expect(out.evidence.map((e) => e.id)).toEqual(["new"]);
    store.calls.length = 0;
    await recallMemory({ query: "foo bar", repository: "repo", asOf: "2026-02-01T00:00:00.000Z" }, { db: store.db, embed: async () => [vectorOf(0)] });
    expect(store.vectorCall()?.text).toContain("repository = $1 and occurred_at <= $2::timestamptz");
    expect(store.vectorCall()?.text).toContain("order by embedding <=> $3::vector");
  });

  it("reads each arm at least ARM_DEPTH deep and never more than limit chunks come back", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`, "2026-01-01T00:00:00Z"));
    const store = fakeDb(rows, []);
    const out = await recallMemory({ query: "foo bar", limit: 5 }, { db: store.db });
    expect(store.bm25Call()?.text).toContain(`limit ${ARM_DEPTH}`);
    expect(out.evidence).toHaveLength(5);
  });

  it("answers lexically and names why when there is no embedder, or the embedder fails", async () => {
    const lexical = fakeDb([row("a", "2026-01-01T00:00:00Z")], []);
    const none = await recallMemory({ query: "foo bar" }, { db: lexical.db, embedderFailure: "OpenRouter key unavailable" });
    expect(none.arms.vector).toEqual({ used: false, count: 0, reason: "the vector arm did not run: OpenRouter key unavailable" });
    expect(none.evidence).toHaveLength(1);
    expect(none.degraded).toBeUndefined();

    const keyless = await recallMemory({ query: "foo bar" }, { db: lexical.db });
    expect(keyless.arms.vector.reason).toBe("no embedding provider in this process: the vector arm did not run");

    const refused = await recallMemory({ query: "foo bar" }, { db: lexical.db, embed: async () => { throw new Error("HTTP 429"); } });
    expect(refused.arms.vector.reason).toBe("the vector arm did not run: HTTP 429");
    expect(refused.evidence).toHaveLength(1);

    const short = await recallMemory({ query: "foo bar" }, { db: lexical.db, embed: async () => [[1, 2, 3]] });
    expect(short.arms.vector.reason).toContain("no usable vector");
  });

  it("keeps the other arm when one arm's query fails, and is degraded only when none ran", async () => {
    const half = fakeDb(new Error("index missing"), [row("v", "2026-01-01T00:00:00Z")]);
    const out = await recallMemory({ query: "foo bar" }, { db: half.db, embed: async () => [vectorOf(1)] });
    expect(out.arms.bm25).toEqual({ used: false, count: 0, reason: "index missing" });
    expect(out.arms.vector.used).toBe(true);
    expect(out.degraded).toBeUndefined();
    expect(out.evidence.map((e) => e.id)).toEqual(["v"]);

    const none = fakeDb(new Error('relation "public.memory_chunks" does not exist'), new Error("same"));
    const dead = await recallMemory({ query: "foo bar" }, { db: none.db, embed: async () => [vectorOf(1)] });
    expect(dead.degraded).toBe(true);
    expect(dead.reason).toBe('relation "public.memory_chunks" does not exist');
    expect(dead.evidence).toEqual([]);
  });

  it("answers an unreachable store, a blank query and a query with no searchable term as named empty results", async () => {
    const noStore = await recallMemory({ query: "foo" }, { storeFailure: "no SESSIONS_DB_URL: the session store's connection string is not set in this process" });
    expect(noStore.degraded).toBe(true);
    expect(noStore.arms.bm25.reason).toContain("no SESSIONS_DB_URL");
    const blank = await recallMemory({ query: "   " }, { db: fakeDb([], []).db });
    expect(blank).toMatchObject({ degraded: true, reason: "empty query", evidence: [] });
    const symbols = await recallMemory({ query: "???" }, { db: fakeDb([], []).db });
    expect(symbols.arms.bm25).toEqual({ used: false, count: 0, reason: "no searchable term in the query" });
    expect(symbols.degraded).toBe(true);
  });

  it("cuts a chunk longer than the evidence ceiling and marks the cut", async () => {
    const store = fakeDb([row("long", "2026-01-01T00:00:00Z", { body: "x".repeat(EVIDENCE_CHARS + 50) })], []);
    const out = await recallMemory({ query: "foo bar" }, { db: store.db });
    expect(out.evidence[0]!.text).toBe(`${"x".repeat(EVIDENCE_CHARS)}…`);
  });

  it("stops when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(recallMemory({ query: "foo bar" }, { db: fakeDb([], []).db, signal: controller.signal })).rejects.toThrow();
  });

  it("accepts a timestamp the driver hands back as a string", async () => {
    const store = fakeDb([row("s", "2026-01-01T00:00:00Z", { occurred_at: "2026-01-01 00:00:00+00" })], []);
    expect((await recallMemory({ query: "foo bar" }, { db: store.db })).evidence[0]!.at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("runMemorySearch", () => {
  const embed = async () => [vectorOf(0.2)];

  it("refuses an empty query, an out-of-range limit and an unparsable as_of", async () => {
    const db = () => fakeDb([], []).db;
    await expect(runMemorySearch({ query: "" }, { db, embed })).rejects.toThrow("an empty query is refused");
    await expect(runMemorySearch({ query: "x", limit: 0 }, { db, embed })).rejects.toThrow("limit must be an integer from 1 to 50");
    await expect(runMemorySearch({ query: "x", limit: 51 }, { db, embed })).rejects.toThrow("limit must be an integer");
    await expect(runMemorySearch({ query: "x", as_of: "yesterday-ish" }, { db, embed })).rejects.toThrow("as_of must be a timestamp");
  });

  it("treats null optional fields as omitted and normalizes as_of to an ISO instant", async () => {
    const store = fakeDb([], []);
    await runMemorySearch({ query: "foo bar", limit: null, repository: null, as_of: null }, { db: () => store.db, embed });
    expect(store.bm25Call()?.values).toEqual(["'foo' | 'bar'"]);
    store.calls.length = 0;
    await runMemorySearch({ query: "foo bar", as_of: "2026-03-01" }, { db: () => store.db, embed });
    expect(store.bm25Call()?.values[1]).toBe("2026-03-01T00:00:00.000Z");
    expect(isoInstant("2026-03-01T01:00:00+01:00", "as_of")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns a named empty result, not a throw, when SESSIONS_DB_URL is unset", async () => {
    const out = await runMemorySearch({ query: "foo bar" }, { env: {}, embed });
    expect(out.degraded).toBe(true);
    expect(out.reason).toContain("no SESSIONS_DB_URL");
  });

  it("names a missing embedding key as the vector arm's reason while BM25 still answers", async () => {
    resetCachedKey();
    const store = fakeDb([row("a", "2026-01-01T00:00:00Z")], []);
    const out = await runMemorySearch({ query: "foo bar" }, { db: () => store.db, env: {}, opRead: async () => { throw new Error("not signed in"); } });
    resetCachedKey();
    expect(out.evidence).toHaveLength(1);
    expect(out.arms.vector.reason).toContain("OpenRouter key unavailable");
  });
});

describe("sessionsDbUrl", () => {
  it("strips -pooler from the host, both spellings, and refuses a missing URL", () => {
    expect(sessionsDbUrl({ SESSIONS_DB_URL: "postgresql://u:p@ep-x-pooler.c-4.us-west-2.aws.neon.tech/omp?sslmode=require" })).toBe("postgresql://u:p@ep-x.c-4.us-west-2.aws.neon.tech/omp?sslmode=require");
    expect(new URL(sessionsDbUrl({ SESSIONS_DB_URL: "postgresql://u:p@host-pooler/omp" })).hostname).toBe("host");
    expect(() => sessionsDbUrl({})).toThrow("no SESSIONS_DB_URL");
    expect(() => sessionsDbUrl({ SESSIONS_DB_URL: "  " })).toThrow("no SESSIONS_DB_URL");
  });
});

describe("bunDb", () => {
  const client = (urls: string[], onQuery: (url: string) => unknown) => (url: string) => {
    urls.push(url);
    return { unsafe: async () => onQuery(url) as never, close: async () => {} };
  };

  it("passes the statement and values through and returns plain rows", async () => {
    const seen: unknown[][] = [];
    const db = bunDb("postgres://h/db", () => ({ unsafe: (async (text: string, values: unknown[]) => (seen.push([text, values]), Object.assign([{ a: 1 }], { count: 1 }))) as never, close: async () => {} }));
    expect(await db.query("select $1", [5])).toEqual({ rows: [{ a: 1 }] });
    expect(seen).toEqual([["select $1", [5]]]);
  });

  it("retries once without channel_binding only when the driver says it cannot honor it", async () => {
    const urls: string[] = [];
    const db = bunDb("postgres://h/db?sslmode=require&channel_binding=require", client(urls, (url) => {
      if (url.includes("channel_binding")) throw new Error("channel binding required, but server authenticated client without channel binding");
      return [{ ok: true }];
    }));
    expect((await db.query("select 1")).rows).toEqual([{ ok: true }]);
    expect(urls).toEqual(["postgres://h/db?sslmode=require&channel_binding=require", "postgres://h/db?sslmode=require"]);
    await db.query("select 2");
    expect(urls).toHaveLength(2);
  });

  it("does not retry other failures", async () => {
    const urls: string[] = [];
    const db = bunDb("postgres://h/db?channel_binding=require", client(urls, () => { throw new Error("password authentication failed"); }));
    await expect(db.query("select 1")).rejects.toThrow("password authentication failed");
    expect(urls).toHaveLength(1);
  });
});

describe("openRouterEmbedder", () => {
  beforeEach(() => resetCachedKey());

  const reply = (n: number, order: number[] = []) => new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: order[i] ?? i, embedding: vectorOf(order[i] ?? i) })) }));

  it("batches 96 texts per request, keeps order by index, and sends the bearer key and model", async () => {
    const bodies: { model: string; input: string[] }[] = [];
    const auth: string[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      auth.push((init.headers as Record<string, string>).Authorization!);
      return reply(bodies.at(-1)!.input.length, [1, 0].slice(0, bodies.at(-1)!.input.length));
    }) as unknown as typeof fetch;
    const embed = openRouterEmbedder({ env: { OPENROUTER_API_KEY: "or-key" }, fetch: fake });
    const texts = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const vectors = await embed(texts);
    expect(vectors).toHaveLength(100);
    expect(bodies.map((b) => b.input.length).sort()).toEqual([4, 96]);
    expect(bodies[0]!.model).toBe("openai/text-embedding-3-small");
    expect(auth[0]).toBe("Bearer or-key");
  });

  it("fails with the status and the start of the body, a wrong count, and a wrong width", async () => {
    const env = { OPENROUTER_API_KEY: "k" };
    const status = openRouterEmbedder({ env, fetch: (async () => new Response("quota exceeded", { status: 402 })) as unknown as typeof fetch });
    await expect(status(["a"])).rejects.toThrow("HTTP 402 quota exceeded");
    const count = openRouterEmbedder({ env, fetch: (async () => reply(0)) as unknown as typeof fetch });
    await expect(count(["a"])).rejects.toThrow("asked for 1 vectors, received 0");
    const width = openRouterEmbedder({ env, fetch: (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }))) as unknown as typeof fetch });
    await expect(width(["a"])).rejects.toThrow("the column holds 1536");
  });

  it("stops when the signal aborts and names a missing key", async () => {
    // Like real fetch: an already-aborted signal rejects at once, a later abort rejects the pending request.
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        if (init.signal?.aborted) reject(new Error("aborted"));
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = openRouterEmbedder({ env: { OPENROUTER_API_KEY: "k" }, fetch: hang })(["a"], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    await expect(openRouterEmbedder({ env: {}, opRead: async () => { throw new Error("nope"); } })(["a"])).rejects.toThrow("OpenRouter key unavailable");
  });
});

describe("tool shape", () => {
  const store = fakeDb([row("a", "2026-01-01T00:00:00Z")], []);
  const tool = makeTool({ zod } as never, { db: () => store.db, embed: async () => [vectorOf(0.3)] });

  it("is essential, read-tier, named for the capability, with a dense description", () => {
    expect(tool.name).toBe("memory_search");
    expect(tool.loadMode).toBe("essential");
    expect(tool.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });

  it("validates parameters: valid, null optionals, invalid values", () => {
    expect(tool.parameters.safeParse({ query: "x" }).success).toBe(true);
    expect(tool.parameters.safeParse({ query: "x", limit: null, repository: null, as_of: null }).success).toBe(true);
    expect(tool.parameters.safeParse({ query: "x", limit: 50, repository: "r", as_of: "2026-01-01" }).success).toBe(true);
    expect(tool.parameters.safeParse({ query: "" }).success).toBe(false);
    expect(tool.parameters.safeParse({ query: "x", limit: 51 }).success).toBe(false);
    expect(tool.parameters.safeParse({ query: "x", limit: 0 }).success).toBe(false);
    expect(tool.parameters.safeParse({ query: "x", limit: 1.5 }).success).toBe(false);
    expect(tool.parameters.safeParse({}).success).toBe(false);
  });

  it("executes and returns the outcome as JSON text and details", async () => {
    const result = await tool.execute("id", { query: "memory backend" }, undefined, {}, undefined);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.evidence[0].id).toBe("a");
    expect(result.details.arms.bm25.used).toBe(true);
  });

  it("default export builds the tool from a pi API", () => {
    expect((factory({ zod } as never) as unknown as { name: string }).name).toBe("memory_search");
  });
});
