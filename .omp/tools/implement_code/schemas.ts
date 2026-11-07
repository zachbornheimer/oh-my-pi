/** The shapes implement_code takes and returns, and the checks on what a caller or a model sends. */

export const FILE_ROLES = ["module", "test", "registry", "doc"] as const;
export type FileRole = (typeof FILE_ROLES)[number];
export const FILE_ACTIONS = ["create", "modify"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

/** A design as pseudocode: what the leaf is, what goes in and out, and the steps. */
export interface DesignObject {
  name: string;
  purpose: string;
  input_summary: string;
  output_summary: string;
  pseudocode: string;
  /** Names the design replaces; where they are still used becomes `callers_to_update`. */
  replaces?: string[];
}
export type Design = string | DesignObject;

export interface Hints {
  /** A repo-relative path or directory the new code belongs near. */
  near?: string;
  /** The language of the new code, when the sibling files do not show it. */
  language?: string;
}

export interface ImplementCodeRequest {
  design: Design;
  /** The repo, as `~/...`, absolute, or relative to the directory the tool is called from; omitted means the repo of that directory. */
  repo?: string;
  hints?: Hints;
}

export interface FileChange {
  /** Relative to the repo. */
  path: string;
  action: FileAction;
  role: FileRole;
  reason: string;
  /** The whole file after the change. */
  content: string;
  /** For a modified file: the unified diff from what was read. */
  diff?: string;
  /** For a modified file: the sha256 of the text that was read; applying refuses if the file no longer has it. */
  base_sha256?: string;
}

export interface Finding {
  principle: string;
  /** The file it is about; empty for the change as a whole. */
  file: string;
  finding: string;
  /** 0 to 1: how sure the reviewer is that it is real and worth fixing. */
  confidence: number;
}

export interface CheckCommand {
  run: string;
  why: string;
}

export interface CheckResult extends CheckCommand {
  passed: boolean;
  exit_code: number;
  /** The end of the command's output. */
  output_tail: string;
}

export interface ImplementedCode {
  repo: string;
  files: FileChange[];
  /** The edits to files that already exist, as unified diffs. */
  touchpoints: { path: string; diff: string }[];
  /** Files that still use a name the design replaces. */
  callers_to_update: { name: string; files: string[] }[];
  /** The targeted test and type commands to run after applying. */
  checks: CheckCommand[];
  review: { findings: Finding[]; revised: boolean };
  /** Set only when the call asked to apply. */
  applied?: { written: { path: string; action: FileAction }[]; checks: CheckResult[] };
}

// ---- reading what a caller or a model sends ----

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(raw: Raw, key: string, where: string, options: { allowEmpty?: boolean } = {}): string {
  const value = raw[key];
  if (typeof value !== "string") throw new Error(`${where}${key} must be a string`);
  if (!options.allowEmpty && value.trim() === "") throw new Error(`${where}${key} must not be empty`);
  return value;
}

/** Reads a design: words, or an object with name, purpose, input and output summaries and pseudocode. */
export function parseDesign(value: unknown): Design {
  if (typeof value === "string") {
    if (value.trim() === "") throw new Error("implement_code: design must not be empty");
    return value;
  }
  if (!isRecord(value)) throw new Error("implement_code: design must be words or an object with name, purpose, input_summary, output_summary and pseudocode");
  const where = "implement_code: design.";
  const replaces = value.replaces;
  if (replaces !== undefined && replaces !== null) {
    if (!Array.isArray(replaces) || replaces.some((name) => typeof name !== "string")) {
      throw new Error(`${where}replaces must be an array of strings`);
    }
  }
  return {
    name: stringField(value, "name", where),
    purpose: stringField(value, "purpose", where),
    input_summary: stringField(value, "input_summary", where, { allowEmpty: true }),
    output_summary: stringField(value, "output_summary", where, { allowEmpty: true }),
    pseudocode: stringField(value, "pseudocode", where),
    ...(replaces === undefined || replaces === null ? {} : { replaces: replaces as string[] }),
  };
}

/** Reads the call: a design, the repo, optional hints. null reads as omitted. */
export function parseRequest(input: { design?: unknown; repo?: unknown; hints?: unknown }): ImplementCodeRequest {
  if (input.design === undefined || input.design === null) throw new Error("implement_code: design is required");
  if (input.repo !== undefined && input.repo !== null && (typeof input.repo !== "string" || input.repo.trim() === "")) {
    throw new Error("implement_code: repo must be a non-empty path");
  }
  const hints = input.hints;
  if (hints !== undefined && hints !== null && !isRecord(hints)) throw new Error("implement_code: hints must be an object");
  const near = isRecord(hints) ? hints.near : undefined;
  const language = isRecord(hints) ? hints.language : undefined;
  for (const [name, value] of [["near", near], ["language", language]] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`implement_code: hints.${name} must be a string`);
  }
  const keep = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const parsedHints: Hints = { ...(keep(near) === undefined ? {} : { near: keep(near) }), ...(keep(language) === undefined ? {} : { language: keep(language) }) };
  return {
    design: parseDesign(input.design),
    ...(typeof input.repo === "string" ? { repo: input.repo.trim() } : {}),
    ...(Object.keys(parsedHints).length === 0 ? {} : { hints: parsedHints }),
  };
}

/** The reply of the locate step: `{ "Files": [{ path, role, reason }] }`. Throws a reason a model can act on. */
export function parseLocateReply(value: unknown): { path: string; role: FileRole; reason: string }[] {
  const list = replyField(value, "Files");
  return list.map((entry, index) => {
    const at = `Files[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at} must be an object`);
    noExtraKeys(entry, ["path", "role", "reason"], at);
    const path = entry.path;
    if (typeof path !== "string" || path === "") throw new Error(`${at}.path must be a non-empty string`);
    if (typeof entry.role !== "string" || !(FILE_ROLES as readonly string[]).includes(entry.role)) {
      throw new Error(`${at}.role must be one of ${FILE_ROLES.join(", ")}`);
    }
    if (typeof entry.reason !== "string") throw new Error(`${at}.reason must be a string`);
    return { path, role: entry.role as FileRole, reason: entry.reason };
  });
}

/** The reply of the registry step: `{ "Insertions": [{ after, lines }] }`. */
export function parseInsertionsReply(value: unknown): { after: string; lines: string[] }[] {
  const list = replyField(value, "Insertions");
  return list.map((entry, index) => {
    const at = `Insertions[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at} must be an object`);
    noExtraKeys(entry, ["after", "lines"], at);
    if (typeof entry.after !== "string") throw new Error(`${at}.after must be a string`);
    if (!Array.isArray(entry.lines) || entry.lines.some((line) => typeof line !== "string")) {
      throw new Error(`${at}.lines must be an array of strings`);
    }
    return { after: entry.after, lines: entry.lines as string[] };
  });
}

/** The reply of the review step: `{ "Findings": [{ principle, file, finding, confidence }] }`. */
export function parseFindingsReply(value: unknown): Finding[] {
  const list = replyField(value, "Findings");
  return list.map((entry, index) => {
    const at = `Findings[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at} must be an object`);
    noExtraKeys(entry, ["principle", "file", "finding", "confidence"], at);
    if (typeof entry.principle !== "string") throw new Error(`${at}.principle must be a string`);
    if (typeof entry.file !== "string") throw new Error(`${at}.file must be a string`);
    if (typeof entry.finding !== "string") throw new Error(`${at}.finding must be a string`);
    const confidence = entry.confidence;
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
      throw new Error(`${at}.confidence must be a number from 0 to 1`);
    }
    return { principle: entry.principle, file: entry.file, finding: entry.finding, confidence };
  });
}

function replyField(value: unknown, field: string): unknown[] {
  if (!isRecord(value)) throw new Error(`the reply must be a JSON object with one key, ${field}`);
  noExtraKeys(value, [field], "the reply");
  const list = value[field];
  if (!Array.isArray(list)) throw new Error(`${field} must be an array`);
  return list;
}

/** The original reads replies with a schema that drops unknown keys, so an extra key is ignored and a missing one refused. */
function noExtraKeys(raw: Raw, allowed: readonly string[], where: string): void {
  const missing = allowed.find((key) => raw[key] === undefined);
  if (missing !== undefined) throw new Error(`${where} is missing ${missing}`);
}
