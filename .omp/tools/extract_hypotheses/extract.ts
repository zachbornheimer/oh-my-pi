import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { annotateSource } from "./annotate_sources.js";
import { annotatedDirectory, reviewPathOf, writeAnnotated } from "./annotated.js";
import { type AgentStep, mapLimit } from "./omp_session.js";
import type { TurnSource } from "./reader/turn_source.js";
import { sessionPrompt } from "./review_prompt.js";
import type { SessionExport } from "./session_export.js";

/** Reviews in flight at once. */
export const REVIEW_CONCURRENCY = 2;
/** Sources annotated at once. */
export const ANNOTATE_CONCURRENCY = 4;

/** One session's forensics review: the prose as the agent wrote it, and where it and the annotated export sit on disk. */
export interface Reviewed {
  conversation: string;
  annotated_path: string;
  review_path: string;
  report_markdown: string;
}

export interface ExtractDeps {
  /** Reads transcripts of `<harness>:<id>` refs. */
  transcripts: TurnSource;
  /** One full omp session: prompt in, the agent's reply out. */
  step: AgentStep;
  /** Home directory the shared instructions are read from. */
  home?: string;
  /** Progress lines. */
  log?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Annotates every source (an already-annotated export passes through as read), then reviews each session, two at a
 * time. A session's review is bought once: a non-blank review already at its path is reused, not asked again. Any
 * failure fails the whole call.
 */
export async function extractHypotheses(sources: readonly string[], deps: ExtractDeps): Promise<Reviewed[]> {
  const log = deps.log ?? (() => {});
  const sessions = await mapLimit(sources, ANNOTATE_CONCURRENCY, async (source) => {
    deps.signal?.throwIfAborted();
    return (await annotateSource(source, "default", deps.transcripts)).session;
  });
  log(`annotated ${sessions.length} session(s)`);
  return mapLimit(sessions, REVIEW_CONCURRENCY, (session) => reviewSession(session, deps));
}

/** One review: the export goes to disk, the forensics agent reads it with its tools, and the report goes to disk beside it. */
export async function reviewSession(session: SessionExport, deps: ExtractDeps): Promise<Reviewed> {
  const log = deps.log ?? (() => {});
  deps.signal?.throwIfAborted();
  await mkdir(annotatedDirectory(), { recursive: true });
  const annotated_path = await writeAnnotated(session);
  const review_path = reviewPathOf(session.conversation);
  const kept = await readFile(review_path, "utf8").catch(() => "");
  if (kept.trim() !== "") {
    log(`review ${session.conversation}: reusing the ${kept.length}-character review at ${review_path}`);
    return { conversation: session.conversation, annotated_path, review_path, report_markdown: kept };
  }
  log(`review ${session.conversation}: asking the forensics agent about ${annotated_path}`);
  const text = await deps.step(await sessionPrompt(annotated_path, deps.home ?? homedir()), deps.signal);
  if (text.trim() === "") throw new Error(`review ${session.conversation}: the forensics agent returned an empty review`);
  await writeFile(review_path, text);
  log(`review ${session.conversation}: ${text.length} characters of review written to ${review_path}`);
  return { conversation: session.conversation, annotated_path, review_path, report_markdown: text };
}