import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Pinned decisions, one JSON file per session, shared by `pin_decision`, `resolve_decision` and the harness band
 * adapters. Every CLI run is its own process, so the pins live on disk:
 * `$CAPABILITY_DECISIONS_DIR/<session>.json`, else `~/.cache/capability-runtime/decisions/<session>.json`.
 * Only node built-ins are imported here, so a harness extension can load this file directly.
 */

export const DECISIONS_DIR_ENV = "CAPABILITY_DECISIONS_DIR";
const DEFAULT_RELATIVE_DIRECTORY = [".cache", "capability-runtime", "decisions"] as const;

/** The session a pin joins when the caller names none. */
export const DEFAULT_SESSION = "default";
/** The band shows at most this many pins; pinning past it drops the oldest (omp's widget holds 10 lines). */
export const MAX_PINNED = 8;
/** Options answerable with one key, 1-9, counted across every pin in the band. */
export const MAX_HOTKEYS = 9;
/** Questions remembered as answered or dismissed; a pin past it drops the oldest (a repeat may pin again). */
export const MAX_RESOLVED = 64;

export interface PinnedDecision {
  readonly id: number;
  readonly question: string;
  readonly options: readonly string[];
  readonly pinned_at: string;
}

/** A question that was pinned and then unpinned, so a verbatim repeat cannot be pinned again this session. */
export interface ResolvedDecision {
  /** The id the question had while pinned. */
  readonly id: number;
  /** The question's identity, as `questionKey` builds it. */
  readonly key: string;
}

interface SessionPins {
  readonly next_id: number;
  readonly pins: readonly PinnedDecision[];
  readonly resolved: readonly ResolvedDecision[];
}

const EMPTY: SessionPins = { next_id: 1, pins: [], resolved: [] };

/** Which pin a refused repeat collided with: one still open, or one already answered or dismissed. */
export type DuplicateDecisionKind = "open" | "resolved";

/** Thrown by `pinDecision` when the session already holds this question; no id is allocated. */
export class DuplicateDecisionError extends Error {
  override readonly name = "DuplicateDecisionError";

  constructor(readonly id: number, readonly kind: DuplicateDecisionKind, message: string) {
    super(message);
  }
}

/** The question's identity: trimmed, one space between words, lower-cased. Options are not part of it. */
export function questionKey(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Where the session files live for this environment. */
export function decisionsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DECISIONS_DIR_ENV]?.trim();
  return configured || join(homedir(), ...DEFAULT_RELATIVE_DIRECTORY);
}

function sessionFile(directory: string, session: string): string {
  return join(directory, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function isPin(value: unknown): value is PinnedDecision {
  if (typeof value !== "object" || value === null) return false;
  const pin = value as Record<string, unknown>;
  return Number.isInteger(pin.id) && typeof pin.question === "string" && typeof pin.pinned_at === "string"
    && Array.isArray(pin.options) && pin.options.every((option) => typeof option === "string");
}

function isResolved(value: unknown): value is ResolvedDecision {
  if (typeof value !== "object" || value === null) return false;
  const resolved = value as Record<string, unknown>;
  return Number.isInteger(resolved.id) && typeof resolved.key === "string";
}

async function load(file: string): Promise<SessionPins> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); delete it to start the session's pins over`);
  }
  const pins = parsed as Partial<SessionPins> | null;
  if (pins === null || !Number.isInteger(pins.next_id) || !Array.isArray(pins.pins) || !pins.pins.every(isPin)) {
    throw new Error(`${file} is not a decision pin file`);
  }
  // A file written before the resolved memory existed has no list: it loads as empty, not as an error.
  const resolved = pins.resolved ?? [];
  if (!Array.isArray(resolved) || !resolved.every(isResolved)) {
    throw new Error(`${file} is not a decision pin file`);
  }
  return { next_id: pins.next_id as number, pins: pins.pins, resolved };
}

async function save(file: string, pins: SessionPins): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/** How long a read-modify-write waits for another process's lock before giving up. */
const LOCK_WAIT_MS = 5_000;
/** A lock file older than this belongs to a process that died; it is removed. */
const LOCK_STALE_MS = 15_000;

/** One read-modify-write at a time per session file across processes: a `<file>.lock` created exclusively. */
async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (Date.now() > deadline) throw new Error(`${file} is locked by another process; try again`);
    await sleep(25);
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/** One read-modify-write at a time per session file in this process, so concurrent pins never share an id. */
const pending = new Map<string, Promise<void>>();

function serialized<T>(file: string, work: () => Promise<T>): Promise<T> {
  const next = (pending.get(file) ?? Promise.resolve()).then(() => withFileLock(file, work));
  const settled = next.then(() => undefined, () => undefined);
  pending.set(file, settled);
  void settled.then(() => {
    if (pending.get(file) === settled) pending.delete(file);
  });
  return next;
}

/** The refusal `pinDecision` would throw for `question` in `current`, or undefined when it may be pinned. */
function duplicateOf(current: SessionPins, question: string): DuplicateDecisionError | undefined {
  const key = questionKey(question);
  const open = current.pins.find((held) => questionKey(held.question) === key);
  if (open !== undefined) {
    return new DuplicateDecisionError(open.id, "open", `decision ${open.id} is already open for this question: ${open.question}`);
  }
  const resolved = current.resolved.find((held) => held.key === key);
  if (resolved !== undefined) {
    return new DuplicateDecisionError(
      resolved.id,
      "resolved",
      `decision ${resolved.id} was already answered or dismissed for this question: ${question}`,
    );
  }
  return undefined;
}

/**
 * The refusal `pinDecision` would give for `question` right now, without pinning: lets a caller skip costly work for a
 * repeat. `pinDecision` stays the authority; this read takes no lock.
 */
export async function findDuplicate(
  directory: string,
  session: string,
  question: string,
): Promise<DuplicateDecisionError | undefined> {
  return duplicateOf(await load(sessionFile(directory, session)), question);
}

/**
 * Pins a decision in `session` and returns it with its id, the session's next number. A question already open or
 * already resolved in that session is refused with `DuplicateDecisionError` naming the id it had, and no id is
 * allocated: one question is one pin, and a question the user already answered is not asked again.
 */
export function pinDecision(
  directory: string,
  session: string,
  question: string,
  options: readonly string[],
  now: Date = new Date(),
): Promise<PinnedDecision> {
  const file = sessionFile(directory, session);
  return serialized(file, async () => {
    const current = await load(file);
    const duplicate = duplicateOf(current, question);
    if (duplicate !== undefined) throw duplicate;
    const pin: PinnedDecision = { id: current.next_id, question, options: [...options], pinned_at: now.toISOString() };
    await save(file, {
      next_id: current.next_id + 1,
      pins: [...current.pins, pin].slice(-MAX_PINNED),
      resolved: current.resolved,
    });
    return pin;
  });
}

/** Unpins `id` from `session` and remembers its question as answered or dismissed; undefined when there is no such pin. */
export function unpinDecision(directory: string, session: string, id: number): Promise<PinnedDecision | undefined> {
  const file = sessionFile(directory, session);
  return serialized(file, async () => {
    const current = await load(file);
    const found = current.pins.find((pin) => pin.id === id);
    if (found === undefined) return undefined;
    const resolved = [...current.resolved, { id: found.id, key: questionKey(found.question) }].slice(-MAX_RESOLVED);
    await save(file, { next_id: current.next_id, pins: current.pins.filter((pin) => pin.id !== id), resolved });
    return found;
  });
}

/** The session's pins, oldest first. */
export async function pinnedDecisions(directory: string, session: string): Promise<readonly PinnedDecision[]> {
  return (await load(sessionFile(directory, session))).pins;
}
