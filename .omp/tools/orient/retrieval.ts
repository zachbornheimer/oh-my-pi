import {
  cosine,
  createEmbeddingIndex,
  type EmbeddingIndex,
  embeddingsDir,
  openRouterEmbedder,
  reciprocalRankFusion,
} from "./embeddings.js";
import { identifierParts } from "./terms.js";

/**
 * Stage 1 of orient, the gateway's tool search applied to code: every chunk of the repository ranked by its embedding's
 * cosine with the query and by BM25 over the query's terms, the two fused by reciprocal rank fusion. A range that
 * shares no word with the query still ranks when it means the same thing; an exact identifier still ranks by BM25.
 * Embeddings that cannot be had fall back to BM25 alone and say so. No model judgment happens here.
 */

/** One retrievable range of one file. */
export interface CodeChunk {
  /** Absolute path. */
  readonly path: string;
  /** Repository-relative path, which the embedding and BM25 both see. */
  readonly relative: string;
  readonly start: number;
  readonly end: number;
  /** The range's lines, verbatim. */
  readonly text: string;
}

export interface Retrieved {
  /** Best first. */
  readonly chunks: CodeChunk[];
  readonly method: "fused" | "keyword";
  /** Why the embeddings did not rank, or a cache that could not be written; empty when nothing went wrong. */
  readonly note: string;
}

/** What an embedding is asked to represent: the file's path and the range's code, not its line numbers, so a line inserted above a chunk does not re-embed it. */
const EMBED_LINE_CHARACTERS = 200;
const EMBED_CHARACTERS = 2_000;

export function embeddingTextOf(chunk: CodeChunk): string {
  const code = chunk.text
    .split("\n")
    .map((line) => line.slice(0, EMBED_LINE_CHARACTERS))
    .join("\n");
  return `${chunk.relative}\n${code}`.slice(0, EMBED_CHARACTERS);
}

/** A repository with more chunks than this is ranked by keywords alone: a cold embedding pass over it would be unbounded. */
export const MAX_EMBEDDED_CHUNKS = 20_000;

/** BM25's term-frequency saturation and length normalization: the values the literature and every engine default to. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** How much more an identifier the query names counts than one of its prose words. */
const IDENTIFIER_WEIGHT = 3;

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * The chunk's terms with their counts: each word lower-cased, and an identifier also as its parts, its snake_case and
 * its joined spellings, so `additionalContext`, `additional_context` and `AdditionalContext` meet the same query term.
 */
export function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string): void => {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  };
  for (const word of text.match(WORD) ?? []) {
    const parts = identifierParts(word);
    add(word.toLowerCase());
    if (parts.length < 2) continue;
    for (const part of parts) add(part);
    add(parts.join("_"));
    add(parts.join(""));
  }
  return counts;
}

/** Chunk indexes by BM25 over the query terms, best first; a chunk holding none of them is absent. */
export function bm25Ranking(
  chunks: readonly CodeChunk[],
  counts: readonly Map<string, number>[],
  terms: readonly string[],
  identifiers: readonly string[],
): number[] {
  const weighted = new Map<string, number>(terms.map((term) => [term, 1]));
  for (const identifier of identifiers) weighted.set(identifier, IDENTIFIER_WEIGHT);
  const lengths = counts.map((count) => [...count.values()].reduce((sum, value) => sum + value, 0));
  const average = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  const idf = new Map<string, number>();
  for (const term of weighted.keys()) {
    const holding = counts.filter((count) => count.has(term)).length;
    idf.set(term, Math.log(1 + (chunks.length - holding + 0.5) / (holding + 0.5)));
  }
  return counts
    .map((count, index) => {
      let score = 0;
      for (const [term, weight] of weighted) {
        const frequency = count.get(term) ?? 0;
        if (frequency === 0) continue;
        const norm = BM25_K1 * (1 - BM25_B + BM25_B * ((lengths[index] ?? 0) / average));
        score += weight * (idf.get(term) ?? 0) * (frequency * (BM25_K1 + 1)) / (frequency + norm);
      }
      return { index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((one, other) => other.score - one.score || one.index - other.index)
    .map((entry) => entry.index);
}

/** Chunk indexes by cosine with the query, closest first. */
function cosineRanking(query: Float32Array, vectors: readonly Float32Array[]): number[] {
  return vectors
    .map((vector, index) => ({ index, similarity: cosine(query, vector) }))
    .sort((one, other) => other.similarity - one.similarity || one.index - other.index)
    .map((entry) => entry.index);
}

/** One repository's chunks, prepared once for every query of a run: their term counts, and their vectors when the embedder answers. */
export interface ChunkIndex {
  readonly chunks: readonly CodeChunk[];
  rank(query: string, terms: readonly string[], identifiers: readonly string[], limit: number): Promise<Retrieved>;
}

export async function indexChunks(chunks: readonly CodeChunk[], embeddings: EmbeddingIndex): Promise<ChunkIndex> {
  const counts = chunks.map((chunk) => termCounts(`${chunk.relative}\n${chunk.text}`));
  let vectors: Float32Array[] | undefined;
  let failure = "";
  let notes: string[] = [];
  try {
    if (chunks.length > MAX_EMBEDDED_CHUNKS) {
      throw new Error(`${chunks.length} chunks exceed the ${MAX_EMBEDDED_CHUNKS}-chunk embedding limit`);
    }
    const embedded = await embeddings.embedDocuments(chunks.map(embeddingTextOf));
    vectors = embedded.vectors;
    notes = embedded.notes;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  return {
    chunks,
    async rank(query, terms, identifiers, limit) {
      const keyword = bm25Ranking(chunks, counts, terms, identifiers);
      const keywordOnly = (cause: string): Retrieved => ({
        chunks: keyword.slice(0, limit).map((index) => chunks[index] as CodeChunk),
        method: "keyword",
        note: `embeddings unavailable, keyword retrieval used: ${cause}`,
      });
      if (vectors === undefined) return keywordOnly(failure);
      let queryVector: Float32Array;
      try {
        queryVector = await embeddings.embedQuery(query);
      } catch (error) {
        return keywordOnly(error instanceof Error ? error.message : String(error));
      }
      const fused = reciprocalRankFusion([cosineRanking(queryVector, vectors), keyword], limit);
      return { chunks: fused.map((index) => chunks[index] as CodeChunk), method: "fused", note: notes.join("; ") };
    },
  };
}

/**
 * A code embedding index over OpenRouter, cached on disk in `embeddingsDir()` so a chunk is embedded once per content.
 * `signal` cancels an embeddings request in flight. Without `OPENROUTER_API_KEY` every call fails and `indexChunks`
 * falls back to keyword retrieval, saying why.
 */
export function codeEmbeddingIndex(signal?: AbortSignal): EmbeddingIndex {
  return createEmbeddingIndex({ model: openRouterEmbedder({ signal }), dir: embeddingsDir() });
}
