/** States how recall ranked and that no model was asked (agentmux `RecallBasis`). */
export const RECALL_BASIS = "deterministic;no-model";

/** The three project stores recall reads, plus the conversation transcript (agentmux `RecallSource*`). */
export type RecallSource = "asks" | "history" | "truth" | "transcript";

/** Limits applied when the input leaves one at zero (agentmux `DefaultRecallMaxItems`, `DefaultRecallMaxRunes`). */
export const DEFAULT_RECALL_MAX_ITEMS = 8;
export const DEFAULT_RECALL_MAX_RUNES = 400;

/** Only the fields ranking reads are kept; a caller's other fields on a record are ignored. */
export interface UserAsk { id: string; text: string; status: string; kind: string }
export interface HistoryEvent { id: string; text: string }
export interface Obligation { id: string; text: string; kind: string; status: string }
export interface TranscriptLine { id: string; text: string }
export interface ProjectState { obligations: Obligation[] }

export interface RecallInput {
  project_id: string;
  task: string;
  asks: UserAsk[];
  history: HistoryEvent[];
  state: ProjectState;
  transcript: TranscriptLine[];
  max_items: number;
  max_runes: number;
}

export interface ContextEvidence {
  id: string;
  source: string;
  ref: string;
  text: string;
  relevance: number;
  /** Omitted when false. */
  required?: boolean;
}

export interface RecallResult {
  items: ContextEvidence[];
  basis: string;
  /** Omitted when zero. */
  secrets_excluded?: number;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** Go decodes JSON null and a missing key to the zero value; these mirror that and refuse a value of the wrong type. */
function text(record: Obj, key: string, path: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`recall: ${path}${key} must be a string`);
  return value;
}

function whole(record: Obj, key: string): number {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`recall: ${key} must be an integer`);
  return value;
}

function list<T>(record: Obj, key: string, read: (item: Obj, path: string) => T): T[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`recall: ${key} must be an array`);
  return value.map((item, index) => {
    if (!isObj(item)) throw new Error(`recall: ${key}[${index}] must be an object`);
    return read(item, `${key}[${index}].`);
  });
}

/** Normalizes tool input to the shape ranking reads: null and missing become zero values, wrong types throw. */
export function normalizeInput(raw: unknown): RecallInput {
  if (!isObj(raw)) throw new Error("recall: the input must be an object");
  const state = raw.state === undefined || raw.state === null ? {} : raw.state;
  if (!isObj(state)) throw new Error("recall: state must be an object");
  return {
    project_id: text(raw, "project_id", ""),
    task: text(raw, "task", ""),
    asks: list(raw, "asks", (item, path) => ({ id: text(item, "id", path), text: text(item, "text", path), status: text(item, "status", path), kind: text(item, "kind", path) })),
    history: list(raw, "history", (item, path) => ({ id: text(item, "id", path), text: text(item, "text", path) })),
    state: {
      obligations: list(state, "obligations", (item, path) => ({ id: text(item, "id", `state.${path}`), text: text(item, "text", `state.${path}`), kind: text(item, "kind", `state.${path}`), status: text(item, "status", `state.${path}`) })),
    },
    transcript: list(raw, "transcript", (item, path) => ({ id: text(item, "id", path), text: text(item, "text", path) })),
    max_items: whole(raw, "max_items"),
    max_runes: whole(raw, "max_runes"),
  };
}
