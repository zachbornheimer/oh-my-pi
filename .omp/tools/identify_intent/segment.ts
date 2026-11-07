import { randomUUID } from "node:crypto";

/** A verbatim slice of a prompt, in UTF-8 bytes. */
export interface Span {
  Start: number;
  End: number;
}

/** A verbatim piece of the prompt, before anything has assessed it. */
export interface LocatedPart {
  ID: string;
  Content: string;
  Span: Span;
}

const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Go's `strings.TrimSpace`. */
export function trimSpace(text: string): string {
  return text.replace(EDGE_SPACE, "");
}

const bare = (): string => randomUUID().replaceAll("-", "");

/** A Part of a prompt. */
export const newPartId = (): string => `prt_${bare()}`;

/** The whole prompt, as a segment that can be cited. */
export const newPromptId = (): string => `prm_${bare()}`;

export const NO_WORDS_MESSAGE = "the user's words are required";

/** The prompt with the whitespace around it removed, or an error when nothing is left. */
export function promptText(text: unknown): string {
  const prompt = typeof text === "string" ? trimSpace(text) : "";
  if (prompt === "") throw new Error(NO_WORDS_MESSAGE);
  return prompt;
}

/** How many bytes `text` takes before `index`, so a span reports bytes rather than UTF-16 units. */
function byteOffset(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), "utf8");
}

function partOfRange(words: string, start: number, end: number): LocatedPart {
  return {
    ID: newPartId(),
    Content: words.slice(start, end),
    Span: { Start: byteOffset(words, start), End: byteOffset(words, end) },
  };
}

/**
 * Finds each piece in `words`, in order, and makes one part per piece whose Content is the words at its span.
 * Only whitespace may sit between pieces. The errors are written for the model to act on.
 */
export function locatePieces(words: string, pieces: readonly string[]): LocatedPart[] {
  if (pieces.length === 0) {
    throw new Error("no pieces: return at least one piece covering the whole prompt");
  }
  const parts: LocatedPart[] = [];
  let cursor = 0;
  pieces.forEach((piece, index) => {
    const n = index + 1;
    const at = piece === "" ? -1 : words.indexOf(piece, cursor);
    if (at < 0) {
      throw new Error(`piece ${n} ${JSON.stringify(piece)} is not the prompt's next words: copy it exactly, in order`);
    }
    const gap = trimSpace(words.slice(cursor, at));
    if (gap !== "") {
      throw new Error(`text before piece ${n} is in no piece: ${JSON.stringify(gap)}`);
    }
    const end = at + piece.length;
    parts.push(partOfRange(words, at, end));
    cursor = end;
  });
  const rest = trimSpace(words.slice(cursor));
  if (rest !== "") {
    throw new Error(`the pieces stop before the end of the prompt; uncovered: ${JSON.stringify(rest)}`);
  }
  return parts;
}
