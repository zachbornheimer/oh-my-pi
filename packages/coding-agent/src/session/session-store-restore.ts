/**
 * Restore a session file that exists only in the shared session store.
 *
 * A resume key is resolved by listing the local `*.jsonl` files, so a session
 * whose transcript lives only in the store behind `SESSIONS_DB_URL`
 * (`omp_session_files`, the table `SqlSessionStorage` writes) matches nothing
 * and `--resume` reports "Session ... not found". The resume path calls this
 * before it gives up: the stored row is written back to the path it records,
 * which every later step (listing, continuation scanning, the session manager)
 * already handles as an ordinary file.
 */
import { mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { SQL } from "bun";
import { $env } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** A session file is written as `<time>_<id>.jsonl`. */
const SESSION_FILE = /_([0-9a-z-]{8,})\.jsonl$/i;

/**
 * The one row lookup this module makes. The table is `omp_session_files` — the
 * one `SqlSessionStorage` writes by default — named literally so no identifier
 * is ever interpolated into SQL; the id itself is bound as `$1`.
 */
const SELECT_STORED =
	"SELECT path, content, mtime_ms FROM omp_session_files WHERE path LIKE $1 ORDER BY mtime_ms DESC LIMIT 1";

/** The store client this module needs: one row lookup, nothing else. */
export interface SessionStoreClient {
	unsafe(query: string, values?: unknown[]): Promise<unknown>;
	close?(): Promise<void>;
}

export interface RestoreSessionOptions {
	/** Store URL; defaults to `SESSIONS_DB_URL`. */
	databaseUrl?: string;
	/** Store client; its owner closes it. Tests inject one. */
	client?: SessionStoreClient;
}

interface StoredRow {
	path: string;
	content: string;
	mtime_ms: number | string;
}

/** The id in `<time>_<id>.jsonl`, or the key itself when it already is an id. */
function sessionIdOf(sessionArg: string): string | undefined {
	const match = SESSION_FILE.exec(basename(sessionArg));
	if (match) return match[1];
	return /^[0-9a-z-]{8,}$/i.test(sessionArg) ? sessionArg : undefined;
}

/** Modification time in milliseconds, or -1 when the file is not there. */
function storedMtime(path: string): number {
	try {
		return Math.trunc(statSync(path).mtimeMs);
	} catch {
		return -1;
	}
}

/**
 * Write the stored transcript named by `sessionArg` — an id, or a path ending in
 * `_<id>.jsonl` — back to the local path its row records, when that copy is
 * missing or older. Returns the path it restored, or `undefined` when the store
 * holds nothing newer. Never throws: a resume must fail on its own diagnostics,
 * not on a store error.
 */
export async function restoreSessionFromStore(
	sessionArg: string,
	options: RestoreSessionOptions = {},
): Promise<string | undefined> {
	const id = sessionIdOf(sessionArg);
	if (!id) return undefined;
	const databaseUrl = options.databaseUrl ?? $env.SESSIONS_DB_URL?.trim();
	const ownsClient = options.client === undefined;
	const client = options.client ?? (databaseUrl ? new SQL(databaseUrl) : undefined);
	if (!client) return undefined;
	try {
		// The id is matched loosely (`_` is LIKE's single-character wildcard) and
		// confirmed below, so no dialect-specific escaping is involved.
		const rows = (await client.unsafe(SELECT_STORED, [`%_${id}.jsonl`])) as StoredRow[];
		const row = rows[0];
		if (!row || !basename(row.path).endsWith(`_${id}.jsonl`)) return undefined;
		const diskMtime = storedMtime(row.path);
		if (diskMtime >= Number(row.mtime_ms)) return undefined;
		mkdirSync(dirname(row.path), { recursive: true });
		await Bun.write(row.path, row.content);
		logger.info("Restored a session from the shared store", {
			session: id,
			path: row.path,
			replaced: diskMtime >= 0,
		});
		return row.path;
	} catch (err) {
		logger.debug("Could not restore a session from the shared store", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	} finally {
		if (ownsClient) await client.close?.();
	}
}
