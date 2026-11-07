import { openRouterKey, type OpRead } from "./openrouter_key.js";

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
/** The column's width: `text-embedding-3-small`. */
export const EMBEDDING_DIMENSION = 1536;
export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

/** Texts per request, and requests in flight together. */
const EMBED_BATCH_SIZE = 96;
const EMBED_CONCURRENCY = 4;
const EMBED_TIMEOUT_MS = 30_000;
const ERROR_BODY_CHARS = 200;

/** Vectors for the texts, in order; throws when it cannot embed them all. */
export type Embedder = (texts: readonly string[], signal?: AbortSignal) => Promise<number[][]>;

export interface EmbedderOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  opRead?: OpRead;
  url?: string;
  model?: string;
}

const chunksOf = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

function vectorsOf(body: { data?: { index?: number; embedding?: unknown }[] }, expected: number, model: string): number[][] {
  const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== expected) throw new Error(`embeddings from ${model}: asked for ${expected} vectors, received ${rows.length}`);
  return rows.map((row) => {
    const vector = row.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === "number")) {
      throw new Error(`embeddings from ${model}: a row has no numeric vector`);
    }
    if (vector.length !== EMBEDDING_DIMENSION) {
      throw new Error(`embeddings from ${model}: ${vector.length} values, the column holds ${EMBEDDING_DIMENSION}`);
    }
    return vector as number[];
  });
}

/** An embedder on OpenRouter's `/api/v1/embeddings`; a refused or failed request throws with the status and the start of the body. */
export function openRouterEmbedder(options: EmbedderOptions = {}): Embedder {
  const model = options.model ?? EMBEDDING_MODEL;
  const send = options.fetch ?? globalThis.fetch;
  const url = options.url ?? OPENROUTER_EMBEDDINGS_URL;

  async function requestBatch(batch: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const key = (await openRouterKey(options.env ?? process.env, options.opRead)).trim();
    if (key === "") throw new Error("OPENROUTER_API_KEY is not set");
    const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    const response = await send(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: batch }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_CHARS);
      throw new Error(`embeddings request to ${model} failed: HTTP ${response.status} ${text}`);
    }
    return vectorsOf((await response.json()) as { data?: { index?: number; embedding?: unknown }[] }, batch.length, model);
  }

  return async (texts, signal) => {
    const vectors: number[][] = [];
    for (const wave of chunksOf(chunksOf(texts, EMBED_BATCH_SIZE), EMBED_CONCURRENCY)) {
      for (const result of await Promise.all(wave.map((batch) => requestBatch(batch, signal)))) vectors.push(...result);
    }
    return vectors;
  };
}
