import type { Evidence } from "./schemas.ts";

/** The longest title a step carries, cut at a word. */
export const MAX_TITLE_LENGTH = 60;

/** One thing in the source that may be a step of the process: the model decides whether it is, and of what kind. */
export interface Candidate {
  /** `c1`, `c2`, ...: stable within one run, used to label the model's calls. */
  readonly id: string;
  readonly title: string;
  /** The shell command, as the source wrote it. */
  readonly command?: string;
  /** True when the candidate is only the command (a tool call, a line of a code block), so its kind is not in doubt. */
  readonly commandOnly: boolean;
  /** The file an edit changes. */
  readonly edit?: string;
  /** What the decision model reads about this candidate. */
  readonly text: string;
  /** Where it sits: the ask that led to it, or the section it is in. Context only. */
  readonly context: string;
  readonly evidence: readonly Evidence[];
  /** True when the same command failed, or ran again, before this one succeeded. */
  readonly retried: boolean;
}

/** What was left out before the model saw the candidates. */
export interface DroppedCandidates {
  readonly reads: number;
  readonly retries: number;
  readonly failed: number;
}

export interface Candidates {
  readonly candidates: readonly Candidate[];
  /** Every call or line that could have been a step, before anything was dropped. */
  readonly seen: number;
  readonly dropped: DroppedCandidates;
}

/** A title on one line, with no markdown the rendering would trip on, cut to `MAX_TITLE_LENGTH`. */
export function cleanTitle(raw: string): string {
  const flat = raw.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
  const sentence = flat.replace(/[.:]$/, "");
  if (sentence.length <= MAX_TITLE_LENGTH) return sentence;
  const cut = sentence.slice(0, MAX_TITLE_LENGTH - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > 0 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

export const candidateId = (index: number): string => `c${index + 1}`;
