/** Types shared by find's scan, judge and output. The tool's input schema is declared in `index.ts` on `pi.zod`. */

/** A window of a file worth judging, with its densest lines as a sketch. */
export interface Passage {
  /** First line of the window, 1-based. */
  readonly start: number;
  /** Last line of the window, 1-based. */
  readonly end: number;
  /** The window's lines most likely to answer the query. */
  readonly sketch: string;
}

/** A file the lexical scan kept, with up to 3 passages. */
export interface Candidate {
  /** Absolute path. */
  readonly path: string;
  /** Lexical scan score of the file; not the model's probability. */
  readonly score: number;
  readonly passages: Passage[];
}

/** The most hits one call returns. */
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;

export interface Hit {
  /** Absolute path of the file holding the passage. */
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** The model's stated P(the window implements the query), 0-1. */
  readonly score: number;
  readonly snippet: string;
}

export interface FindOutput {
  readonly status: "found" | "not_found";
  readonly query: string;
  readonly hits: Hit[];
  /** complete: every eligible file was scanned; partial: the scan stopped at its cap. */
  readonly coverage: "complete" | "partial";
  readonly filesScanned: number;
  readonly fileCap: number;
  readonly truncated: boolean;
}
