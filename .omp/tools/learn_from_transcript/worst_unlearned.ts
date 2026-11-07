// The source the learn chain learns from when the caller named none: the worst unlearned omp session of this machine's
// youngest pool. The pick is model-free (the triage score's deterministic waste floors rank the pool: active minutes, tool
// errors, cost), so it reads only this machine's own records:
//   - `<home>/.omp/agent/sessions/*/*_<uuid>.jsonl`: the pool;
//   - `<home>/.local/share/capability-replicas/learned.jsonl` (`conversation` per line) and
//     `<home>/.agents/learnings/launch.log` (`source` per line): what the sweep and the launcher already learned from,
//     read when the files exist and treated as empty when they do not (nothing Mastra-process-bound is needed);
//   - the annotated directory: every transcript a chain run annotated, and every PM conversation that ran far enough.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { annotatedDirectory } from "./annotated.js";
import { type SessionTelemetry, extractOmpSessionTelemetry, triageSessions } from "./triage.js";

/** The pool the pick considers: this machine's newest sessions, youngest first. */
export const YOUNGEST_POOL = 50;

/** omp session files end `_<uuid>.jsonl`; the uuid is the conversation's key. */
const OMP_SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/;

/** The artifact-name substitution annotated.ts's `safeFilename` applies; keep the two in step. */
const artifactSlug = (key: string): string => key.replace(/[^A-Za-z0-9._-]+/g, "_");

/** The local calendar day of `date`, the shape the telemetry's `day` field carries. */
function localDayOf(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Where the pick reads: a real run takes the defaults, a test names a temp machine. */
export interface MachineRecords {
  readonly home?: string;
  /** The directory the annotator writes to; default `annotatedDirectory()`. */
  readonly annotatedDir?: string;
  /** The omp session the pick itself runs in: it is this learn run's present, not its past. */
  readonly currentSessionId?: string;
}

/** The JSON-string values of `key` on each line of `path`, skipping lines that do not parse. */
async function keysIn(path: string, key: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return []; // This machine holds no such record yet.
  }
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = (JSON.parse(line) as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") keys.push(value);
    } catch {
      // One malformed line never hides the rest.
    }
  }
  return keys;
}

/** Every conversation the sweep's ledger and the launch log say this machine already learned from. */
async function learnedConversations(home: string, currentSessionId: string | undefined): Promise<Set<string>> {
  const seen = new Set<string>();
  if (currentSessionId) seen.add(`omp:${currentSessionId}`);
  for (const conversation of await keysIn(join(home, ".local", "share", "capability-replicas", "learned.jsonl"), "conversation")) {
    seen.add(conversation);
  }
  for (const conversation of await keysIn(join(home, ".agents", "learnings", "launch.log"), "source")) {
    seen.add(conversation);
  }
  return seen;
}

/**
 * The learn chain's own artifacts, as the sanitized names their files carry: every annotated transcript a run wrote
 * (`<key>-<digest>.annotated.json`) and every PM thread it ran far enough to review (`<key>.learn-from-transcript.pm.jsonl`,
 * at least 500 bytes). `key` is the conversation or, for a file-path source, the source path.
 */
async function learnedArtifactSlugs(directory: string): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const annotated = /^(.*)-[0-9a-f]{16}\.annotated\.json$/.exec(name);
    if (annotated !== null) {
      slugs.add(annotated[1]!);
      continue;
    }
    if (!name.endsWith(".learn-from-transcript.pm.jsonl")) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info !== undefined && info.size >= 500) {
      slugs.add(name.slice(0, -".learn-from-transcript.pm.jsonl".length));
    }
  }
  return slugs;
}

/** One omp session file of the youngest pool: its path, its conversation, and when it was last written. */
interface PoolSession {
  readonly path: string;
  readonly conversation: string;
  readonly mtimeMs: number;
}

/** This machine's newest `YOUNGEST_POOL` omp session files, youngest first. */
async function youngestPool(home: string): Promise<PoolSession[]> {
  const root = join(home, ".omp", "agent", "sessions");
  const pool: PoolSession[] = [];
  for (const project of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, project)).catch(() => [] as string[])) {
      const id = OMP_SESSION_FILE.exec(name)?.[1];
      if (id === undefined) continue;
      const path = join(root, project, name);
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && info.isFile()) pool.push({ path, conversation: `omp:${id}`, mtimeMs: info.mtimeMs });
    }
  }
  return pool.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, YOUNGEST_POOL);
}

/**
 * The worst unlearned session of the youngest pool, as a source the chain's transcript reader takes (the session file's
 * path). A pool with nothing selectable fails naming the pool's size, never a crash.
 */
export async function worstUnlearnedSource(records: MachineRecords = {}): Promise<string> {
  const home = records.home ?? homedir();
  const [learned, slugs] = await Promise.all([
    learnedConversations(home, records.currentSessionId),
    learnedArtifactSlugs(records.annotatedDir ?? annotatedDirectory()),
  ]);
  const candidates: SessionTelemetry[] = [];
  for (const session of await youngestPool(home)) {
    const alreadyLearned = learned.has(session.conversation)
      || slugs.has(artifactSlug(session.conversation))
      || slugs.has(artifactSlug(session.path));
    if (alreadyLearned) continue;
    const rawJsonl = await readFile(session.path, "utf8").catch(() => undefined);
    if (rawJsonl === undefined) continue; // vanished between the stat and the read
    const telemetry = extractOmpSessionTelemetry({
      conversation: session.conversation,
      source: session.path,
      day: localDayOf(new Date(session.mtimeMs)),
      rawJsonl,
    });
    if (telemetry === undefined) continue; // a learner/PM session itself
    if (telemetry.human_turns < 2 && telemetry.active_wall_minutes < 3) continue; // a probe, not a working session
    candidates.push(telemetry);
  }
  if (candidates.length === 0) throw new Error(`no unlearned session among the youngest ${YOUNGEST_POOL}`);
  const triaged = triageSessions(candidates, { limit: 1 });
  const selected = triaged.filter((session) => session.triage.selected);
  return (selected.length > 0 ? selected : triaged)[0]!.source;
}
