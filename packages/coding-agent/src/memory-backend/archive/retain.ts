/**
 * Retention for the `archive` backend: a session's own turns written back into
 * `public.memory_chunks`, so a later session recalls them.
 *
 * Shape mirrors `mnemopi/state.ts`: a per-session state subscribes to the session, reacts to
 * `agent_end`, counts user turns and writes once `retainEveryNTurns` of them are unretained.
 *
 * Hard rules this file keeps:
 *  - No model call on the write path: text is chunked, optionally embedded, and inserted.
 *  - Soft context: `repository` and `scope` are stored on every row and never used to exclude one.
 *  - Idempotent: a chunk's id is derived from the transcript path and its index, the insert is
 *    `on conflict (id) do nothing`, and the highest stored index for the path is read before writing,
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
/** Rows one round of writes sends concurrently. Writes within a round are independent (`do nothing` on conflict). */
const RETAIN_WRITE_CONCURRENCY = 8;
const SCOPE_SAH = "sah";
const SCOPE_ZYSYS = "zysys";
const SCOPE_PERSONAL = "personal";
const SAH_DIRECTORY = "/developer/software-automation-holdings/";
const ZYSYS_DIRECTORY = "/developer/zysys/";

const HIGHEST_INDEX_SQL = `select coalesce(max(chunk_index), -1) as highest
    from public.memory_chunks
   where session_path = $1 and kind = 'chunk'`;

const INSERT_CHUNK_SQL = `insert into public.memory_chunks
    (id, source, session_path, repository, scope, kind, occurred_at, chunk_index, body, embedding)
  values ($1, $2, $3, $4, $5, 'chunk', $6::timestamptz, $7::int, $8, $9::vector)
  on conflict (id) do nothing`;

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
 * The whole transcript as chunks, indexed from 0. A pure function of the messages, so the Nth chunk is
 * the same chunk on every call and a session that only grows keeps every earlier index stable. Secrets
 * are redacted before splitting so one cannot straddle a boundary and escape the pattern.
 */
export function archiveChunksOf(messages: readonly HindsightMessage[]): ArchiveChunk[] {
	const chunks: ArchiveChunk[] = [];
	for (const message of messages) {
		const header = `[role: ${message.role}]\n`;
		for (const piece of splitText(redactMemorySecrets(message.content), ARCHIVE_RETAIN_CHUNK_CHARS - header.length)) {
			chunks.push({ index: chunks.length, at: message.timestamp, body: `${header}${piece}` });
		}
	}
	return chunks;
}

/** A UUID-shaped id that is a pure function of the transcript path and chunk index. */
export function archiveChunkId(sessionPath: string, index: number): string {
	const hex = createHash("sha256").update(`${sessionPath}\u0000${index}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The slice of a session the retainer reads; `AgentSession` satisfies it. */
export interface ArchiveRetainSession {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly sessionManager: ReadonlySessionManagerLike & { getSessionFile(): string | undefined };
}

export interface ArchiveRetainerOptions {
	client: ArchiveClient;
	session: ArchiveRetainSession;
	repository: string | undefined;
	scope: string;
	/** Read on every `agent_end`, so a setting changed mid-session takes effect. */
	enabled: () => boolean;
	/** Read on every `agent_end`; below 1 counts as 1. */
	everyNTurns: () => number;
	/** Embeds one chunk; absent, or an undefined answer, leaves `embedding` null. */
	embed?: (text: string, signal?: AbortSignal) => Promise<readonly number[] | undefined>;
	now?: () => Date;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ArchiveRetainer {
	readonly #options: ArchiveRetainerOptions;
	#unsubscribe: (() => void) | undefined;
	#lastRetainedTurn = 0;
	/** Highest chunk index known to be stored for this transcript; undefined until the store is asked. */
	#storedThrough: number | undefined;
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
	 * (`force` skips the turn threshold). Resolves with how many chunks it submitted; never rejects.
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

			const storedThrough = this.#storedThrough ?? (await this.#highestStoredIndex(sessionPath));
			const fresh = archiveChunksOf(extractMessages(session.sessionManager)).filter(
				(chunk) => chunk.index > storedThrough,
			);
			this.#storedThrough = storedThrough;
			for (let start = 0; start < fresh.length; start += RETAIN_WRITE_CONCURRENCY) {
				const round = fresh.slice(start, start + RETAIN_WRITE_CONCURRENCY);
				await Promise.all(round.map((chunk) => this.#write(sessionPath, chunk)));
				this.#storedThrough = round[round.length - 1]?.index ?? this.#storedThrough;
			}
			this.#lastRetainedTurn = turns;
			return fresh.length;
		} catch (error) {
			logger.warn("archive: retention failed", { error: messageOf(error) });
			return 0;
		}
	}

	async #highestStoredIndex(sessionPath: string): Promise<number> {
		const [row] = await this.#options.client.query<{ highest: number | string | null }>(HIGHEST_INDEX_SQL, [
			sessionPath,
		]);
		const highest = Number(row?.highest ?? -1);
		return Number.isInteger(highest) ? highest : -1;
	}

	async #write(sessionPath: string, chunk: ArchiveChunk): Promise<void> {
		const embedding = await this.#embed(chunk.body);
		const occurredAt = chunk.at ?? (this.#options.now?.() ?? new Date()).toISOString();
		await this.#options.client.query(INSERT_CHUNK_SQL, [
			archiveChunkId(sessionPath, chunk.index),
			sessionPath,
			sessionPath,
			this.#options.repository ?? null,
			this.#options.scope,
			occurredAt,
			chunk.index,
			chunk.body,
			embedding === undefined ? null : `[${embedding.join(",")}]`,
		]);
	}

	/** A failed embed costs the chunk its vector, not its row: the lexical arm still finds it. */
	async #embed(text: string): Promise<readonly number[] | undefined> {
		const embed = this.#options.embed;
		if (embed === undefined) return undefined;
		try {
			const vector = await embed(text);
			return vector !== undefined && vector.length > 0 ? vector : undefined;
		} catch (error) {
			logger.debug("archive: chunk embedding failed", { error: messageOf(error) });
			return undefined;
		}
	}
}
