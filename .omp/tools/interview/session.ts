import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Assessment, type Breakdown, type Dimension, DIMENSIONS } from "./ambiguity.js";
import { PERSONAS, type Persona } from "./candidates.js";

/**
 * The central interview store: `<SPECS_DIR>/<session_id>/session.json`, the same wherever the caller stands, so an
 * interview started in `~` is continued and crystallized from anywhere. Writes go through a temporary file and a
 * rename, so a reader never sees half a session. `crystallize_spec` reads the same format (`version: 1`).
 */

export const SPECS_DIR_ENV = "SPECS_DIR";
export const SESSION_FILE = "session.json";
/** A session id: the idea's slug, `-`, then the random suffix. Nothing else may name a directory in the store. */
const SESSION_ID_WORD = /^[a-z0-9]+$/;

/** Whether `id` is one or more lowercase-alphanumeric words joined by single `-`; linear in the id's length. */
export function isSessionId(id: string): boolean {
  return id.split("-").every((word) => SESSION_ID_WORD.test(word));
}
const SLUG_WORDS = 6;
const SLUG_MAX_CHARS = 40;
const SUFFIX_LENGTH = 6;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const FALLBACK_SLUG = "spec";
const CREATE_ATTEMPTS = 5;

/** The existing codebase an interview is about; its presence is what makes the work brownfield. */
export interface RepoContext {
  root: string;
  name: string;
  entries: string[];
  readme: string;
}

/** One question asked and, once the user replied, its answer. */
export interface Round {
  question: string;
  target_dimension: Dimension | "";
  persona: Persona;
  answer?: string;
}

export type Status = "asking" | "ready";

/** Everything the interview knows between calls. */
export interface Session {
  version: 1;
  session_id: string;
  idea: string;
  created_at: string;
  updated_at: string;
  brownfield: boolean;
  context?: RepoContext;
  rounds: Round[];
  /** The latest grading; absent until 3 rounds are answered. */
  assessment?: Assessment;
  status: Status;
}

/** `$SPECS_DIR` when it is set, else `~/.local/share/specs`. */
export function specsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[SPECS_DIR_ENV]?.trim() || join(homedir(), ".local", "share", "specs");
}

/** The session's directory; refuses an id that could name anything outside the store. */
export function sessionDirectory(sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw new Error(
      `session_id ${JSON.stringify(sessionId)} is not an interview id (lowercase words and digits joined by -)`,
    );
  }
  return join(specsDir(), sessionId);
}

/** The idea's first words, lowercased and joined by `-`, at most 40 characters. */
export function slugOf(idea: string): string {
  const words = idea.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "").slice(0, SLUG_WORDS);
  const slug = words.join("-").slice(0, SLUG_MAX_CHARS).replace(/-+$/, "");
  return slug === "" ? FALLBACK_SLUG : slug;
}

/** A fresh id: the idea's slug, `-`, and 6 random base36 characters. */
export function newSessionId(idea: string): string {
  const suffix = Array.from({ length: SUFFIX_LENGTH }, () => BASE36[randomInt(BASE36.length)]).join("");
  return `${slugOf(idea)}-${suffix}`;
}

/** Makes a directory for a new session under a fresh id, retrying the rare id that is already taken. */
export async function createSessionDirectory(idea: string): Promise<string> {
  await mkdir(specsDir(), { recursive: true });
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const sessionId = newSessionId(idea);
    try {
      await mkdir(sessionDirectory(sessionId));
      return sessionId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`cannot make a session directory in ${specsDir()}: ${CREATE_ATTEMPTS} fresh ids were all taken`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
}

/** Checks a repository context given by a caller or read from a session; throws naming the first bad field. */
export function parseContext(value: unknown, where = "context"): RepoContext {
  if (!isRecord(value)) throw new Error(`${where} must be an object { root, name, entries, readme }`);
  const { root, name, entries, readme } = value;
  if (typeof root !== "string" || root === "") throw new Error(`${where}.root must be a non-empty string`);
  if (typeof name !== "string") throw new Error(`${where}.name must be a string`);
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${where}.entries must be an array of strings`);
  }
  if (typeof readme !== "string") throw new Error(`${where}.readme must be a string`);
  return { root, name, entries: entries as string[], readme };
}

function parseAssessment(value: unknown): Assessment {
  if (!isRecord(value)) throw new Error("assessment must be an object");
  const { ambiguity, breakdown, milestone, floor_failures: failures, ready } = value;
  if (typeof ambiguity !== "number") throw new Error("assessment.ambiguity must be a number");
  if (!isRecord(breakdown)) throw new Error("assessment.breakdown must be an object");
  const clarity: Partial<Record<Dimension, number>> = {};
  for (const [key, level] of Object.entries(breakdown)) {
    if (!isDimension(key) || typeof level !== "number") throw new Error(`assessment.breakdown.${key} is not a clarity`);
    clarity[key] = level;
  }
  if (!["initial", "progress", "refined", "ready"].includes(String(milestone))) {
    throw new Error("assessment.milestone is not a milestone");
  }
  if (!Array.isArray(failures) || failures.some((failure) => typeof failure !== "string")) {
    throw new Error("assessment.floor_failures must be an array of strings");
  }
  if (typeof ready !== "boolean") throw new Error("assessment.ready must be a boolean");
  return {
    ambiguity,
    breakdown: clarity as Breakdown,
    milestone: milestone as Assessment["milestone"],
    floor_failures: failures as string[],
    ready,
  };
}

function parseRound(value: unknown, index: number): Round {
  if (!isRecord(value)) throw new Error(`rounds[${index}] must be an object`);
  const { question, target_dimension: target, persona, answer } = value;
  if (typeof question !== "string") throw new Error(`rounds[${index}].question must be a string`);
  if (target !== "" && !isDimension(target)) throw new Error(`rounds[${index}].target_dimension is not a dimension`);
  if (!(PERSONAS as readonly unknown[]).includes(persona)) throw new Error(`rounds[${index}].persona is not a persona`);
  if (answer !== undefined && typeof answer !== "string") throw new Error(`rounds[${index}].answer must be a string`);
  return {
    question,
    target_dimension: target as Round["target_dimension"],
    persona: persona as Persona,
    ...(answer === undefined ? {} : { answer }),
  };
}

/** A stored session checked field by field; throws naming the first bad field. */
export function parseSession(value: unknown): Session {
  if (!isRecord(value)) throw new Error("session must be an object");
  if (value.version !== 1) throw new Error(`session version ${String(value.version)} is not supported (expected 1)`);
  const { session_id, idea, created_at, updated_at, brownfield, context, rounds, assessment, status } = value;
  if (typeof session_id !== "string") throw new Error("session_id must be a string");
  if (typeof idea !== "string") throw new Error("idea must be a string");
  if (typeof created_at !== "string" || typeof updated_at !== "string") throw new Error("created_at and updated_at must be strings");
  if (typeof brownfield !== "boolean") throw new Error("brownfield must be a boolean");
  if (!Array.isArray(rounds)) throw new Error("rounds must be an array");
  if (status !== "asking" && status !== "ready") throw new Error("status must be asking or ready");
  return {
    version: 1,
    session_id,
    idea,
    created_at,
    updated_at,
    brownfield,
    ...(context === undefined ? {} : { context: parseContext(context) }),
    rounds: rounds.map(parseRound),
    ...(assessment === undefined ? {} : { assessment: parseAssessment(assessment) }),
    status,
  };
}

/** The stored session, or an error naming the id and the store it is missing from. */
export async function loadSession(sessionId: string): Promise<Session> {
  const file = join(sessionDirectory(sessionId), SESSION_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no interview ${sessionId} in ${specsDir()}: start one with interview { idea }`);
    }
    throw error;
  }
  try {
    return parseSession(JSON.parse(text));
  } catch (error) {
    throw new Error(`interview ${sessionId} is unreadable (${file}): ${(error as Error).message}`);
  }
}

/** Writes the session whole: a temporary file, then a rename over `session.json`. */
export async function saveSession(session: Session): Promise<void> {
  const directory = sessionDirectory(session.session_id);
  const temporary = join(directory, `${SESSION_FILE}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`);
  await rename(temporary, join(directory, SESSION_FILE));
}

/** The rounds the user has answered. */
export function answeredRounds(session: Session): Round[] {
  return session.rounds.filter((round) => round.answer !== undefined);
}

/** The interview so far as numbered questions and answers; an unanswered question is left out. */
export function transcriptText(session: Session): string {
  const answered = answeredRounds(session);
  if (answered.length === 0) return "(no questions answered yet)";
  return answered.map((round, index) => `Q${index + 1}: ${round.question}\nA${index + 1}: ${round.answer}`).join("\n");
}

/** The codebase as a model reads it, or that there is none (greenfield). */
export function contextText(context: RepoContext | undefined): string {
  if (context === undefined) return "none: new work, not about an existing codebase (greenfield)";
  return [
    `${context.name} at ${context.root}`,
    `Top-level entries: ${context.entries.join(", ") || "none"}`,
    `README: ${context.readme || "none"}`,
  ].join("\n");
}

/** The latest grading as a model reads it. */
export function assessmentText(assessment: Assessment | undefined): string {
  if (assessment === undefined) return "not graded yet";
  const clarity = Object.entries(assessment.breakdown).map(([dimension, value]) => `${dimension} ${value.toFixed(2)}`);
  return `${assessment.ambiguity.toFixed(2)} [${assessment.milestone}]; clarity: ${clarity.join(", ")}`;
}
