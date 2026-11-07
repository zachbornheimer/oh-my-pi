import { type Ask, decideNoul } from "./decide.js";
import { mapLimit, type ModelStep } from "./omp_model.js";
import { FILE, PASSAGE } from "./questions.js";
import type { Candidate, FindOutput, Hit, Passage } from "./schemas.js";
import type { ScanResult } from "./scan.js";

/**
 * Semantic grep's judging half: the lexical scan (`scan.ts`) supplies candidate files and passages; a model decides
 * which files and passages actually match. Read-only.
 */

/** A file below this probability is not worth reading passages from. */
export const FILE_GATE = 0.35;
/** A passage at or above this probability is a hit. */
export const HIT_THRESHOLD = 0.2;
/** Questions per model call: the limit Mastra's decision model took. */
export const ASKS_PER_DECISION = 26;
/** Model calls in flight together. */
export const DECISIONS_IN_FLIGHT = 4;

export interface Judge {
  readonly step: ModelStep;
  readonly signal?: AbortSignal;
}

interface PassageRef {
  readonly candidate: number;
  readonly passage: Passage;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/** Every ask answered as P(yes) in batched model calls, a few at a time. */
async function judgeAll(judge: Judge, asks: readonly Ask[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const answered = await mapLimit(
    chunksOf(asks, ASKS_PER_DECISION),
    DECISIONS_IN_FLIGHT,
    (chunk) => decideNoul(judge.step, chunk, judge.signal),
  );
  for (const map of answered) for (const [field, score] of map) scores.set(field, score);
  return scores;
}

async function judgeFiles(judge: Judge, candidates: readonly Candidate[], query: string): Promise<number[]> {
  const asks = candidates.map((candidate, index): Ask => ({
    field: `file_${index}`,
    template: FILE,
    body: `Query: ${query}\nFile: ${candidate.path}`,
  }));
  const scores = await judgeAll(judge, asks);
  return candidates.map((_candidate, index) => scores.get(`file_${index}`) ?? 0);
}

async function judgePassages(
  judge: Judge,
  passages: readonly PassageRef[],
  candidates: readonly Candidate[],
  query: string,
): Promise<number[]> {
  const asks = passages.map(({ candidate, passage }, index): Ask => ({
    field: `passage_${index}`,
    template: PASSAGE,
    body: `Query: ${query}\nFile: ${candidates[candidate]!.path}:${passage.start}-${passage.end}\n\n${passage.sketch}`,
  }));
  const scores = await judgeAll(judge, asks);
  return passages.map((_passage, index) => scores.get(`passage_${index}`) ?? 0);
}

/** Judges the scan's candidates and returns the hits at or above the threshold, best first, at most `limit`. */
export async function judgeCandidates(
  query: string,
  limit: number,
  scan: ScanResult,
  judge: Judge,
): Promise<FindOutput> {
  const { candidates } = scan;
  const fileScores = await judgeFiles(judge, candidates, query);
  const refs: PassageRef[] = [];
  candidates.forEach((candidate, index) => {
    if (fileScores[index]! < FILE_GATE) return;
    for (const passage of candidate.passages) {
      if (passage.sketch.trim() !== "") refs.push({ candidate: index, passage });
    }
  });
  const passageScores = await judgePassages(judge, refs, candidates, query);
  const hits: Hit[] = refs
    .map((ref, index) => ({
      path: candidates[ref.candidate]!.path,
      start: ref.passage.start,
      end: ref.passage.end,
      score: passageScores[index]!,
      snippet: ref.passage.sketch.split("\n")[0] ?? "",
    }))
    .filter((hit) => hit.score >= HIT_THRESHOLD)
    .sort((one, other) => other.score - one.score || one.path.localeCompare(other.path) || one.start - other.start)
    .slice(0, limit);
  return {
    status: hits.length === 0 ? "not_found" : "found",
    query,
    hits,
    coverage: scan.truncated ? "partial" : "complete",
    filesScanned: scan.filesScanned,
    fileCap: scan.fileCap,
    truncated: scan.truncated,
  };
}
