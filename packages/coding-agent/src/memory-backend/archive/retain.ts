/**
 * Retention for the `archive` backend: a session's own turns written back into
 * `public.memory_chunks`, so a later session recalls them.
 *
 * Shape mirrors `mnemopi/state.ts`: a per-session state subscribes to the session, reacts to
 * `agent_end`, counts user turns and writes once `retainEveryNTurns` of them are unretained.
 * `backfill.ts` reuses the chunking, cursor and write helpers below for transcripts that are already
 * on disk, so live retention and backfill agree on ids and on what counts as already stored.
 *
 * Hard rules this file keeps:
 *  - No model call on the write path: text is chunked, optionally embedded, and inserted.
 *  - Soft context: `repository` and `scope` are stored on every row and never used to exclude one.
 *  - Idempotent: a chunk's id is derived from the transcript path and its index, the insert is
 *    `on conflict (id) do nothing`, and a cursor read from the store decides what is still unwritten,
 *    so a resumed session neither duplicates nor re-embeds what it already wrote.
 *  - Never fails the session: every error is logged and swallowed.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
import type { HindsightMessage } from "../../hindsight/content";
import { countUserTurns, extractMessages, type ReadonlySessionManagerLike } from "../../hindsight/transcript";
import type { AgentSessionEvent } from "../../session/agent-session";
import { redactMemorySecrets } from "../redact";
import type { ArchiveClient } from "./client.js";

/** A chunk's ceiling in characters, header included; matches the ceiling a recalled hit shows whole. */
export const ARCHIVE_RETAIN_CHUNK_CHARS = 4000;
/** `source` of every row written here; earlier ingestion used `omp` for the same transcripts. */
export const ARCHIVE_RETAIN_SOURCE = "omp";
const SCOPE_SAH = "sah";
const SCOPE_ZYSYS = "zysys";
const SCOPE_PERSONAL = "personal";
const SAH_DIRECTORY = "/developer/software-automation-holdings/";
const ZYSYS_DIRECTORY = "/developer/zysys/";

/** A transcript's first and last stored chunk: enough to tell who wrote it and how far it got. */
const CURSOR_SQL = `select chunk_index, occurred_at, id
    from public.memory_chunks
   where session_path = $1 and kind = 'chunk'
     and (chunk_index = 0
          or chunk_index = (select max(chunk_index) from public.memory_chunks where session_path = $1 and kind = 'chunk'))
   order by chunk_index`;

const INSERT_CHUNK_SQL = `insert into public.memory_chunks
    (id, source, session_path, repository, scope, kind, occurred_at, chunk_index, body, embedding)
  values ($1, $2, $3, $4, $5, 'chunk', $6::timestamptz, $7::int, $8, $9::vector)
  on conflict (id) do nothing
  returning id`;

/** The scope label for a directory: `sah`, `zysys`, else `personal`. Case-insensitive, like the disk. */
export function archiveScopeOf(cwd: string, home: string = homedir()): string {
	const normalized = `${cwd.replaceAll("\\", "/").replace(/\/+$/, "")}/`.toLowerCase();
	const base = `${home.replaceAll("\\", "/").replace(/\/+$/, "")}`.toLowerCase();
	if (normalized.startsWith(`${base}${SAH_DIRECTORY}`)) return SCOPE_SAH;
	if (normalized.startsWith(`${base}${ZYSYS_DIRECTORY}`)) return SCOPE_ZYSYS;
	return SCOPE_PERSONAL;
}

/** One stored row's worth of a session: the Nth chunk of its transcript. */
export interface ArchiveChunk {
	index: number;
	/** Entry timestamp of the message the chunk came from, when it had one. */
	at: string | undefined;
	body: string;
}

/** Splits `text` into pieces of at most `limit` characters, preferring a line break past the halfway mark. */
function splitText(text: string, limit: number): string[] {
	const pieces: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = limit;
		const last = rest.charCodeAt(cut - 1);
		if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
		pieces.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
}

/**
 * The messages as chunks, numbered from `firstIndex`. A pure function of its input, so the Nth chunk of
 * a whole transcript is the same chunk on every call and a session that only grows keeps every earlier
 * index stable. Secrets are redacted before splitting so one cannot straddle a boundary and escape the
 * pattern.
 */
export function archiveChunksOf(messages: readonly HindsightMessage[], firstIndex = 0): ArchiveChunk[] {
	const chunks: ArchiveChunk[] = [];
	for (const message of messages) {
		const header = `[role: ${message.role}]\n`;
		for (const piece of splitText(redactMemorySecrets(message.content), ARCHIVE_RETAIN_CHUNK_CHARS - header.length)) {
			chunks.push({ index: firstIndex + chunks.length, at: message.timestamp, body: `${header}${piece}` });
		}
	}
	return chunks;
}

/** A UUID-shaped id that is a pure function of the transcript path and chunk index. */
export function archiveChunkId(sessionPath: string, index: number): string {
	const hex = createHash("sha256").update(`${sessionPath}\u0000${index}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * How far a transcript is stored. `native` means every chunk was numbered by {@link archiveChunksOf}
 * from the start of the transcript, so the index alone says what is stored. Earlier ingestion cut the
 * same transcripts differently (and wrote 32-hex ids); on such a path the index only says where to
 * continue numbering, and message time says which turns are new.
 */
export interface ArchiveCursor {
	/** Highest stored `chunk_index`; -1 when nothing is stored. */
	index: number;
	/** `occurred_at` of that chunk, as an ISO instant. */
	at: string | undefined;
	native: boolean;
}

interface CursorRow {
	chunk_index: number | string;
	occurred_at: string | Date;
	id: string;
}

/** Reads the cursor for `sessionPath`; throws when the store refuses. */
export async function archiveCursorOf(client: ArchiveClient, sessionPath: string): Promise<ArchiveCursor> {
	const rows = await client.query<CursorRow>(CURSOR_SQL, [sessionPath]);
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (first === undefined || last === undefined) return { index: -1, at: undefined, native: true };
	const index = Number(last.chunk_index);
	const at = new Date(last.occurred_at);
	return {
		index,
		at: Number.isNaN(at.getTime()) ? undefined : at.toISOString(),
		native:
			Number(first.chunk_index) === 0 &&
			first.id === archiveChunkId(sessionPath, 0) &&
			last.id === archiveChunkId(sessionPath, index),
	};
}

/** The chunks of `messages` that `cursor` says are not stored yet. */
export function archiveFreshChunks(
	messages: readonly HindsightMessage[],
	cursor: ArchiveCursor,
): ArchiveChunk[] {
	if (cursor.index < 0) return archiveChunksOf(messages);
	if (cursor.native) return archiveChunksOf(messages).filter((chunk) => chunk.index > cursor.index);
	const after = cursor.at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(cursor.at);
	return archiveChunksOf(
		messages.filter((message) => message.timestamp !== undefined && Date.parse(message.timestamp) > after),
		cursor.index + 1,
	);
}

/** Where and as whom a transcript's chunks are written. */
export interface ArchiveChunkTarget {
	sessionPath: string;
	repository: string | undefined;
	scope: string;
}

export interface ArchiveWriteOptions {
	/** Embeds one chunk; absent, or an undefined answer, leaves `embedding` null. */
	embed?: (text: string, signal?: AbortSignal) => Promise<readonly number[] | undefined>;
	now?: () => Date;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A failed embed costs the chunk its vector, not its row: the lexical arm still finds it. */
async function embedChunk(text: string, embed: ArchiveWriteOptions["embed"]): Promise<readonly number[] | undefined> {
	if (embed === undefined) return undefined;
	try {
		const vector = await embed(text);
		return vector !== undefined && vector.length > 0 ? vector : undefined;
	} catch (error) {
		logger.debug("archive: chunk embedding failed", { error: messageOf(error) });
		return undefined;
	}
}

/**
 * Inserts `chunks` in index order and stops at the first failure (it throws), so what is stored is
 * always a prefix of what was meant and the next cursor read resumes exactly after it. Resolves with
 * how many rows landed; a chunk another writer already stored is not counted.
 */
export async function archiveWriteChunks(
	client: ArchiveClient,
	target: ArchiveChunkTarget,
	chunks: readonly ArchiveChunk[],
	options: ArchiveWriteOptions = {},
): Promise<number> {
	let landed = 0;
	for (const chunk of chunks) {
		const embedding = await embedChunk(chunk.body, options.embed);
		const rows = await client.query(INSERT_CHUNK_SQL, [
			archiveChunkId(target.sessionPath, chunk.index),
			ARCHIVE_RETAIN_SOURCE,
			target.sessionPath,
			target.repository ?? null,
			target.scope,
			chunk.at ?? (options.now?.() ?? new Date()).toISOString(),
			chunk.index,
			chunk.body,
			embedding === undefined ? null : `[${embedding.join(",")}]`,
		]);
		landed += rows.length;
	}
	return landed;
}

/** The slice of a session the retainer reads; `AgentSession` satisfies it. */
export interface ArchiveRetainSession {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly sessionManager: ReadonlySessionManagerLike & { getSessionFile(): string | undefined };
}

export interface ArchiveRetainerOptions extends ArchiveWriteOptions {
	client: ArchiveClient;
	session: ArchiveRetainSession;
	repository: string | undefined;
	scope: string;
	/** Read on every `agent_end`, so a setting changed mid-session takes effect. */
	enabled: () => boolean;
	/** Read on every `agent_end`; below 1 counts as 1. */
	everyNTurns: () => number;
}

export class ArchiveRetainer {
	readonly #options: ArchiveRetainerOptions;
	#unsubscribe: (() => void) | undefined;
	#lastRetainedTurn = 0;
	/** `agent_end` events can overlap a slow write; runs are serialized so the cursor is never raced. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: ArchiveRetainerOptions) {
		this.#options = options;
	}

	attach(): void {
		this.detach();
		this.#unsubscribe = this.#options.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") void this.retain();
		});
	}

	detach(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	/**
	 * Writes the transcript's unretained chunks when retention is on and enough user turns have passed
	 * (`force` skips the turn threshold). Resolves with how many rows landed; never rejects.
	 */
	retain(force = false): Promise<number> {
		const run = this.#queue.then(() => this.#retainOnce(force));
		this.#queue = run;
		return run;
	}

	async #retainOnce(force: boolean): Promise<number> {
		try {
			const { client, session } = this.#options;
			if (!this.#options.enabled() || client.url === undefined) return 0;
			const sessionPath = session.sessionManager.getSessionFile();
			if (sessionPath === undefined) return 0;
			const turns = countUserTurns(session.sessionManager);
			const threshold = Math.max(1, Math.floor(this.#options.everyNTurns()));
			if (turns <= this.#lastRetainedTurn || (!force && turns - this.#lastRetainedTurn < threshold)) return 0;

			const cursor = await archiveCursorOf(client, sessionPath);
			const fresh = archiveFreshChunks(extractMessages(session.sessionManager), cursor);
			const landed = await archiveWriteChunks(
				client,
				{ sessionPath, repository: this.#options.repository, scope: this.#options.scope },
				fresh,
				this.#options,
			);
			this.#lastRetainedTurn = turns;
			return landed;
		} catch (error) {
			logger.warn("archive: retention failed", { error: messageOf(error) });
			return 0;
		}
	}
}
