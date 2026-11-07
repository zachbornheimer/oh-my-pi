import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileLock, type Lock } from "./file_lock.js";
import { delegateToolCall, type Exec } from "./omp_delegate.js";
import { ompModelStep, mapLimit } from "./omp_model.js";
import {
  alreadyLearnedConversations,
  type Chosen,
  DEFAULT_MAX_TRANSCRIPTS,
  localDay,
  modelScorer,
  remember,
  selectWorstUnlearnedSessions,
} from "./triage.js";

/** One session's learning as the nightly log records it. */
export interface Learning {
  conversation: string;
  review_path: string;
  answer_markdown: string;
  commits: { repo: string; sha: string }[];
  /** Shas the answer named that no repository holds: a claim, not a commit. */
  unverified_shas: string[];
}

export interface Settings {
  sources?: string[];
  hours: number;
  max_transcripts: number;
  force: boolean;
  run_optimize_tooling: boolean;
  apply: boolean;
  optimize_limit: number;
}
export const DEFAULTS = { hours: 72, max_transcripts: DEFAULT_MAX_TRANSCRIPTS, force: false, run_optimize_tooling: false, apply: true, optimize_limit: 4 } as const;

/** Applies the defaults and bounds of the Mastra input schema; throws on a value outside them. */
export function settingsOf(input: Partial<Record<keyof Settings, unknown>>): Settings {
  const positive = (key: "hours" | "max_transcripts" | "optimize_limit"): number => {
    const value = input[key] ?? DEFAULTS[key];
    if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${key} must be a positive integer`);
    return value as number;
  };
  const flag = (key: "force" | "run_optimize_tooling" | "apply"): boolean => {
    const value = input[key] ?? DEFAULTS[key];
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    return value;
  };
  const sources = input.sources;
  if (sources !== undefined && (!Array.isArray(sources) || sources.some((s) => typeof s !== "string" || s === ""))) {
    throw new Error("sources must be non-empty strings");
  }
  return {
    ...(sources === undefined ? {} : { sources: sources as string[] }),
    hours: positive("hours"),
    max_transcripts: positive("max_transcripts"),
    force: flag("force"),
    run_optimize_tooling: flag("run_optimize_tooling"),
    apply: flag("apply"),
    optimize_limit: positive("optimize_limit"),
  };
}

export const LEARN_TIMEOUT_MS = 45 * 60 * 1000;
export const LEARN_CONCURRENCY = 5;
const OPTIMIZE_TIMEOUT_MS = 3 * 3_600_000;

export const lockFile = (home: string = homedir()): string =>
  process.env.RSI_LOCK_FILE ?? join(home, "Library", "Caches", "recursive-self-improvement", "lock");
export const nightlyLog = (home: string = homedir()): string => join(home, ".local", "share", "capability-replicas", "nightly.log");

/** One line per learning: what was learned from, what the applier answered, what was verified. */
export function learningLines(learnings: readonly Learning[]): string[] {
  return learnings.map(
    (learning) =>
      `  ${learning.conversation}: review ${learning.review_path}; answer ${learning.answer_markdown.length} chars; `
      + `${learning.commits.length} commit(s) verified${
        learning.commits.length === 0 ? "" : ` (${learning.commits.map((commit) => commit.sha.slice(0, 12)).join(", ")})`
      }; ${learning.unverified_shas.length} sha(s) unverified`,
  );
}
export function learningText(at: string, learnings: readonly Learning[]): string {
  return [`${at} nightly: ${learnings.length} learning(s)`, ...learningLines(learnings)].join("\n") + "\n";
}

export interface Ports {
  alreadyLearned(): Promise<Set<string>>;
  select(options: { max: number; hours: number }, signal?: AbortSignal): Promise<Chosen[]>;
  remember(chosen: readonly Chosen[]): Promise<void>;
  /** Learns from one transcript; resolves with the filing headline, rejects when the learn run fails or times out. */
  learn(conversation: string, signal?: AbortSignal): Promise<string>;
  /** Runs optimize_tooling and answers the one-line summary. */
  optimize(options: { apply: boolean; limit: number }, signal?: AbortSignal): Promise<string>;
  append(path: string, text: string): Promise<void>;
  lock: Lock;
  logPath: string;
  now: () => Date;
  signal?: AbortSignal;
  onPhase?: (phase: string) => void;
}

export interface RsiOutput {
  /** `busy`: another run holds the lock and nothing was done; `done`: the run finished (learnings may be empty). */
  status: "done" | "busy";
  learnings: Learning[];
  optimize: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function failedLearning(conversation: string, text: string): Learning {
  return { conversation, review_path: "", answer_markdown: text, commits: [], unverified_shas: [] };
}

/**
 * Lock, choose sessions (the explicit `sources` not yet learned, else the worst unlearned ones by model triage), learn from each
 * (`LEARN_CONCURRENCY` at a time, `LEARN_TIMEOUT_MS` each), record the sessions learned from, optionally run optimize_tooling,
 * append one nightly line. The lock is released in every case.
 */
export async function recursiveSelfImprovement(settings: Settings, ports: Ports): Promise<RsiOutput> {
  const runId = randomUUID();
  if (!(await ports.lock.acquire({ runId, ticket: "recursive-self-improvement" })).held) {
    return { status: "busy", learnings: [], optimize: "skipped: another run holds the lock" };
  }
  try {
    const already = settings.force ? new Set<string>() : await ports.alreadyLearned();
    let chosen: Chosen[];
    if (settings.sources !== undefined && settings.sources.length > 0) {
      const today = localDay(ports.now());
      chosen = settings.sources
        .filter((source) => !already.has(source))
        .map((source) => ({ conversation: source, source, export: source, day: today, bytes: 0, human_turns: 0 }));
    } else {
      ports.onPhase?.("choosing the worst unlearned sessions");
      chosen = await ports.select({ max: settings.max_transcripts, hours: settings.hours }, ports.signal);
    }

    const learnings = await mapLimit(chosen, LEARN_CONCURRENCY, async (session) => {
      ports.onPhase?.(`learning from ${session.conversation}`);
      try {
        const headline = await ports.learn(session.conversation, ports.signal);
        // Only a session whose learn run answered is remembered: a failed one is tried again next time.
        await ports.remember([session]).catch(() => undefined);
        return failedLearning(session.conversation, headline);
      } catch (error) {
        ports.signal?.throwIfAborted();
        return failedLearning(session.conversation, `(learn_from_transcript failed: ${messageOf(error)})`);
      }
    });

    let optimize = "optimize_tooling skipped";
    if (settings.run_optimize_tooling) {
      ports.onPhase?.("running optimize_tooling");
      try {
        optimize = await ports.optimize({ apply: settings.apply, limit: settings.optimize_limit }, ports.signal);
      } catch (error) {
        ports.signal?.throwIfAborted();
        optimize = `optimize_tooling error: ${messageOf(error)}`;
      }
    }
    const results: Learning[] =
      learnings.length > 0
        ? learnings.map((l) => ({ ...l, answer_markdown: `${l.answer_markdown} | ${optimize}` }))
        : [{ conversation: "optimize_tooling", review_path: ports.logPath, answer_markdown: optimize, commits: [], unverified_shas: [] }];
    // A heartbeat that cannot be written is reported to the caller, not swallowed: a night with no line must mean no run.
    await ports.append(ports.logPath, learningText(ports.now().toISOString(), results));
    return { status: "done", learnings: results, optimize };
  } finally {
    await ports.lock.release(runId);
  }
}

// ---- live ports ---------------------------------------------------------------------------------------------------------

/** The answer of the native `learn_from_transcript` tool, reduced to one headline. */
export function headlineOf(value: Record<string, unknown>): string {
  if (typeof value.headline === "string" && value.headline !== "") return value.headline;
  if (Array.isArray(value.tickets)) return `${value.tickets.length} ticket(s) filed`;
  throw new Error("learn_from_transcript answered neither a headline nor a tickets array");
}

/** The answer of the native `optimize_tooling` tool as one line. */
export function optimizeSummaryOf(value: Record<string, unknown>): string {
  const runs = value.runs;
  if (typeof value.status !== "string" || !Array.isArray(runs)) throw new Error("optimize_tooling answer has no status and runs");
  const worked = runs.map((run) => `${(run as { ticket?: unknown }).ticket}=${(run as { outcome?: unknown }).outcome}`).join(", ");
  return `optimize_tooling=${value.status} (${worked || "no ticket worked"})`;
}

export function livePorts(exec: Exec, signal?: AbortSignal, onPhase?: (phase: string) => void): Ports {
  const scorer = modelScorer(ompModelStep(exec));
  return {
    alreadyLearned: () => alreadyLearnedConversations(),
    select: (options, abort) => selectWorstUnlearnedSessions({ ...options, scorer, signal: abort }),
    remember: async (chosen) => void (await remember(chosen)),
    learn: (conversation, abort) =>
      delegateToolCall(exec, {
        tool: "learn_from_transcript",
        args: { source: conversation, dispatch: false, run_optimize_tooling: false },
        validate: headlineOf,
        timeoutMs: LEARN_TIMEOUT_MS,
        signal: abort,
      }),
    optimize: (options, abort) =>
      delegateToolCall(exec, {
        tool: "optimize_tooling",
        args: { apply: options.apply, limit: options.limit },
        validate: optimizeSummaryOf,
        timeoutMs: OPTIMIZE_TIMEOUT_MS,
        signal: abort,
      }),
    append: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text);
    },
    lock: fileLock(lockFile()),
    logPath: nightlyLog(),
    now: () => new Date(),
    signal,
    onPhase,
  };
}
