import { annotateTranscript, writeAnnotated } from "./annotated.js";
import type { TurnSource } from "./reader/turn_source.js";
import { type Format, type SessionExport, type Source, itemsOf, loadTranscript } from "./session_export.js";

/** Sources read at once. */
export const TRANSCRIPT_CONCURRENCY = 4;

export interface AnnotatedSession {
  /** `<harness>:<id>` of the session. */
  conversation: string;
  /** The annotated export on disk. */
  path: string;
  /** Where the raw transcript came from, when the export says. */
  source: string | null;
  turns: number;
  items: number;
  /** Items that carry a `correction: true` annotation. */
  corrections: number;
  /** Items the annotator flagged as wasted (denied or failed tool calls). */
  wasted: number;
  /** Sum of the items' recorded token counts and estimated USD; null when the transcript records no usage. */
  tokens: { in: number; out: number; cache_read: number; cache_write: number } | null;
  est_usd: number | null;
  /** True when every item was already annotated and the export passed through unchanged. */
  already_annotated: boolean;
}

/**
 * Runs `work` over `items` with at most `limit` in flight; results keep the order of `items`. The first failure rejects
 * the whole call and no item that has not started is started afterwards.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** One export read by the annotator; an export whose every item is already read passes through. */
export async function annotateSource(
  source: Source,
  format: Format,
  transcripts: TurnSource,
): Promise<{ session: SessionExport; path: string; already: boolean }> {
  const session = await loadTranscript(source, transcripts);
  const already = itemsOf(session).every((item) => item.annotation !== undefined);
  const annotated = already ? session : await annotateTranscript(session, format);
  const path = await writeAnnotated(annotated);
  return { session: annotated, path, already };
}

export function summaryOf(session: SessionExport, path: string, already: boolean): AnnotatedSession {
  const items = itemsOf(session);
  let corrections = 0;
  let wasted = 0;
  let recorded = false;
  const tokens = { in: 0, out: 0, cache_read: 0, cache_write: 0 };
  let usd = 0;
  let priced = false;
  for (const item of items) {
    const annotation = item.annotation;
    if (annotation === undefined) continue;
    if (annotation.correction) corrections += 1;
    if (annotation.waste !== undefined) wasted += 1;
    if (annotation.tokens !== undefined) {
      recorded = true;
      tokens.in += annotation.tokens.in;
      tokens.out += annotation.tokens.out;
      tokens.cache_read += annotation.tokens.cache_read;
      tokens.cache_write += annotation.tokens.cache_write;
    }
    if (annotation.est_usd !== undefined) {
      priced = true;
      usd += annotation.est_usd;
    }
  }
  return {
    conversation: session.conversation,
    path,
    source: session.source ?? null,
    turns: session.turns.length,
    items: items.length,
    corrections,
    wasted,
    tokens: recorded ? tokens : null,
    est_usd: priced ? Math.round(usd * 1_000_000) / 1_000_000 : null,
    already_annotated: already,
  };
}

/** Annotates every source, four at a time, and writes each export; a source that cannot be read fails the whole call. */
export async function annotateSources(
  sources: readonly Source[],
  format: Format,
  transcripts: TurnSource,
): Promise<AnnotatedSession[]> {
  return mapLimit(sources, TRANSCRIPT_CONCURRENCY, async (source) => {
    const { session, path, already } = await annotateSource(source, format, transcripts);
    return summaryOf(session, path, already);
  });
}
