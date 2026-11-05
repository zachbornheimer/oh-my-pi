/**
 * Process-wide session storage selection for the CLI.
 *
 * `SESSIONS_DB_URL` opts every session-bearing call site into
 * {@link SqlSessionStorage} on one shared `Bun.SQL` client (dialect
 * auto-detected from the URL), so every `SessionManager` in this process
 * resolves against a single warmed index and publish queue. Unset, callers get
 * exactly the pre-existing per-call `FileSessionStorage` behavior; a value no
 * SQL adapter can drive (e.g. an unresolved `op://` secret reference) logs one
 * error and keeps the same local-file behavior instead of failing startup.
 * `OMP_SESSION_PATH_PREFIX_ALIAS` rewrites that storage's row keys between
 * this machine's home prefix and the canonical one, so a machine mirroring
 * the same layout under a different absolute root shares rows; unset (or
 * `SESSIONS_DB_URL` unset) changes nothing.
 */
import { SQL } from "bun";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { parseSessionPathPrefixAlias } from "./session-path-alias";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { SqlSessionStorage } from "./sql-session-storage";

/** Connection URL of a SQL-backed session storage; unset keeps sessions on local files. */
const SESSIONS_DB_URL_ENV = "SESSIONS_DB_URL";
/** Overrides the SQL session table name (default: `omp_session_files`). */
const SESSIONS_DB_TABLE_ENV = "SESSIONS_DB_TABLE";
/**
 * `"<localPrefix>=<storagePrefix>"` (first `=` separates the sides), e.g.
 * `/home/zbornheimer=/Users/zbornheimer`: a machine mirroring the canonical
 * machine's directory layout under a different home prefix reads and writes
 * the same SQL session rows. Only read when `SESSIONS_DB_URL` is set.
 */
const SESSION_PATH_PREFIX_ALIAS_ENV = "OMP_SESSION_PATH_PREFIX_ALIAS";

/**
 * Waits between connection attempts of one {@link resolveSessionStorage} call.
 * Covers a Neon compute waking from scale-to-zero and a pooler that briefly
 * rejects new connections; a database still unreachable after the last wait
 * fails the caller. Bounded so a dead database costs a caller ~1.3 s, not a hang.
 */
const SQL_CONNECT_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/** Schemes `Bun.SQL` can drive; anything else in `SESSIONS_DB_URL` is a machine config error, not a SQL target. */
const SUPPORTED_SQL_SCHEMES: Record<string, true> = {
	postgres: true,
	postgresql: true,
	sqlite: true,
	mysql: true,
	mariadb: true,
};

let sqlStorage: Promise<SqlSessionStorage> | undefined;
/** Local-storage fallback for a non-SQL URL, cached so its error logs once per process. */
let fileFallbackForUnsupportedUrl: FileSessionStorage | undefined;
let sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms);

/**
 * The process-wide session storage: the shared `SqlSessionStorage` when
 * `SESSIONS_DB_URL` is set, otherwise a fresh `FileSessionStorage`.
 *
 * The SQL instance and its client are created once per process — two storages
 * over the same rows would race through separate pools — and concurrent
 * callers share one in-flight creation. A creation that still fails after the
 * bounded retries rejects every caller sharing it (none silently falls back to
 * local files) and is then forgotten, so the next caller connects afresh
 * instead of inheriting a stale connection or credential failure for the rest
 * of the process.
 *
 * A `SESSIONS_DB_URL` that is not a SQL connection URL at all — an unresolved
 * 1Password `op://` secret reference, an `http://` endpoint, an unparseable
 * string — is a machine configuration error, not a runtime failure: it is
 * fixed in the env, not by killing `createAgentSession` at startup. It logs
 * one clear error and falls back to local file storage until the env is
 * corrected, so sessions keep saving and resuming on local disk.
 */
export function resolveSessionStorage(): Promise<SessionStorage> {
	const url = process.env[SESSIONS_DB_URL_ENV]?.trim();
	if (!url) return Promise.resolve(new FileSessionStorage());
	const scheme = sqlSchemeOf(url);
	if (scheme === undefined || !(scheme in SUPPORTED_SQL_SCHEMES)) {
		// The env is fixed for the process lifetime, so log once per process;
		// tests that swap URLs call resetSessionStorageForTesting().
		if (!fileFallbackForUnsupportedUrl) {
			logger.error(
				`${SESSIONS_DB_URL_ENV} is not a SQL connection URL (scheme ${JSON.stringify(scheme)}): keeping sessions on local files. Set it to a postgresql://, sqlite://, mysql://, or mariadb:// URL to share sessions between machines.`,
				{ env: SESSIONS_DB_URL_ENV },
			);
			fileFallbackForUnsupportedUrl = new FileSessionStorage();
		}
		return Promise.resolve(fileFallbackForUnsupportedUrl);
	}
	if (sqlStorage) return sqlStorage;
	const creation = createSqlSessionStorage(url);
	sqlStorage = creation;
	creation.catch(() => {
		if (sqlStorage === creation) sqlStorage = undefined;
	});
	return creation;
}

async function createSqlSessionStorage(url: string): Promise<SqlSessionStorage> {
	const table = process.env[SESSIONS_DB_TABLE_ENV]?.trim() || undefined;
	// Parsed before the client exists so a malformed alias fails every caller
	// with the same error instead of keying rows under the wrong prefix.
	const pathAlias = parseSessionPathPrefixAlias(process.env[SESSION_PATH_PREFIX_ALIAS_ENV]);
	for (let attempt = 0; ; attempt++) {
		const client = new SQL(url);
		try {
			return await SqlSessionStorage.create({ client, table, pathAlias });
		} catch (error) {
			// A failed client never serves a caller; release its pool.
			await client.close().catch(() => undefined);
			const delay = SQL_CONNECT_RETRY_DELAYS_MS[attempt];
			if (delay === undefined) throw error;
			await sleep(delay);
		}
	}
}

/** Reset cached process-wide storage for tests; `sleep` replaces the real backoff wait. */
export function resetSessionStorageForTesting(options?: { sleep?: (ms: number) => Promise<void> }): void {
	sqlStorage = undefined;
	fileFallbackForUnsupportedUrl = undefined;
	sleep = options?.sleep ?? (ms => Bun.sleep(ms));
}

/** The lowercase URL scheme, or undefined when the value is not a parseable URL. */
function sqlSchemeOf(url: string): string | undefined {
	try {
		return new URL(url).protocol.replace(/:$/, "").toLowerCase();
	} catch {
		return undefined;
	}
}
