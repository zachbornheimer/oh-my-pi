import { isAbsolute } from "node:path";
import { chunkRanges } from "./chunks.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { listFiles, MAX_LISTED_FILES } from "./file_list.js";
import type { GateMachine } from "./gate.js";
import {
  type ChunkIndex,
  type CodeChunk,
  codeEmbeddingIndex,
  indexChunks,
  type Retrieved,
} from "./retrieval.js";
import { cachedReader, isCodePath, type RepoMachine, repoScanMachine, windowOf } from "./repo_scan.js";
import {
  MAX_WINDOWS_PER_FILE,
  type OrientCandidate,
  type OrientRequest,
  type OrientScan,
  type Probe,
} from "./schemas.js";
import { identifierTermsOf, termsOf } from "./terms.js";
import { isTestPath, probeTests, stemOf } from "./test_files.js";

/**
 * The scan half of `orient`: cut the repository's code into declaration-sized chunks, retrieve the chunks nearest the
 * behavior and each question (embedding cosine fused with BM25), read the tests nearest those files, and derive the
 * command that runs each. It never writes and asks no model; `orient.ts` judges every range retrieved here.
 */

/** The machine the scan reads through: processes, files and directories. */
export type HostMachine = RepoMachine & GateMachine & { isDirectory(path: string): Promise<boolean> };

/** Ranges retrieved for the behavior: every one is judged twice (as a seam and as state). */
const BEHAVIOR_RANGES = 24;
/** Ranges retrieved per side question. */
const QUESTION_RANGES = 12;
/** A file larger than this is generated or data, not code a developer edits. */
const MAX_FILE_CHARACTERS = 512 * 1024;
/** A chunk is at most 60 lines; this holds one whole at 66 characters a line. */
const WINDOW_CHARACTERS = 4_000;

interface RepositoryChunks {
  readonly chunks: CodeChunk[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}

async function repositoryChunks(
  listed: { files: string[]; truncated: boolean },
  repo: string,
  read: (path: string) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<RepositoryChunks> {
  const chunks: CodeChunk[] = [];
  let filesScanned = 0;
  for (const relative of listed.files) {
    signal?.throwIfAborted();
    const path = `${repo}/${relative}`;
    const text = await read(path);
    if (text === undefined || text.length > MAX_FILE_CHARACTERS || text.includes("\u0000")) continue;
    filesScanned += 1;
    const lines = text.split("\n");
    for (const range of chunkRanges(text)) {
      chunks.push({ path, relative, ...range, text: lines.slice(range.start - 1, range.end).join("\n") });
    }
  }
  return { chunks, filesScanned, truncated: listed.truncated };
}

/** The retrieved ranges grouped by file, files in the order of their best range, ranges in line order. */
async function probeOf(
  query: string,
  retrieved: Retrieved,
  terms: readonly string[],
  read: (path: string) => Promise<string | undefined>,
): Promise<Probe> {
  const byFile = new Map<string, { score: number; chunks: CodeChunk[] }>();
  retrieved.chunks.forEach((chunk, rank) => {
    const entry = byFile.get(chunk.path) ?? { score: 1 / (rank + 1), chunks: [] };
    if (entry.chunks.length < MAX_WINDOWS_PER_FILE) entry.chunks.push(chunk);
    byFile.set(chunk.path, entry);
  });
  const candidates: OrientCandidate[] = [];
  for (const [path, entry] of byFile) {
    const lines = ((await read(path)) ?? "").split("\n");
    candidates.push({
      path,
      score: entry.score,
      windows: entry.chunks
        .sort((one, other) => one.start - other.start)
        .map((chunk) => windowOf(lines, { start: chunk.start, end: chunk.end, sketch: "" }, terms, WINDOW_CHARACTERS)),
    });
  }
  return { query, candidates };
}

async function retrieve(
  index: ChunkIndex,
  query: string,
  limit: number,
  read: (path: string) => Promise<string | undefined>,
): Promise<{ probe: Probe; retrieved: Retrieved }> {
  const terms = termsOf(query);
  const retrieved = await index.rank(query, terms, identifierTermsOf(query), limit);
  return { probe: await probeOf(query, retrieved, terms, read), retrieved };
}

/** The error a relative `repo` is refused with: it is never resolved against the session's directory. */
export function requireAbsoluteRepo(repo: string, cwd: string): string {
  if (isAbsolute(repo)) return repo.replace(/\/+$/, "") || "/";
  throw new Error(
    `repo "${repo}" is relative. orient takes an absolute path and never resolves a relative one against the working `
      + `directory (${cwd}). Pass an absolute path; if you meant that directory, pass ${cwd}.`,
  );
}

/** The scan for one request: chunks, retrieval for the behavior and each question, and the nearest tests. */
export async function scanRepository(
  request: OrientRequest,
  machine: HostMachine,
  embeddings: EmbeddingIndex = codeEmbeddingIndex(),
  signal?: AbortSignal,
): Promise<OrientScan> {
  const repo = request.repo;
  if (!(await machine.isDirectory(repo))) throw new Error(`orient: repo ${repo} is not a directory`);
  const read = cachedReader(machine);
  const codeMachine = repoScanMachine(machine, repo, (path) => isCodePath(path) && !isTestPath(path), read);
  const testMachine = repoScanMachine(machine, repo, (path) => isCodePath(path) && isTestPath(path), read);
  const code = await repositoryChunks(await listFiles(codeMachine), repo, read, signal);
  const index = await indexChunks(code.chunks, embeddings);
  const behavior = await retrieve(index, request.behavior, BEHAVIOR_RANGES, read);
  const questions = [];
  for (const question of request.questions) questions.push(await retrieve(index, question, QUESTION_RANGES, read));
  const candidatePaths = behavior.probe.candidates.map((candidate) => candidate.path);
  const stems = [...new Set(candidatePaths.map(stemOf).filter((stem) => stem !== undefined))];
  const tests = await probeTests(
    testMachine,
    repo,
    termsOf(request.behavior),
    stems,
    identifierTermsOf(request.behavior),
    candidatePaths,
  );
  const runs = [behavior, ...questions].map((entry) => entry.retrieved);
  return {
    behavior: behavior.probe,
    questions: questions.map((entry) => entry.probe),
    tests: tests.tests,
    testFilesScanned: tests.testFilesScanned,
    filesScanned: code.filesScanned,
    fileCap: MAX_LISTED_FILES,
    truncated: code.truncated,
    retrieval: {
      method: runs.every((run) => run.method === "fused") ? "fused" : "keyword",
      note: [...new Set(runs.map((run) => run.note).filter((note) => note !== ""))].join("; "),
    },
  };
}
