import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Embeddings for orient's code retrieval: an OpenRouter embeddings client, and an index that embeds each chunk and
 * each query once. A vector is cached in memory and on disk under a hash of (model, text), so a repeated call re-embeds
 * only what changed; a changed chunk or a new model is a new key. The embedder reads `OPENROUTER_API_KEY` from the
 * environment and nowhere else; without it the index fails and retrieval falls back to keywords, saying why.
 *
 * Model `openai/text-embedding-3-small` through OpenRouter's `/api/v1/embeddings`: 1536 dimensions, 8192-token input.
 */

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

/** Texts per embeddings request. */
const EMBED_BATCH_SIZE = 96;
/** Requests in flight together when a cold repository needs several batches. */
const EMBED_CONCURRENCY = 4;
const EMBED_TIMEOUT_MS = 30_000;
const ERROR_BODY_CHARS = 200;
const VECTOR_FILE_EXTENSION = ".f32";
const TEMP_FILE_EXTENSION = ".tmp";
const BYTES_PER_FLOAT = 4;
/** Reciprocal rank fusion's damping constant. */
const RRF_K = 60;

/** `fetch` as the embedder uses it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Vectors for the texts, in order. Throws when it cannot embed them all. */
export type Embedder = (texts: readonly string[]) => Promise<number[][]>;

export interface EmbeddingModel {
  /** Part of every cache key: vectors of two models are never mixed. */
  readonly id: string;
  readonly embed: Embedder;
}

export interface OpenRouterEmbedderOptions {
  readonly model?: string;
  /** The API key, read at each request. Defaults to `OPENROUTER_API_KEY` in the environment. */
  readonly getApiKey?: () => string | undefined;
  readonly fetch?: Fetch;
  readonly url?: string;
  readonly signal?: AbortSignal;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

type EmbeddingsBody = { data?: Array<{ index?: number; embedding?: unknown }> };

function vectorsOf(body: EmbeddingsBody, expected: number, model: string): number[][] {
  const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== expected) {
    throw new Error(`embeddings from ${model}: asked for ${expected} vectors, received ${rows.length}`);
  }
  return rows.map((row) => {
    const vector = row.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === "number")) {
      throw new Error(`embeddings from ${model}: a row has no numeric vector`);
    }
    return vector as number[];
  });
}

/** The key the environment holds, or "" when it is unset or is a 1Password reference this tool does not resolve. */
export function environmentKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[OPENROUTER_KEY_ENV]?.trim() ?? "";
  return key.startsWith("op://") ? "" : key;
}

/** An embedder on OpenRouter. A refused or failed request throws with the status and the start of the body. */
export function openRouterEmbedder(options: OpenRouterEmbedderOptions = {}): EmbeddingModel {
  const model = options.model ?? EMBEDDING_MODEL;
  const send = options.fetch ?? fetch;
  const url = options.url ?? OPENROUTER_EMBEDDINGS_URL;

  async function requestBatch(batch: readonly string[]): Promise<number[][]> {
    const key = (options.getApiKey ?? environmentKey)()?.trim() ?? "";
    if (key === "") throw new Error(`${OPENROUTER_KEY_ENV} is not set`);
    const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    const response = await send(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: batch }),
      signal: options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_CHARS);
      throw new Error(`embeddings request to ${model} failed: HTTP ${response.status} ${text}`);
    }
    return vectorsOf((await response.json()) as EmbeddingsBody, batch.length, model);
  }

  return {
    id: model,
    embed: async (texts) => {
      const batches = chunksOf(texts, EMBED_BATCH_SIZE);
      const vectors: number[][] = [];
      for (const wave of chunksOf(batches, EMBED_CONCURRENCY)) {
        for (const result of await Promise.all(wave.map(requestBatch))) vectors.push(...result);
      }
      return vectors;
    },
  };
}

/** `~/.omp/agent/cache/orient/embeddings`: never in the repository being searched. */
export function embeddingsDir(home: string = homedir()): string {
  return join(home, ".omp", "agent", "cache", "orient", "embeddings");
}

export interface DocumentVectors {
  readonly vectors: Float32Array[];
  /** How many texts the embedder was asked for: zero when memory and disk had every one. */
  readonly embedded: number;
  /** A cache write that failed. The vectors are still good; the next process embeds them again. */
  readonly notes: string[];
}

export interface EmbeddingIndex {
  /** The vector of one query: memory, then disk, then one embedder call whose vector is stored. */
  embedQuery(text: string): Promise<Float32Array>;
  /** Vectors of documents, in order: memory, then disk, then the embedder for what neither has. */
  embedDocuments(texts: readonly string[]): Promise<DocumentVectors>;
}

export interface EmbeddingIndexOptions {
  readonly model: EmbeddingModel;
  readonly dir: string;
}

function hashOf(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex");
}

function floatsOf(buffer: Buffer): Float32Array | undefined {
  if (buffer.byteLength === 0 || buffer.byteLength % BYTES_PER_FLOAT !== 0) return undefined;
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

async function readVector(file: string): Promise<Float32Array | undefined> {
  try {
    return floatsOf(await readFile(file));
  } catch {
    return undefined;
  }
}

/** Write-tmp-then-rename in the same directory, so a reader never sees half a vector and no lock is needed. */
async function writeVector(file: string, vector: Float32Array): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString("hex")}${TEMP_FILE_EXTENSION}`;
  await writeFile(temp, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  await rename(temp, file);
}

export function createEmbeddingIndex({ model, dir }: EmbeddingIndexOptions): EmbeddingIndex {
  const memory = new Map<string, Float32Array>();
  // Concurrent calls embedding the same cold repository would pay for it twice; one at a time, the second finds it all.
  let queue: Promise<unknown> = Promise.resolve();

  async function embedMissing(texts: readonly string[]): Promise<Float32Array[]> {
    const vectors = await model.embed(texts);
    if (vectors.length !== texts.length) {
      throw new Error(`embedder ${model.id} returned ${vectors.length} vectors for ${texts.length} texts`);
    }
    const first = vectors[0]?.length;
    if (vectors.some((vector) => vector.length !== first)) {
      throw new Error(`embedder ${model.id} returned vectors of different lengths`);
    }
    return vectors.map((vector) => Float32Array.from(vector));
  }

  async function documents(texts: readonly string[]): Promise<DocumentVectors> {
    const keys = texts.map((text) => hashOf(model.id, text));
    const wanted = [...new Set(keys)].filter((key) => !memory.has(key));
    const onDisk = await Promise.all(wanted.map((key) => readVector(join(dir, `${key}${VECTOR_FILE_EXTENSION}`))));
    const missing: string[] = [];
    wanted.forEach((key, at) => {
      const vector = onDisk[at];
      if (vector === undefined) missing.push(key);
      else memory.set(key, vector);
    });
    const notes: string[] = [];
    if (missing.length > 0) {
      const textOf = new Map(keys.map((key, at) => [key, texts[at] as string]));
      const embedded = await embedMissing(missing.map((key) => textOf.get(key) as string));
      missing.forEach((key, at) => memory.set(key, embedded[at] as Float32Array));
      try {
        await mkdir(dir, { recursive: true });
        await Promise.all(
          missing.map((key, at) => writeVector(join(dir, `${key}${VECTOR_FILE_EXTENSION}`), embedded[at] as Float32Array)),
        );
      } catch (error) {
        notes.push(`embedding cache not written to ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { vectors: keys.map((key) => memory.get(key) as Float32Array), embedded: missing.length, notes };
  }

  return {
    embedQuery: async (text) => {
      const { vectors } = await documents([text]);
      return vectors[0] as Float32Array;
    },
    embedDocuments: (texts) => {
      const run = queue.then(() => documents(texts));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let at = 0; at < a.length; at += 1) {
    const x = a[at] as number;
    const y = b[at] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * Reciprocal rank fusion: an item's score is the sum of 1 / (k + rank) over the lists that rank it. Each list counts
 * only its first `limit` items, so an item far down the embedding order earns nothing from it. A tie goes to the earlier
 * list (the embedding order comes first), then to that list's order.
 */
export function reciprocalRankFusion<T>(rankings: ReadonlyArray<readonly T[]>, limit: number): T[] {
  const scores = new Map<T, number>();
  for (const ranking of rankings) {
    ranking.slice(0, limit).forEach((doc, rank) => scores.set(doc, (scores.get(doc) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...scores]
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .slice(0, limit)
    .map(([doc]) => doc);
}
