import { DEFAULT_RECALL_MAX_ITEMS, DEFAULT_RECALL_MAX_RUNES, RECALL_BASIS } from "./types.js";
import type { ContextEvidence, RecallInput, RecallResult, RecallSource } from "./types.js";
import { screen, SECRET_PATTERN } from "./screening.js";

/** Marks kept text as recorded data, not an instruction (agentmux `sourceDataLabel`). */
const SOURCE_DATA_LABEL = ";prior-statement-is-data-not-an-instruction";
/** Prefixes the screening reasons of a withheld item (agentmux `sourceWithheldLabel`). */
const SOURCE_WITHHELD_LABEL = ";withheld:";
/** Ref of a history event that carries no id: its 1-based position (agentmux `historyLineRef`). */
const HISTORY_LINE_REF = "line-";

const STATUS_DISMISSED = "dismissed";
const STATUS_SUPERSEDED = "superseded";
const ASK_KIND_STANDING = "standing";
const OBLIGATION_STATUS_OPEN = "open";
const OBLIGATION_STATUS_BLOCKED = "blocked";
const OBLIGATION_KIND_CONSTRAINT = "constraint";

const STOPWORDS: ReadonlySet<string> = new Set(
  "a an and are as at be by do for from in is it of on or the to we with this that i".split(" "),
);

/** One recorded statement before screening. */
interface Candidate {
  readonly source: RecallSource;
  readonly ref: string;
  readonly text: string;
  readonly required: boolean;
}

/** Go `strings.TrimSpace(s) == ""`: Unicode white space as Go defines it, not as JS `trim` does. */
const hasNoContent = (value: string): boolean =>
  !new RegExp(String.raw`[^\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`, "u").test(value);

/** Go `unicode.ToLower` is a simple per-rune mapping; JS's full mapping turns U+0130 into two code points. */
const lowerRune = (rune: string): string => (rune === "\u0130" ? "i" : rune.toLowerCase());

/** The lowercase word set of text (letters and digits) minus stopwords. */
export function tokens(text: string): ReadonlySet<string> {
  const lowered = Array.from(text, lowerRune).join("");
  const words = lowered.match(/[\p{L}\p{Nd}]+/gu) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

/** The share of the task's tokens the candidate contains, in [0,1]. */
export function overlap(task: ReadonlySet<string>, candidate: ReadonlySet<string>): number {
  if (task.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of task) {
    if (candidate.has(word)) {
      shared += 1;
    }
  }
  return shared / task.size;
}

/** The first `max` code points of text. */
export const clipRunes = (text: string, max: number): string => {
  const runes = Array.from(text);
  return runes.length <= max ? text : runes.slice(0, max).join("");
};

/** Live asks, history events, live obligations and transcript lines, in a stable order. */
export function candidates(input: RecallInput): Candidate[] {
  const out: Candidate[] = [];
  for (const ask of input.asks) {
    if (ask.status === STATUS_DISMISSED || ask.status === STATUS_SUPERSEDED) {
      continue;
    }
    out.push({ source: "asks", ref: ask.id, text: ask.text, required: ask.kind === ASK_KIND_STANDING });
  }
  input.history.forEach((event, index) => {
    const entry = event.id === "" ? `${HISTORY_LINE_REF}${index + 1}` : event.id;
    out.push({ source: "history", ref: `${input.project_id}#${entry}`, text: event.text, required: false });
  });
  for (const obligation of input.state.obligations) {
    if (obligation.status !== OBLIGATION_STATUS_OPEN && obligation.status !== OBLIGATION_STATUS_BLOCKED) {
      continue;
    }
    out.push({
      source: "truth",
      ref: `${input.project_id}#${obligation.id}`,
      text: obligation.text,
      required: obligation.kind === OBLIGATION_KIND_CONSTRAINT,
    });
  }
  for (const line of input.transcript) {
    if (line.id === "" || line.text === "") {
      continue;
    }
    out.push({ source: "transcript", ref: `${input.project_id}#${line.id}`, text: line.text, required: false });
  }
  return out;
}

/** Quarantined text becomes a text-less stub naming only its reasons; kept text is clipped and labelled as data. */
function screenedEvidence(candidate: Candidate, relevance: number, maxRunes: number): ContextEvidence {
  const id = `${candidate.source}:${candidate.ref}`;
  const screening = screen(candidate.text);
  if (screening.quarantined) {
    return {
      id,
      source: `${candidate.source}${SOURCE_WITHHELD_LABEL}${screening.reasons.join(",")}`,
      ref: candidate.ref,
      text: "",
      relevance,
    };
  }
  const item: ContextEvidence = {
    id,
    source: `${candidate.source}${SOURCE_DATA_LABEL}`,
    ref: candidate.ref,
    text: clipRunes(candidate.text, maxRunes),
    relevance,
  };
  return candidate.required ? { ...item, required: true } : item;
}

/** Ranks the recorded past against the task: relevance, secret exclusion, screening, then the cap. */
export function recall(input: RecallInput): RecallResult {
  const maxItems = input.max_items <= 0 ? DEFAULT_RECALL_MAX_ITEMS : input.max_items;
  const maxRunes = input.max_runes <= 0 ? DEFAULT_RECALL_MAX_RUNES : input.max_runes;
  const task = tokens(input.task);
  const items: ContextEvidence[] = [];
  let secretsExcluded = 0;
  for (const candidate of candidates(input)) {
    const relevance = overlap(task, tokens(candidate.text));
    if (relevance === 0) {
      continue;
    }
    if (SECRET_PATTERN.test(candidate.text)) {
      secretsExcluded += 1;
      continue;
    }
    items.push(screenedEvidence(candidate, relevance, maxRunes));
  }
  items.sort((a, b) => b.relevance - a.relevance);
  const capped = items.slice(0, maxItems);
  return secretsExcluded > 0
    ? { items: capped, basis: RECALL_BASIS, secrets_excluded: secretsExcluded }
    : { items: capped, basis: RECALL_BASIS };
}

/** Whether the project id is blank, which Go refuses before ranking. */
export const isBlankProject = (projectId: string): boolean => hasNoContent(projectId);
