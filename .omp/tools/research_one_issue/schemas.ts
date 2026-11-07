/** Shapes the research reads and writes, with hand-written validators (no schema library). */

export const SOURCE_KINDS = ["atask", "linear", "opik", "url"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceRef = { kind: SourceKind; ref: string };

/** One item in the shape every source is normalized to: "title", "body" and "status" mean the same thing in each. */
export type Item = {
  kind: SourceKind;
  id: string;
  title: string;
  body: string;
  status: string;
  url?: string;
  repo?: string;
  updated_at?: string;
};

export type Approach = {
  name: string;
  kind: "standard" | "new" | "structural";
  mechanism: string;
  wins_when: string;
  loses_when: string;
  evidence: string;
};
export type Citation = { title: string; url: string; date: string };

/** The research, as stored and returned. `key` is what makes a second run a cache hit. */
export type ResearchRecord = {
  key: string;
  item: Item;
  assessment: string;
  recommendation: string;
  approaches: Approach[];
  what_would_flip_it: string;
  citations: Citation[];
  researched_at: string;
};

/** What the model answers: a record without what the run adds. */
export type ResearchAnswer = Omit<ResearchRecord, "key" | "item" | "researched_at">;

export type ResearchOutput = { record: ResearchRecord; from_cache: boolean; store_path: string };

/** A key is one filename: no separators, no dots, so it cannot name a path outside the research store. */
export const CACHE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: Record<string, unknown>, field: string, where: string): string {
  const found = value[field];
  if (typeof found !== "string") throw new Error(`${where}.${field} must be a string`);
  return found;
}

function optStr(value: Record<string, unknown>, field: string, where: string): string | undefined {
  const found = value[field];
  if (found === undefined) return undefined;
  if (typeof found !== "string") throw new Error(`${where}.${field} must be a string when present`);
  return found;
}

export function parseItem(value: unknown, where = "item"): Item {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  const kind = value.kind;
  if (typeof kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${where}.kind must be one of ${SOURCE_KINDS.join(", ")}`);
  }
  const item: Item = {
    kind: kind as SourceKind,
    id: str(value, "id", where),
    title: str(value, "title", where),
    body: str(value, "body", where),
    status: str(value, "status", where),
  };
  for (const field of ["url", "repo", "updated_at"] as const) {
    const found = optStr(value, field, where);
    if (found !== undefined) item[field] = found;
  }
  return item;
}

function parseApproach(value: unknown, index: number): Approach {
  const where = `approaches[${index}]`;
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  const kind = value.kind;
  if (kind !== "standard" && kind !== "new" && kind !== "structural") {
    throw new Error(`${where}.kind must be standard, new or structural`);
  }
  return {
    name: str(value, "name", where),
    kind,
    mechanism: str(value, "mechanism", where),
    wins_when: str(value, "wins_when", where),
    loses_when: str(value, "loses_when", where),
    evidence: str(value, "evidence", where),
  };
}

function parseCitation(value: unknown, index: number): Citation {
  const where = `citations[${index}]`;
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  return { title: str(value, "title", where), url: str(value, "url", where), date: str(value, "date", where) };
}

/** The fields the model answers; throws naming the first bad field. */
export function parseAnswer(value: unknown): ResearchAnswer {
  if (!isObject(value)) throw new Error("the answer must be a JSON object");
  if (!Array.isArray(value.approaches)) throw new Error("answer.approaches must be an array");
  if (!Array.isArray(value.citations)) throw new Error("answer.citations must be an array");
  return {
    assessment: str(value, "assessment", "answer"),
    recommendation: str(value, "recommendation", "answer"),
    approaches: value.approaches.map(parseApproach),
    what_would_flip_it: str(value, "what_would_flip_it", "answer"),
    citations: value.citations.map(parseCitation),
  };
}

export function parseRecord(value: unknown): ResearchRecord {
  if (!isObject(value)) throw new Error("a record must be an object");
  return {
    key: str(value, "key", "record"),
    item: parseItem(value.item, "record.item"),
    ...parseAnswer(value),
    researched_at: str(value, "researched_at", "record"),
  };
}
