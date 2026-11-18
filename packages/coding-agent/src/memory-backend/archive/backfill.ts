/**
 * Backfill for the `archive` backend: chunks the transcripts already stored in
 * `public.omp_session_files` / `public.omp_session_files_entries` into `public.memory_chunks`, for
 * the stretch of work that was never retained (earlier ingestion stopped on 2026-11-07, and live
 * retention only covers sessions that settle after it was switched on).
 *
 * It reuses `retain.ts` for everything that decides what a row is: the same message extraction,
 * `archiveChunksOf`, `archiveChunkId`, cursor and insert as live retention, so a backfilled row and a
 * live-retained row for the same transcript are indistinguishable and never duplicate each other.
 *
 * No model call; rows land without an embedding unless the caller passes an embedder. Context
 * (`repository`, `scope`) is stored on every row and never decides whether one is written. One
 * unreadable or refused transcript is logged and counted, and the walk continues.
 */

import { homedir } from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
import type { HindsightMessage } from "../../hindsight/content";
import { extractMessages, type ReadonlySessionManagerLike } from "../../hindsight/transcript";
import type { SessionEntry } from "../../session/session-entries";
import { archiveRepositoryOf } from "./backend.js";
import type { ArchiveClient } from "./client.js";
import {
	type ArchiveWriteOptions,
	archiveCursorOf,
	archiveFreshChunks,
	archiveScopeOf,
	archiveWriteChunks,
} from "./retain.js";

/** Transcript rows whose file is newer than the last chunk stored for it (or that have no chunk at all), newest first. */
const CANDIDATES_SQL = `select f.path, f.mtime_ms::text as mtime_ms
    from public.omp_session_files f
    left join (
      select session_path, max(occurred_at) as last_at
        from public.memory_chunks
       where kind = 'chunk'
       group by session_path
    ) m on m.session_path = f.path
   where f.mtime_ms >= $1::bigint
     and (m.last_at is null or f.mtime_ms > (extract(epoch from m.last_at) * 1000)::bigint)
   order by f.mtime_ms desc`;

const TRANSCRIPT_CONTENT_SQL =
	"select coalesce((select string_agg(e.line, '' order by e.seq asc) from public.omp_session_files_entries e where e.path = s.path), '') || (select content from public.omp_session_files where path = s.path) as content from public.omp_session_files s where s.path = $1";

/** Session directories that hold scratch work, not a project: omp names them after the working directory. */
const NOISE_SESSION_DIRECTORY = /^(?:-tmp|--private-tmp-|-empty)(?:-.*)?$/;
/** A session's own directory (`<timestamp>_<id>`); a transcript inside one is a subagent's. */
const SESSION_DIRECTORY = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+$/;
const ADVISOR_TRANSCRIPT_PREFIX = "__advisor";
const NOISE_WORKING_DIRECTORIES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const SESSIONS_SEGMENT = "/sessions/";

export type ArchiveBackfillSkip = "not-transcript" | "scratch-directory" | "advisor" | "subagent" | "scratch-cwd";

/** Why a transcript path is not worth archiving, or undefined when it is. Pure; looks at the path only. */
export function archiveBackfillSkipOf(path: string): ArchiveBackfillSkip | undefined {
	if (!path.endsWith(".jsonl")) return "not-transcript";
	const segments = path.split("/");
	const name = segments[segments.length - 1] ?? "";
	if (name.startsWith(ADVISOR_TRANSCRIPT_PREFIX)) return "advisor";
	if (NOISE_WORKING_DIRECTORIES.some((directory) => path.startsWith(directory))) return "scratch-directory";
	const sessions = path.indexOf(SESSIONS_SEGMENT);
	if (sessions >= 0) {
		const projectDirectory = path.slice(sessions + SESSIONS_SEGMENT.length).split("/")[0] ?? "";
		if (NOISE_SESSION_DIRECTORY.test(projectDirectory)) return "scratch-directory";
	}
	if (segments.slice(0, -1).some((segment) => SESSION_DIRECTORY.test(segment))) return "subagent";
	return undefined;
}

/** What a transcript says about where it ran, and its turns in the shape `extractMessages` yields. */
export interface ArchiveTranscript {
	cwd: string | undefined;
	messages: HindsightMessage[];
}

/**
 * Reads session JSONL. Only the header and user/assistant message lines are parsed: a transcript can
 * be hundreds of megabytes, almost all of it tool output the archive does not keep, so every other
 * line is passed over unparsed. A line that does not parse is skipped.
 */
export function archiveParseTranscript(content: string): ArchiveTranscript {
	let cwd: string | undefined;
	const entries: SessionEntry[] = [];
	let start = 0;
	while (start < content.length) {
		let end = content.indexOf("\n", start);
		if (end < 0) end = content.length;
		const line = content.slice(start, end);
		start = end + 1;
		if (cwd === undefined && line.includes('"type":"session"')) {
			try {
				const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
				if (header.type === "session" && typeof header.cwd === "string" && header.cwd !== "") cwd = header.cwd;
			} catch {
				// A damaged header costs the cwd, not the turns.
			}
			continue;
		}
		if (!line.includes('"type":"message"')) continue;
		if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
		try {
			const entry = JSON.parse(line) as SessionEntry;
			if (entry.type === "message") entries.push(entry);
		} catch {
			// A torn line (a live transcript is appended to) is skipped.
		}
	}
	const manager: ReadonlySessionManagerLike = { getEntries: () => entries };
	return { cwd, messages: extractMessages(manager) };
}

export interface ArchiveBackfillOptions extends ArchiveWriteOptions {
	client: ArchiveClient;
	/** Report what would be written without writing it. */
	dryRun?: boolean;
	/** Stop after this many transcripts have been examined (after noise is dropped). */
	limit?: number;
	/** Only transcripts modified at or after this instant. */
	since?: Date;
	/** Overrides the home directory the scope mapping is relative to. */
	home?: string;
	/** Called once per examined transcript with a one-line outcome. */
	onTranscript?: (line: string) => void;
}

export interface ArchiveBackfillReport {
	/** Transcripts the store lists as newer than what is archived for them. */
	listed: number;
	/** Skipped by path or working directory, by reason. */
	skipped: Partial<Record<ArchiveBackfillSkip, number>>;
	/** Examined: read, parsed and compared with the store. */
	considered: number;
	/** Examined and already fully archived. */
	upToDate: number;
	/** Transcripts with at least one chunk written (or, on a dry run, that would be written). */
	sessionsWritten: number;
	/** Chunks that landed; on a dry run, chunks that would be written. */
	chunks: number;
	/** Transcripts that could not be read or written; each is logged. */
	failed: number;
	dryRun: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Walks the store's transcripts, newest first, and writes the chunks each one is missing. Resumable and
 * idempotent: what is written is decided from the store each time, so a rerun writes nothing new.
 * Throws only when the store cannot be listed; a single transcript's failure is counted and logged.
 */
export async function archiveBackfill(options: ArchiveBackfillOptions): Promise<ArchiveBackfillReport> {
	const { client } = options;
	if (client.url === undefined) {
		throw new Error("archive backfill: no connection string (set SESSIONS_DB_URL or write the dev-env session store url)");
	}
	const dryRun = options.dryRun === true;
	const home = options.home ?? homedir();
	const report: ArchiveBackfillReport = {
		listed: 0,
		skipped: {},
		considered: 0,
		upToDate: 0,
		sessionsWritten: 0,
		chunks: 0,
		failed: 0,
		dryRun,
	};
	const skip = (reason: ArchiveBackfillSkip) => {
		report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
	};
	const since = options.since === undefined ? 0 : options.since.getTime();
	const candidates = await client.query<{ path: string; mtime_ms: string }>(CANDIDATES_SQL, [String(since)]);
	report.listed = candidates.length;

	for (const { path } of candidates) {
		if (options.limit !== undefined && report.considered >= options.limit) break;
		const byPath = archiveBackfillSkipOf(path);
		if (byPath !== undefined) {
			skip(byPath);
			continue;
		}
		let counted = false;
		try {
			const [row] = await client.query<{ content: string }>(TRANSCRIPT_CONTENT_SQL, [path]);
			if (row === undefined) throw new Error("the transcript row was deleted after it was listed");
			const { cwd, messages } = archiveParseTranscript(row.content);
			if (cwd !== undefined && NOISE_WORKING_DIRECTORIES.some((directory) => `${cwd}/`.startsWith(directory))) {
				skip("scratch-cwd");
				continue;
			}
			report.considered++;
			counted = true;
			const cursor = await archiveCursorOf(client, path);
			const fresh = archiveFreshChunks(messages, cursor);
			if (fresh.length === 0) {
				report.upToDate++;
				options.onTranscript?.(`current  ${path}`);
				continue;
			}
			const landed = dryRun
				? fresh.length
				: await archiveWriteChunks(
						client,
						{
							sessionPath: path,
							repository: cwd === undefined ? undefined : archiveRepositoryOf(cwd),
							scope: archiveScopeOf(cwd ?? "", home),
						},
						fresh,
						options,
					);
			report.chunks += landed;
			if (landed > 0) report.sessionsWritten++;
			options.onTranscript?.(`${dryRun ? "would    " : "wrote    "}${landed} ${path}`);
		} catch (error) {
			if (!counted) report.considered++;
			report.failed++;
			logger.warn("archive: backfill skipped a transcript", { path, error: messageOf(error) });
			options.onTranscript?.(`failed   ${path}: ${messageOf(error)}`);
		}
	}
	return report;
}
