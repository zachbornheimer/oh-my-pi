import type { ContextEvidence, ContextItem, OmittedContext } from "./schemas.js";
import { trimSpace } from "./text.js";

export const REASON_TRANSCRIPT = "transcript source excluded";
export const REASON_EMPTY_TEXT = "empty text";

const TRANSCRIPT_SOURCE_PREFIXES = ["transcript", "session_history"];

/** The evidence's own id, or `evidence[<index>]` when it has none. */
export function evidenceId(index: number, evidence: ContextEvidence): string {
  return evidence.id === "" ? `evidence[${index}]` : evidence.id;
}

function isTranscriptSource(source: string): boolean {
  const lowered = trimSpace(source).toLowerCase();
  return TRANSCRIPT_SOURCE_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export interface RankedEvidence {
  readonly required: ContextItem[];
  readonly scored: ContextItem[];
  readonly omitted: OmittedContext[];
}

/** Splits candidates into required evidence (input order), scored evidence (relevance descending, stable) and omitted candidates. */
export function rankEvidence(candidates: readonly ContextEvidence[]): RankedEvidence {
  const required: ContextItem[] = [];
  const scored: ContextItem[] = [];
  const omitted: OmittedContext[] = [];
  const firstByKey = new Map<string, string>();
  candidates.forEach((evidence, index) => {
    const id = evidenceId(index, evidence);
    const provenance = { source: evidence.source, ref: evidence.ref };
    const key = `${trimSpace(evidence.source).toLowerCase()}\u0000${trimSpace(evidence.ref)}`;
    const earlier = firstByKey.get(key);
    const reason = omissionReason(evidence, earlier);
    if (reason !== "") {
      omitted.push({ kind: "evidence", id, reason, provenance });
      return;
    }
    firstByKey.set(key, id);
    const item: ContextItem = { kind: "evidence", id, text: evidence.text, provenance };
    if (evidence.required) {
      item.required = true;
    }
    if (evidence.relevance !== 0) {
      item.relevance = evidence.relevance;
    }
    (evidence.required ? required : scored).push(item);
  });
  scored.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  return { required, scored, omitted };
}

function omissionReason(evidence: ContextEvidence, earlierDuplicateId: string | undefined): string {
  if (isTranscriptSource(evidence.source)) {
    return REASON_TRANSCRIPT;
  }
  if (trimSpace(evidence.text) === "") {
    return REASON_EMPTY_TEXT;
  }
  return earlierDuplicateId === undefined ? "" : `duplicate of ${earlierDuplicateId}`;
}
