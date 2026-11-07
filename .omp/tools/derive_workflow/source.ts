import type { Candidates } from "./candidates.ts";
import { commandOf } from "./commands.ts";
import { documentCandidates } from "./document_candidates.ts";
import type { RunSource } from "./parameterize.ts";
import type { DeriveInput, TranscriptTurn } from "./schemas.ts";
import { transcriptCandidates } from "./transcript_candidates.ts";

/** Characters of the source's own words the summary prompt carries. */
const BRIEF_HEAD_CHARS = 8000;
const ASK_CHARS = 600;
const MAX_ASKS = 6;

/** What derive_workflow reads: where it came from, its candidate steps, and the text its commands must appear in. */
export interface ResolvedSource {
  readonly kind: RunSource;
  readonly ref?: string;
  readonly path?: string;
  readonly candidates: Candidates;
  /** Every command the source contains; a derived `run` must match some part of it. */
  readonly text: string;
  /** The source's own words for the model that names and describes the workflow. */
  readonly brief: string;
}

const head = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

function transcriptBrief(turns: readonly TranscriptTurn[]): string {
  const asks = turns.filter((turn) => turn.role === "user" && turn.text.trim() !== "").slice(0, MAX_ASKS);
  const last = turns.filter((turn) => turn.role === "agent" && turn.text.trim() !== "").at(-1);
  return [
    ...asks.map((turn) => `User: ${head(turn.text.trim(), ASK_CHARS)}`),
    ...(last === undefined ? [] : [`Agent, last: ${head(last.text.trim(), ASK_CHARS)}`]),
  ].join("\n");
}

/** Reads the candidates out of the transcript or the document the reader supplied; neither is an error. */
export function resolveSource(input: DeriveInput): ResolvedSource {
  const range = { from: input.from_turn, to: input.to_turn };
  if (input.transcript !== undefined) {
    const { turns } = input.transcript;
    const commands = turns.map((turn) => (turn.tool_call === undefined ? undefined : commandOf(turn.tool_call.input)));
    return {
      kind: "transcript",
      ref: input.source,
      candidates: transcriptCandidates(turns, range),
      text: commands.filter((command): command is string => command !== undefined).join("\n"),
      brief: transcriptBrief(turns),
    };
  }
  if (input.document !== undefined) {
    const { path, text } = input.document;
    return {
      kind: "document",
      path,
      candidates: documentCandidates(text, range, path),
      text,
      brief: head(text, BRIEF_HEAD_CHARS),
    };
  }
  throw new Error(`derive_workflow: nothing was read for ${input.source}`);
}
