import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import { SessionPathAliasBackend, type SessionPathPrefixAlias } from "./session-path-alias";
import { SessionWriteConflictError } from "./session-storage";
import { enoent } from "./session-storage-errors";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / concat / byte-slice syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * SQL executor shared by the pooled client and its transaction-scoped handle.
 * Bun's SQL client exposes a tagged-template API too,
 * but this implementation intentionally uses `unsafe(query, values)` because
 * the table identifier is validated and then inlined while values remain bound
 * parameters.
 */
export interface SqlSessionStorageTransaction {
	unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult>;
}

/** Bun.SQL-compatible client whose transactions make session renames atomic. */
export interface SqlSessionStorageClient extends SqlSessionStorageTransaction {
	transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void>;
	/**
	 * `Bun.SQL` exposes the parsed connection options here. We only consult
	 * `adapter` to pick the dialect; the field is typed as
	 * `string | undefined` so the real `Bun.SQL` instance type slots in
	 * without casting (it reports `string | undefined` across adapters).
	 */
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
}

/** Array result returned by `Bun.SQL`, including MySQL mutation metadata. */
export interface SqlSessionStorageResult extends Array<unknown> {
	affectedRows?: number;
}

export interface SqlSessionStorageOptions {
	/** Connected `Bun.SQL` instance (PostgreSQL, MySQL, or SQLite). */
	client: SqlSessionStorageClient;
	/**
	 * Override the auto-detected adapter. Useful when the client is wrapped
	 * (e.g. by a pool) and `client.options.adapter` is unreliable.
	 */
	adapter?: SqlSessionStorageAdapter;
	/**
	 * Table name to use. Default: `omp_session_files` (with append-only line
	 * entries stored in `${table}_entries`). Must match
	 * `[A-Za-z_][A-Za-z0-9_]{0,62}` — inlined into prepared statements at
	 * startup, so we accept identifier-safe inputs only (no quoted/dotted
	 * names).
	 */
	table?: string;
	/**
	 * Per-machine home-prefix alias (parsed from `OMP_SESSION_PATH_PREFIX_ALIAS`
	 * by `resolveSessionStorage`): caller paths under `localPrefix` are stored
	 * under `storagePrefix`, so a machine mirroring the same layout under a
	 * different absolute root shares row keys. Unset keeps every key verbatim.
	 */
	pathAlias?: SessionPathPrefixAlias;
	/**
	 * If true, run `CREATE TABLE IF NOT EXISTS` during `create()`.
	 * Default: true. Disable when the table is owned by an external
	 * migration.
	 */
	createTable?: boolean;
}

interface DialectQueries {
	createTable: string;
	createEntriesTable: string;
	/** Add metadata and entry-index columns to existing tables created before they existed. */
	addSchemaColumns: readonly string[];
	/** Selects the metadata columns without reading rows; fails when any are missing. */
	probeSchemaColumns: string;
	/** Insert or replace the header metadata row for `path`. Used for `writeText`/`flags="w"` truncate. */
	upsertReplace: string;
	/** Insert a header metadata row only when `path` does not exist. */
	insertIfMissing: string;
	/** Replace a header metadata row only when its current UTF-8 byte length matches. */
	replaceIfSize: string;
	/** Migrate any legacy `content <> ''` header text into `${entriesTable}` before `upsertAppend` on SQLite. */
	migrateLegacyBeforeAppend?: string;
	/** Insert one allocated `(path, seq, line, byte_len)` row into `${entriesTable}` after `upsertAppend` on SQLite/MySQL. */
	insertAppendEntries?: string;
	/** Insert if missing; otherwise append the new line entry and advance `byte_len` and `next_seq`. */
	upsertAppend: string;
	/** Delete all entries for `path` (used on truncate, remove, and move). */
	deleteEntries: string;
	/** Delete entries for `path` with `seq > $2` when a rewrite shrinks a transcript. */
	deleteEntriesAfterSeq: string;
	/** Batch-upsert `count` `(path, seq, line, byte_len)` rows into `${entriesTable}`, skipping unchanged lines. */
	upsertEntriesBatch: (count: number) => string;
	/** Update indexed title metadata without rewriting the JSONL body. */
	updateTitle: string;
	/** Delete a single row by path. */
	delete: string;
	/** Move a header row from one path to another. */
	rename: string;
	/** Move all entry rows from one path to another. */
	renameEntries: string;
	/** Warm the synchronous index without transferring full content. */
	loadIndex: string;
	/** Read the full content for the async `readText` surface. */
	readFull: string;
	/** Read bounded byte windows from the head and tail of the content. */
	readSlices: string;
	/**
	 * Head-window read for a batch of paths: the head slice binds one
	 * placeholder for the prefix length, then `pathParamCount` placeholders for
	 * the paths (one array parameter on adapters with `= ANY(...)`). Callers
	 * chunk batches before building this.
	 */
	readPrefixesHead: (pathParamCount: number) => string;
	/**
	 * `1` when the content of `path` carries the marker, else `0` (no row when
	 * the path is missing). Binds the marker, then the path. Evaluated in the
	 * engine so a multi-MB body never crosses the wire.
	 */
	hasAssistantMarker: string;
}

/** Compact serialization `JSON.stringify` writes for an assistant message record. */
const ASSISTANT_ROLE_MARKER = '"role":"assistant"';

interface IndexRow {
	path: string;
	byte_len: number | bigint | string;
	mtime_ms: number | bigint | string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface ContentRow {
	content: string;
}

interface SliceRow {
	head: unknown;
	tail: unknown;
}
/** Paths fetched per batched head read; bounds each query's payload. */
const READ_PREFIX_CHUNK = 256;
/** Entry rows bound per multi-row `INSERT ... ON CONFLICT (path, seq)` batch during full writes. */
const WRITE_ENTRIES_BATCH = 200;

interface PrefixRow {
	path: string;
	head: unknown;
}

const DEFAULT_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const utf8Decoder = new TextDecoder("utf-8");

function joinSql(...parts: readonly string[]): string {
	return parts.join("");
}

/**
 * Split a session body into lines while preserving each `\n` terminator on the
 * line it closes, so `splitSessionLines(content).join("") === content` holds
 * byte-for-byte for every input.
 */
export function splitSessionLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines: string[] = [];
	let start = 0;
	while (start < content.length) {
		const newlineIndex = content.indexOf("\n", start);
		if (newlineIndex < 0) {
			lines.push(content.slice(start));
			break;
		}
		lines.push(content.slice(start, newlineIndex + 1));
		start = newlineIndex + 1;
	}
	return lines;
}

function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

function buildQueries(adapter: SqlSessionStorageAdapter, table: string, entriesTable: string): DialectQueries {
	const placeholder = adapter === "postgres" ? (n: number): string => `$${n}` : (_n: number): string => "?";

	if (adapter === "mysql") {
		const fullContentExpr = joinSql(
			"CONCAT(COALESCE((SELECT GROUP_CONCAT(e.line ORDER BY e.seq ASC SEPARATOR '') FROM ",
			entriesTable,
			" e WHERE e.path = ",
			table,
			".path), ''), ",
			table,
			".content)",
		);
		return {
			createTable: joinSql(
				"CREATE TABLE IF NOT EXISTS ",
				table,
				" (path VARCHAR(512) NOT NULL PRIMARY KEY, content LONGTEXT NOT NULL, mtime_ms BIGINT NOT NULL, byte_len BIGINT NOT NULL DEFAULT 0, next_seq BIGINT NOT NULL DEFAULT 1, title TEXT NULL, title_source VARCHAR(16) NULL, title_updated_at VARCHAR(64) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
			),
			createEntriesTable: joinSql(
				"CREATE TABLE IF NOT EXISTS ",
				entriesTable,
				" (path VARCHAR(512) NOT NULL, seq BIGINT NOT NULL, line LONGTEXT NOT NULL, byte_len INT NOT NULL, PRIMARY KEY (path, seq)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
			),
			addSchemaColumns: [
				joinSql("ALTER TABLE ", table, " ADD COLUMN byte_len BIGINT NOT NULL DEFAULT 0"),
				joinSql("ALTER TABLE ", table, " ADD COLUMN next_seq BIGINT NOT NULL DEFAULT 1"),
				joinSql("ALTER TABLE ", table, " ADD COLUMN title TEXT NULL"),
				joinSql("ALTER TABLE ", table, " ADD COLUMN title_source VARCHAR(16) NULL"),
				joinSql("ALTER TABLE ", table, " ADD COLUMN title_updated_at VARCHAR(64) NULL"),
			],
			probeSchemaColumns: joinSql(
				"SELECT byte_len, next_seq, title, title_source, title_updated_at FROM ",
				table,
				" WHERE 1 = 0",
			),
			upsertReplace: joinSql(
				"INSERT INTO ",
				table,
				" (path, content, mtime_ms, byte_len, next_seq, title, title_source, title_updated_at) VALUES (?, '', ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = '', mtime_ms = ?, byte_len = ?, next_seq = ?, title = ?, title_source = ?, title_updated_at = ?",
			),
			insertIfMissing: joinSql(
				"INSERT IGNORE INTO ",
				table,
				" (path, content, mtime_ms, byte_len, next_seq, title, title_source, title_updated_at) VALUES (?, '', ?, ?, ?, ?, ?, ?)",
			),
			replaceIfSize: joinSql(
				"UPDATE ",
				table,
				" SET content = '', mtime_ms = ?, byte_len = ?, next_seq = ?, title = ?, title_source = ?, title_updated_at = ? WHERE path = ? AND (CASE WHEN content <> '' THEN byte_len + length(content) ELSE byte_len END) = ?",
			),
			insertAppendEntries: joinSql(
				"INSERT INTO ",
				entriesTable,
				" (path, seq, line, byte_len) SELECT path, next_seq, content, length(content) FROM ",
				table,
				" WHERE path = ? AND content <> '' UNION ALL SELECT ?, COALESCE((SELECT CASE WHEN content <> '' THEN next_seq + 1 ELSE next_seq END FROM ",
				table,
				" WHERE path = ?), 1), ?, ?",
			),
			upsertAppend: joinSql(
				"INSERT INTO ",
				table,
				" (path, content, mtime_ms, byte_len, next_seq) VALUES (?, '', ?, ?, 2) ON DUPLICATE KEY UPDATE byte_len = CASE WHEN content <> '' THEN byte_len + length(content) + ? ELSE byte_len + ? END, next_seq = CASE WHEN content <> '' THEN next_seq + 2 ELSE next_seq + 1 END, content = '', mtime_ms = ?",
			),
			deleteEntries: joinSql("DELETE FROM ", entriesTable, " WHERE path = ?"),
			deleteEntriesAfterSeq: joinSql("DELETE FROM ", entriesTable, " WHERE path = ? AND seq > ?"),
			upsertEntriesBatch: count =>
				joinSql(
					"INSERT INTO ",
					entriesTable,
					" (path, seq, line, byte_len) VALUES ",
					Array.from({ length: count }, () => "(?, ?, ?, ?)").join(", "),
					" ON DUPLICATE KEY UPDATE line = VALUES(line), byte_len = VALUES(byte_len)",
				),
			updateTitle: joinSql(
				"UPDATE ",
				table,
				" SET title = ?, title_source = ?, title_updated_at = ?, mtime_ms = ? WHERE path = ?",
			),
			delete: joinSql("DELETE FROM ", table, " WHERE path = ?"),
			rename: joinSql("UPDATE ", table, " SET path = ?, mtime_ms = ? WHERE path = ?"),
			renameEntries: joinSql("UPDATE ", entriesTable, " SET path = ? WHERE path = ?"),
			loadIndex: joinSql(
				"SELECT path, mtime_ms, CASE WHEN content <> '' THEN byte_len + length(content) ELSE byte_len END AS byte_len, title, title_source, title_updated_at FROM ",
				table,
			),
			readFull: joinSql("SELECT ", fullContentExpr, " AS content FROM ", table, " WHERE path = ?"),
			readSlices: joinSql(
				"SELECT substring(cast(",
				fullContentExpr,
				" AS binary), 1, ?) AS head, CASE WHEN ? <= 0 THEN cast('' AS binary) ELSE substring(cast(",
				fullContentExpr,
				" AS binary), greatest(1, length(",
				fullContentExpr,
				") - ? + 1)) END AS tail FROM ",
				table,
				" WHERE path = ?",
			),
			readPrefixesHead: pathParamCount =>
				joinSql(
					"SELECT path, substring(cast(",
					fullContentExpr,
					" AS binary), 1, ?) AS head FROM ",
					table,
					" WHERE path IN (",
					Array.from({ length: pathParamCount }, () => "?").join(", "),
					")",
				),
			hasAssistantMarker: joinSql(
				"SELECT CASE WHEN (content <> '' AND INSTR(content, ?) > 0) OR EXISTS (SELECT 1 FROM ",
				entriesTable,
				" e WHERE e.path = ",
				table,
				".path AND INSTR(e.line, ?) > 0) THEN 1 ELSE 0 END AS found FROM ",
				table,
				" WHERE path = ?",
			),
		};
	}

	const mtimeType = adapter === "postgres" ? "BIGINT" : "INTEGER";
	const byteLengthExpr = adapter === "postgres" ? "octet_length(content)" : "length(cast(content AS blob))";
	const totalBytesExpr = joinSql("CASE WHEN content <> '' THEN byte_len + ", byteLengthExpr, " ELSE byte_len END");

	const readSlices =
		adapter === "postgres"
			? joinSql(
					"WITH RECURSIVE target AS (SELECT path, content, byte_len, next_seq FROM ",
					table,
					" WHERE path = $3), head_rows(seq, line, rem) AS (SELECT e.seq, e.line, $1::int - e.byte_len FROM target f JOIN ",
					entriesTable,
					" e ON e.path = f.path AND e.seq = 1 WHERE f.content = '' AND $1::int > 0 UNION ALL SELECT e.seq, e.line, h.rem - e.byte_len FROM head_rows h JOIN ",
					entriesTable,
					" e ON e.path = $3 AND e.seq = h.seq + 1 WHERE h.rem > 0), tail_rows(seq, line, rem) AS (SELECT e.seq, e.line, $2::int - e.byte_len FROM target f JOIN ",
					entriesTable,
					" e ON e.path = f.path AND e.seq = f.next_seq - 1 WHERE f.content = '' AND $2::int > 0 AND f.next_seq > 1 UNION ALL SELECT e.seq, e.line, t.rem - e.byte_len FROM tail_rows t JOIN ",
					entriesTable,
					" e ON e.path = $3 AND e.seq = t.seq - 1 WHERE t.rem > 0 AND t.seq > 1), assembled AS (SELECT f.content, CASE WHEN f.content <> '' THEN COALESCE((SELECT string_agg(e.line, '' ORDER BY e.seq ASC) FROM ",
					entriesTable,
					" e WHERE e.path = f.path), '') || f.content ELSE '' END AS legacy_full, COALESCE((SELECT string_agg(line, '' ORDER BY seq ASC) FROM head_rows), '') AS head_text, COALESCE((SELECT string_agg(line, '' ORDER BY seq ASC) FROM tail_rows), '') AS tail_text FROM target f) SELECT CASE WHEN $1::int <= 0 THEN ''::bytea WHEN content <> '' THEN substring(convert_to(legacy_full, 'UTF8') from 1 for $1::int) ELSE substring(convert_to(head_text, 'UTF8') from 1 for $1::int) END AS head, CASE WHEN $2::int <= 0 THEN ''::bytea WHEN content <> '' THEN substring(convert_to(legacy_full, 'UTF8') from greatest(1, octet_length(legacy_full) - $2::int + 1)) ELSE substring(convert_to(tail_text, 'UTF8') from greatest(1, octet_length(tail_text) - $2::int + 1)) END AS tail FROM assembled",
				)
			: joinSql(
					"WITH RECURSIVE params(prefix_bytes, suffix_bytes, target_path) AS (VALUES (?, ?, ?)), target AS (SELECT f.path, f.content, f.byte_len, f.next_seq, p.prefix_bytes, p.suffix_bytes FROM ",
					table,
					" f JOIN params p ON f.path = p.target_path), head_rows(path, seq, line, rem) AS (SELECT e.path, e.seq, e.line, f.prefix_bytes - e.byte_len FROM target f JOIN ",
					entriesTable,
					" e ON e.path = f.path AND e.seq = 1 WHERE f.content = '' AND f.prefix_bytes > 0 UNION ALL SELECT e.path, e.seq, e.line, h.rem - e.byte_len FROM head_rows h JOIN ",
					entriesTable,
					" e ON e.path = h.path AND e.seq = h.seq + 1 WHERE h.rem > 0), tail_rows(path, seq, line, rem) AS (SELECT e.path, e.seq, e.line, f.suffix_bytes - e.byte_len FROM target f JOIN ",
					entriesTable,
					" e ON e.path = f.path AND e.seq = f.next_seq - 1 WHERE f.content = '' AND f.suffix_bytes > 0 AND f.next_seq > 1 UNION ALL SELECT e.path, e.seq, e.line, t.rem - e.byte_len FROM tail_rows t JOIN ",
					entriesTable,
					" e ON e.path = t.path AND e.seq = t.seq - 1 WHERE t.rem > 0 AND t.seq > 1), assembled AS (SELECT f.content, f.prefix_bytes, f.suffix_bytes, CASE WHEN f.content <> '' THEN COALESCE((SELECT group_concat(line, '') FROM (SELECT line FROM ",
					entriesTable,
					" e WHERE e.path = f.path ORDER BY e.seq ASC)), '') || f.content ELSE '' END AS content_full, COALESCE((SELECT group_concat(line, '') FROM (SELECT line FROM head_rows ORDER BY seq ASC)), '') AS head_text, COALESCE((SELECT group_concat(line, '') FROM (SELECT line FROM tail_rows ORDER BY seq ASC)), '') AS tail_text FROM target f) SELECT CASE WHEN prefix_bytes <= 0 THEN x'' WHEN content <> '' THEN substr(cast(content_full AS blob), 1, prefix_bytes) ELSE substr(cast(head_text AS blob), 1, prefix_bytes) END AS head, CASE WHEN suffix_bytes <= 0 THEN x'' WHEN content <> '' THEN substr(cast(content_full AS blob), -suffix_bytes) ELSE substr(cast(tail_text AS blob), -suffix_bytes) END AS tail FROM assembled",
				);

	return {
		createTable: joinSql(
			"CREATE TABLE IF NOT EXISTS ",
			table,
			" (path TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', mtime_ms ",
			mtimeType,
			" NOT NULL, byte_len ",
			mtimeType,
			" NOT NULL DEFAULT 0, next_seq ",
			mtimeType,
			" NOT NULL DEFAULT 1, title TEXT, title_source TEXT, title_updated_at TEXT)",
		),
		createEntriesTable: joinSql(
			"CREATE TABLE IF NOT EXISTS ",
			entriesTable,
			" (path TEXT NOT NULL, seq ",
			mtimeType,
			" NOT NULL, line TEXT NOT NULL, byte_len INTEGER NOT NULL, PRIMARY KEY (path, seq))",
		),
		addSchemaColumns: [
			joinSql("ALTER TABLE ", table, " ADD COLUMN byte_len ", mtimeType, " NOT NULL DEFAULT 0"),
			joinSql("ALTER TABLE ", table, " ADD COLUMN next_seq ", mtimeType, " NOT NULL DEFAULT 1"),
			joinSql("ALTER TABLE ", table, " ADD COLUMN title TEXT"),
			joinSql("ALTER TABLE ", table, " ADD COLUMN title_source TEXT"),
			joinSql("ALTER TABLE ", table, " ADD COLUMN title_updated_at TEXT"),
		],
		probeSchemaColumns: joinSql(
			"SELECT byte_len, next_seq, title, title_source, title_updated_at FROM ",
			table,
			" WHERE 1 = 0",
		),
		upsertReplace: joinSql(
			"INSERT INTO ",
			table,
			" (path, content, mtime_ms, byte_len, next_seq, title, title_source, title_updated_at) VALUES (",
			placeholder(1),
			", '', ",
			placeholder(2),
			", ",
			placeholder(3),
			", ",
			placeholder(4),
			", ",
			placeholder(5),
			", ",
			placeholder(6),
			", ",
			placeholder(7),
			") ON CONFLICT (path) DO UPDATE SET content = '', mtime_ms = excluded.mtime_ms, byte_len = excluded.byte_len, next_seq = excluded.next_seq, title = excluded.title, title_source = excluded.title_source, title_updated_at = excluded.title_updated_at",
		),
		insertIfMissing: joinSql(
			"INSERT INTO ",
			table,
			" (path, content, mtime_ms, byte_len, next_seq, title, title_source, title_updated_at) VALUES (",
			placeholder(1),
			", '', ",
			placeholder(2),
			", ",
			placeholder(3),
			", ",
			placeholder(4),
			", ",
			placeholder(5),
			", ",
			placeholder(6),
			", ",
			placeholder(7),
			") ON CONFLICT (path) DO NOTHING RETURNING path",
		),
		replaceIfSize: joinSql(
			"UPDATE ",
			table,
			" SET content = '', mtime_ms = ",
			placeholder(1),
			", byte_len = ",
			placeholder(2),
			", next_seq = ",
			placeholder(3),
			", title = ",
			placeholder(4),
			", title_source = ",
			placeholder(5),
			", title_updated_at = ",
			placeholder(6),
			" WHERE path = ",
			placeholder(7),
			" AND (",
			totalBytesExpr,
			") = ",
			placeholder(8),
			" RETURNING path",
		),
		migrateLegacyBeforeAppend:
			adapter === "sqlite"
				? joinSql(
						"INSERT OR IGNORE INTO ",
						entriesTable,
						" (path, seq, line, byte_len) SELECT path, next_seq, content, length(cast(content AS blob)) FROM ",
						table,
						" WHERE path = ? AND content <> ''",
					)
				: undefined,
		insertAppendEntries:
			adapter === "sqlite"
				? joinSql("INSERT INTO ", entriesTable, " (path, seq, line, byte_len) VALUES (?, ?, ?, ?)")
				: undefined,
		upsertAppend:
			adapter === "postgres"
				? joinSql(
						"WITH prev AS (SELECT next_seq AS seq, content, octet_length(content) AS prev_bytes FROM ",
						table,
						" WHERE path = $1 AND content <> ''), meta AS (INSERT INTO ",
						table,
						" (path, content, mtime_ms, byte_len, next_seq) VALUES ($1, '', $3, $4, 2) ON CONFLICT (path) DO UPDATE SET content = '', mtime_ms = excluded.mtime_ms, byte_len = CASE WHEN ",
						table,
						".content <> '' THEN ",
						table,
						".byte_len + octet_length(",
						table,
						".content) + excluded.byte_len ELSE ",
						table,
						".byte_len + excluded.byte_len END, next_seq = CASE WHEN ",
						table,
						".content <> '' THEN ",
						table,
						".next_seq + 2 ELSE ",
						table,
						".next_seq + 1 END RETURNING next_seq - 1 AS seq) INSERT INTO ",
						entriesTable,
						" (path, seq, line, byte_len) SELECT $1, prev.seq, prev.content, prev.prev_bytes FROM prev UNION ALL SELECT $1, meta.seq, $2, $4 FROM meta",
					)
				: joinSql(
						"INSERT INTO ",
						table,
						" (path, content, mtime_ms, byte_len, next_seq) VALUES (?, '', ?, ?, 2) ON CONFLICT (path) DO UPDATE SET content = '', mtime_ms = excluded.mtime_ms, byte_len = CASE WHEN ",
						table,
						".content <> '' THEN ",
						table,
						".byte_len + length(cast(",
						table,
						".content AS blob)) + excluded.byte_len ELSE ",
						table,
						".byte_len + excluded.byte_len END, next_seq = CASE WHEN ",
						table,
						".content <> '' THEN ",
						table,
						".next_seq + 2 ELSE ",
						table,
						".next_seq + 1 END RETURNING next_seq - 1 AS seq",
					),
		deleteEntries: joinSql("DELETE FROM ", entriesTable, " WHERE path = ", placeholder(1)),
		deleteEntriesAfterSeq: joinSql(
			"DELETE FROM ",
			entriesTable,
			" WHERE path = ",
			placeholder(1),
			" AND seq > ",
			placeholder(2),
		),
		upsertEntriesBatch:
			adapter === "postgres"
				? count => {
						const tuples: string[] = [];
						for (let i = 0; i < count; i++) {
							const base = i * 4;
							tuples.push(
								joinSql("($", String(base + 1), ", $", String(base + 2), ", $", String(base + 3), ", $", String(base + 4), ")"),
							);
						}
						return joinSql(
							"INSERT INTO ",
							entriesTable,
							" (path, seq, line, byte_len) VALUES ",
							tuples.join(", "),
							" ON CONFLICT (path, seq) DO UPDATE SET line = excluded.line, byte_len = excluded.byte_len WHERE ",
							entriesTable,
							".line IS DISTINCT FROM excluded.line",
						);
					}
				: count =>
						joinSql(
							"INSERT INTO ",
							entriesTable,
							" (path, seq, line, byte_len) VALUES ",
							Array.from({ length: count }, () => "(?, ?, ?, ?)").join(", "),
							" ON CONFLICT (path, seq) DO UPDATE SET line = excluded.line, byte_len = excluded.byte_len WHERE ",
							entriesTable,
							".line IS NOT excluded.line",
						),
		updateTitle: joinSql(
			"UPDATE ",
			table,
			" SET title = ",
			placeholder(1),
			", title_source = ",
			placeholder(2),
			", title_updated_at = ",
			placeholder(3),
			", mtime_ms = ",
			placeholder(4),
			" WHERE path = ",
			placeholder(5),
		),
		delete: joinSql("DELETE FROM ", table, " WHERE path = ", placeholder(1)),
		rename: joinSql(
			"UPDATE ",
			table,
			" SET path = ",
			placeholder(1),
			", mtime_ms = ",
			placeholder(2),
			" WHERE path = ",
			placeholder(3),
			" RETURNING path",
		),
		renameEntries: joinSql("UPDATE ", entriesTable, " SET path = ", placeholder(1), " WHERE path = ", placeholder(2)),
		loadIndex: joinSql(
			"SELECT path, mtime_ms, ",
			totalBytesExpr,
			" AS byte_len, title, title_source, title_updated_at FROM ",
			table,
		),
		readFull:
			adapter === "postgres"
				? joinSql(
						"SELECT COALESCE((SELECT string_agg(e.line, '' ORDER BY e.seq ASC) FROM ",
						entriesTable,
						" e WHERE e.path = ",
						table,
						".path), '') || ",
						table,
						".content AS content FROM ",
						table,
						" WHERE path = $1",
					)
				: joinSql(
						"SELECT COALESCE((SELECT group_concat(line, '') FROM (SELECT line FROM ",
						entriesTable,
						" e WHERE e.path = ",
						table,
						".path ORDER BY e.seq ASC)), '') || ",
						table,
						".content AS content FROM ",
						table,
						" WHERE path = ?",
					),
		readSlices,
		readPrefixesHead:
			adapter === "postgres"
				? _pathParamCount =>
						joinSql(
							"WITH RECURSIVE target AS (SELECT path, content FROM ",
							table,
							" WHERE path = ANY($2)), head_rows(path, seq, line, rem) AS (SELECT e.path, e.seq, e.line, $1::int - e.byte_len FROM target f JOIN ",
							entriesTable,
							" e ON e.path = f.path AND e.seq = 1 WHERE f.content = '' AND $1::int > 0 UNION ALL SELECT e.path, e.seq, e.line, h.rem - e.byte_len FROM head_rows h JOIN ",
							entriesTable,
							" e ON e.path = h.path AND e.seq = h.seq + 1 WHERE h.rem > 0), agg AS (SELECT path, string_agg(line, '' ORDER BY seq ASC) AS head_text FROM head_rows GROUP BY path) SELECT f.path, CASE WHEN $1::int <= 0 THEN ''::bytea WHEN f.content <> '' THEN substring(convert_to(COALESCE((SELECT string_agg(e.line, '' ORDER BY e.seq ASC) FROM ",
							entriesTable,
							" e WHERE e.path = f.path), '') || f.content, 'UTF8') from 1 for $1::int) ELSE substring(convert_to(COALESCE(a.head_text, ''), 'UTF8') from 1 for $1::int) END AS head FROM target f LEFT JOIN agg a ON a.path = f.path",
						)
				: pathParamCount =>
						joinSql(
							"WITH RECURSIVE params(prefix_bytes) AS (VALUES (?)), target AS (SELECT path, content, params.prefix_bytes AS prefix_bytes FROM ",
							table,
							" CROSS JOIN params WHERE path IN (",
							Array.from({ length: pathParamCount }, () => "?").join(", "),
							")), head_rows(path, seq, line, rem) AS (SELECT e.path, e.seq, e.line, f.prefix_bytes - e.byte_len FROM target f JOIN ",
							entriesTable,
							" e ON e.path = f.path AND e.seq = 1 WHERE f.content = '' AND f.prefix_bytes > 0 UNION ALL SELECT e.path, e.seq, e.line, h.rem - e.byte_len FROM head_rows h JOIN ",
							entriesTable,
							" e ON e.path = h.path AND e.seq = h.seq + 1 WHERE h.rem > 0), agg AS (SELECT path, group_concat(line, '') AS head_text FROM (SELECT path, line FROM head_rows ORDER BY path ASC, seq ASC) GROUP BY path) SELECT f.path, CASE WHEN f.prefix_bytes <= 0 THEN x'' WHEN f.content <> '' THEN substr(cast((COALESCE((SELECT group_concat(line, '') FROM (SELECT line FROM ",
							entriesTable,
							" e WHERE e.path = f.path ORDER BY e.seq ASC)), '') || f.content) AS blob), 1, f.prefix_bytes) ELSE substr(cast(COALESCE(a.head_text, '') AS blob), 1, f.prefix_bytes) END AS head FROM target f LEFT JOIN agg a ON a.path = f.path",
						),
		hasAssistantMarker:
			adapter === "postgres"
				? joinSql(
						"SELECT CASE WHEN (content <> '' AND strpos(content, $1) > 0) OR EXISTS (SELECT 1 FROM ",
						entriesTable,
						" e WHERE e.path = ",
						table,
						".path AND strpos(e.line, $1) > 0) THEN 1 ELSE 0 END AS found FROM ",
						table,
						" WHERE path = $2",
					)
				: joinSql(
						"WITH params(marker, target_path) AS (VALUES (?, ?)) SELECT CASE WHEN (content <> '' AND instr(content, params.marker) > 0) OR EXISTS (SELECT 1 FROM ",
						entriesTable,
						" e WHERE e.path = ",
						table,
						".path AND instr(e.line, params.marker) > 0) THEN 1 ELSE 0 END AS found FROM ",
						table,
						" JOIN params ON path = params.target_path",
					),
	};
}

function rowNumber(value: number | bigint | string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}
function rowTitleSource(value: string | null | undefined): SessionTitleUpdate["source"] | undefined {
	return value === "auto" || value === "user" ? value : undefined;
}
function isDuplicateColumnError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("duplicate column") || message.includes("already exists");
}

function decodeSqlBytes(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return utf8Decoder.decode(value);
	if (value instanceof ArrayBuffer) return utf8Decoder.decode(new Uint8Array(value));
	return String(value);
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file maps to a lightweight metadata row in `table` keyed by
 * `path` plus append-only `(path, seq, line, byte_len)` rows in
 * `${table}_entries`; this process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory for synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls.
 *
 * Works against PostgreSQL, MySQL/MariaDB, and SQLite by selecting the
 * dialect-correct DDL, atomic append CTE, delta entry upserts, and bounded
 * head/tail entry queries at construction.
 */
export class SqlSessionStorage extends IndexedSessionStorage {
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #entriesTable: string;

	constructor(backend: SessionStorageBackend, adapter: SqlSessionStorageAdapter, table: string, entriesTable: string) {
		super(backend);
		this.#adapter = adapter;
		this.#table = table;
		this.#entriesTable = entriesTable;
	}

	/**
	 * Apply the dialect-correct DDL (unless `createTable: false` is set) and warm
	 * the metadata index with every existing row. Must be awaited before passing
	 * the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const backend = new SqlSessionStorageBackend(options);
		const storage = new SqlSessionStorage(
			options.pathAlias ? new SessionPathAliasBackend(backend, options.pathAlias) : backend,
			backend.adapter,
			backend.table,
			backend.entriesTable,
		);
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	get entriesTable(): string {
		return this.#entriesTable;
	}
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #entriesTable: string;
	readonly #q: DialectQueries;
	readonly #createTable: boolean;

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(`SqlSessionStorage: table name must match ${IDENT_RE.source} (got ${JSON.stringify(table)})`);
		}
		const entriesTable = `${table}_entries`;
		this.#table = table;
		this.#entriesTable = entriesTable;
		this.#q = buildQueries(this.#adapter, table, entriesTable);
		this.#createTable = options.createTable !== false;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	get entriesTable(): string {
		return this.#entriesTable;
	}

	async init(): Promise<void> {
		if (!this.#createTable) return;
		await this.#client.unsafe(this.#q.createTable);
		await this.#client.unsafe(this.#q.createEntriesTable);
		// ALTER TABLE takes the table's exclusive lock before it can see the column exists, so on a
		// shared store every startup would queue all readers and writers behind in-flight writes.
		if (await this.#hasSchemaColumns()) return;
		for (const query of this.#q.addSchemaColumns) {
			try {
				await this.#client.unsafe(query);
			} catch (err) {
				if (!isDuplicateColumnError(err)) throw err;
			}
		}
	}

	async #hasSchemaColumns(): Promise<boolean> {
		try {
			await this.#client.unsafe(this.#q.probeSchemaColumns);
			return true;
		} catch {
			// A missing column and a broken connection both fall through to the ALTERs, which surface the latter.
			return false;
		}
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const rows = (await this.#client.unsafe(this.#q.loadIndex)) as IndexRow[];
		return rows.map(row => ({
			path: row.path,
			size: rowNumber(row.byte_len),
			mtimeMs: rowNumber(row.mtime_ms),
			title: row.title ?? undefined,
			titleSource: rowTitleSource(row.title_source),
			titleUpdatedAt: row.title_updated_at ?? undefined,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		const rows = (await this.#client.unsafe(this.#q.readFull, [path])) as ContentRow[];
		const row = rows[0];
		return row ? row.content : null;
	}

	async hasAssistantTurn(path: string): Promise<boolean> {
		const values =
			this.#adapter === "mysql"
				? [ASSISTANT_ROLE_MARKER, ASSISTANT_ROLE_MARKER, path]
				: [ASSISTANT_ROLE_MARKER, path];
		const rows = (await this.#client.unsafe(this.#q.hasAssistantMarker, values)) as {
			found: number | bigint | string;
		}[];
		const row = rows[0];
		if (!row) throw enoent(path);
		return rowNumber(row.found) === 1;
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const values =
			this.#adapter === "mysql"
				? [prefixBytes, suffixBytes, suffixBytes, path]
				: [prefixBytes, suffixBytes, path];
		const rows = (await this.#client.unsafe(this.#q.readSlices, values)) as SliceRow[];
		const row = rows[0];
		if (!row) throw enoent(path);
		return [decodeSqlBytes(row.head), decodeSqlBytes(row.tail)];
	}
	/**
	 * Head `prefixBytes` of every `path`, in batches of
	 * {@link READ_PREFIX_CHUNK} rows: one round trip per batch instead of one
	 * per file. Absent paths are absent from the map.
	 */
	async readPrefixes(paths: readonly string[], prefixBytes: number): Promise<Map<string, string>> {
		const prefixes = new Map<string, string>();
		for (let start = 0; start < paths.length; start += READ_PREFIX_CHUNK) {
			const chunk = paths.slice(start, start + READ_PREFIX_CHUNK);
			const values = this.#adapter === "postgres" ? [prefixBytes, chunk] : [prefixBytes, ...chunk];
			const rows = (await this.#client.unsafe(this.#q.readPrefixesHead(chunk.length), values)) as PrefixRow[];
			for (const row of rows) prefixes.set(row.path, decodeSqlBytes(row.head));
		}
		return prefixes;
	}

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const lines = splitSessionLines(content);
		const totalBytes = Buffer.byteLength(content, "utf8");
		const nextSeq = lines.length + 1;
		const titleValues = [title?.title ?? null, title?.source ?? null, title?.updatedAt ?? null];
		if (expectedSize === undefined) {
			const values = [path, mtimeMs, totalBytes, nextSeq, ...titleValues];
			if (this.#adapter === "mysql") values.push(mtimeMs, totalBytes, nextSeq, ...titleValues);
			await this.#client.unsafe(this.#q.upsertReplace, values);
			await this.#syncEntries(path, lines);
			return;
		}

		const result =
			expectedSize === null
				? await this.#client.unsafe(this.#q.insertIfMissing, [
						path,
						mtimeMs,
						totalBytes,
						nextSeq,
						...titleValues,
					])
				: await this.#client.unsafe(this.#q.replaceIfSize, [
						mtimeMs,
						totalBytes,
						nextSeq,
						...titleValues,
						path,
						expectedSize,
					]);
		const written = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
		if (written) {
			await this.#syncEntries(path, lines);
			return;
		}

		const current = await this.readFull(path);
		const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
		if (actualSize === expectedSize) {
			await this.#syncEntries(path, lines);
			return;
		}
		throw new SessionWriteConflictError(path, expectedSize, actualSize);
	}

	async #syncEntries(path: string, lines: readonly string[]): Promise<void> {
		if (lines.length === 0) {
			await this.#client.unsafe(this.#q.deleteEntries, [path]);
			return;
		}
		await this.#client.unsafe(this.#q.deleteEntriesAfterSeq, [path, lines.length]);
		for (let start = 0; start < lines.length; start += WRITE_ENTRIES_BATCH) {
			const end = Math.min(start + WRITE_ENTRIES_BATCH, lines.length);
			const batchCount = end - start;
			const values: unknown[] = [];
			for (let index = start; index < end; index++) {
				const line = lines[index]!;
				values.push(path, index + 1, line, Buffer.byteLength(line, "utf8"));
			}
			await this.#client.unsafe(this.#q.upsertEntriesBatch(batchCount), values);
		}
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.updateTitle, [
			title.title ?? null,
			title.source ?? null,
			title.updatedAt,
			mtimeMs,
			path,
		]);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		const segments = splitSessionLines(line);
		for (const segment of segments.length > 0 ? segments : [line]) {
			if (segment.length === 0) continue;
			const byteLen = Buffer.byteLength(segment, "utf8");
			if (this.#adapter === "postgres") {
				await this.#client.unsafe(this.#q.upsertAppend, [path, segment, mtimeMs, byteLen]);
			} else if (this.#adapter === "mysql") {
				if (this.#q.insertAppendEntries) {
					await this.#client.unsafe(this.#q.insertAppendEntries, [path, path, path, segment, byteLen]);
				}
				await this.#client.unsafe(this.#q.upsertAppend, [path, mtimeMs, byteLen, byteLen, byteLen, mtimeMs]);
			} else {
				if (this.#q.migrateLegacyBeforeAppend) {
					await this.#client.unsafe(this.#q.migrateLegacyBeforeAppend, [path]);
				}
				const rows = (await this.#client.unsafe(this.#q.upsertAppend, [path, mtimeMs, byteLen])) as {
					seq?: number | bigint | string;
				}[];
				const seq = rows[0]?.seq !== undefined ? rowNumber(rows[0].seq) : 1;
				if (this.#q.insertAppendEntries) {
					await this.#client.unsafe(this.#q.insertAppendEntries, [path, seq, segment, byteLen]);
				}
			}
		}
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) {
			await this.#client.unsafe(this.#q.deleteEntries, [path]);
			await this.#client.unsafe(this.#q.delete, [path]);
		}
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		if (src === dst) {
			if ((await this.readFull(src)) === null) throw enoent(src);
			return;
		}
		await this.#client.transaction(async transaction => {
			await transaction.unsafe(this.#q.deleteEntries, [dst]);
			await transaction.unsafe(this.#q.delete, [dst]);
			const result = await transaction.unsafe(this.#q.rename, [dst, mtimeMs, src]);
			const moved = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			if (!moved) throw enoent(src);
			await transaction.unsafe(this.#q.renameEntries, [dst, src]);
		});
	}
}
