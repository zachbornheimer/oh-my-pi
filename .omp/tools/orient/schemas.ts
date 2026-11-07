/** Types shared by orient's scan, judge and output. The tool's input schema is declared in `index.ts` on `pi.zod`. */

/** A window of a file, read verbatim from disk by the scan. The judge sees `text`; the caller sees `evidence`. */
export interface Window {
  /** First line of the window, 1-based. */
  readonly start: number;
  /** Last line of the window, 1-based and inclusive. */
  readonly end: number;
  /** The window's lines, verbatim from disk at call time, each line capped. */
  readonly text: string;
  /** The window's densest lines as `LINE: text`. */
  readonly evidence: string;
}

/** A line range of a file that has no text yet. */
export interface Passage {
  readonly start: number;
  readonly end: number;
  readonly sketch: string;
}

/** Ranges of one file worth judging per probe: room for every chunk a 24-range retrieval could pick from one file. */
export const MAX_WINDOWS_PER_FILE = 8;

/** The most side questions one call answers. */
export const MAX_QUESTIONS = 6;

/** A file retrieval kept for one probe, with the ranges it retrieved from that file. */
export interface OrientCandidate {
  /** Absolute path. */
  readonly path: string;
  /** The file's best rank-fusion score from retrieval; not the model's probability. */
  readonly score: number;
  readonly windows: Window[];
}

/** One probe: the query it ran for and the candidates retrieval kept. */
export interface Probe {
  readonly query: string;
  readonly candidates: OrientCandidate[];
}

/** How the probes were retrieved: embeddings fused with BM25, or BM25 alone because embeddings failed. */
export interface Retrieval {
  readonly method: "fused" | "keyword";
  /** Why embeddings were not used, or a cache that could not be written; empty when neither. */
  readonly note: string;
}

/** The command that runs a test, derived from the repository's own manifest. */
export interface Gate {
  readonly command: string;
  /** Absolute directory the command runs in. */
  readonly cwd: string;
  readonly basis: string;
}

/** A window of a test file, the test declared at or above it, and the command that runs that test. */
export interface TestWindow extends Window {
  readonly path: string;
  readonly name: string | null;
  readonly gate: Gate | null;
  /** Why `gate` is null; empty when it is set. */
  readonly gateGap: string;
}

/** Everything the scan read for one `orient` run. */
export interface OrientScan {
  readonly behavior: Probe;
  readonly questions: Probe[];
  readonly tests: TestWindow[];
  readonly testFilesScanned: number;
  readonly filesScanned: number;
  readonly fileCap: number;
  readonly truncated: boolean;
  readonly retrieval: Retrieval;
}

/** What the caller asked: `repo` is absolute and without a trailing slash. */
export interface OrientRequest {
  readonly behavior: string;
  readonly repo: string;
  readonly questions: readonly string[];
  readonly limit: number;
}

/** One verified hit: a range read from disk at call time and judged to match. */
export interface Located {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** The model's stated P(the range matches what it was asked for), 0-1. */
  readonly score: number;
  readonly evidence: string;
}

export interface TestHit extends Located {
  readonly name: string | null;
  readonly gate: Gate | null;
}

export interface Answer {
  readonly question: string;
  readonly status: "found" | "not_found";
  readonly hits: Located[];
}

export interface OrientOutput {
  readonly status: "found" | "not_found";
  readonly repo: string;
  readonly behavior: string;
  readonly seams: Located[];
  readonly state: Located[];
  readonly tests: TestHit[];
  readonly gate: Gate | null;
  readonly answers: Answer[];
  readonly absences: string[];
  readonly coverage: "complete" | "partial";
  readonly filesScanned: number;
  readonly fileCap: number;
  readonly truncated: boolean;
  readonly retrieval: Retrieval;
}
