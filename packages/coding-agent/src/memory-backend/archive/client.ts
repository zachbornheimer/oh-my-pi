/**
 * The Postgres client the `archive` backend reads. It shares the connection string omp already
 * uses for its session store (`SESSIONS_DB_URL`, else the file the shell profile writes it to),
 * so the archive needs no second credential and no new dependency: `Bun.SQL` speaks Postgres.
 *
 * The client is opened lazily and never throws at construction: a missing or unusable store is a
 * backend that reports `error` in `status()` and answers every query as empty, never an agent that
 * fails to start.
 */

/** The session store's connection string: the environment, else the file a dev-env shell writes. */
import { readFileSync } from "node:fs";

export const ARCHIVE_DSN_FILE = "~/.config/dev-env/runtime/omp-session-db-url";

export interface ArchiveClient {
	/** The store in use; absent when no connection string was found. */
	readonly url?: string;
	/** Query rows; throws when the store refuses or times out. */
	query<T>(text: string, values?: readonly unknown[]): Promise<T[]>;
	/** Close the pool; safe to call twice. */
	end(): Promise<void>;
}

type SqlClient = {
	unsafe<T = unknown>(text: string, values?: readonly unknown[]): Promise<T[]>;
	end?: () => Promise<void>;
};

export interface ArchiveClientOptions {
	env?: NodeJS.ProcessEnv;
	/** Reads a connection string from disk when the environment has none. */
	readFile?: (path: string) => string | undefined;
	/** Connects; absent means a real `Bun.SQL`. Tests pass a fake. */
	connect?: (url: string) => SqlClient;
}

function dsnFromFile(path: string): string | undefined {
	try {
		const absolute = path.startsWith("~/") ? `${process.env.HOME ?? ""}/${path.slice(2)}` : path;
		return readFileSync(absolute, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * A client over `SESSIONS_DB_URL`. `query` is `unsafe` because values are bound parameters and the
 * statement text is this module's own — nothing from a transcription or a prompt is ever inlined.
 */
export function openArchiveClient(options: ArchiveClientOptions = {}): ArchiveClient {
	const env = options.env ?? process.env;
	const readFile = options.readFile ?? dsnFromFile;
	const url = (env.SESSIONS_DB_URL ?? "").trim() || readFile(ARCHIVE_DSN_FILE);
	if (!url) {
		return {
			query: async () => [],
			end: async () => {},
		};
	}
	let client: SqlClient | undefined;
	const connect = (): SqlClient => {
		if (client) return client;
		if (options.connect) {
			client = options.connect(url);
			return client;
		}
		// `Bun.SQL` is present in every omp runtime (it is how sessions reach Postgres today).
		const BunSql = (globalThis as { Bun?: { SQL?: new (url: string) => SqlClient } }).Bun?.SQL;
		if (!BunSql) throw new Error("Bun.SQL is unavailable in this runtime");
		client = new BunSql(url);
		return client;
	};
	let closed = false;
	return {
		url,
		async query<T>(text: string, values?: readonly unknown[]): Promise<T[]> {
			if (closed) return [];
			return connect().unsafe<T>(text, values);
		},
		async end() {
			if (closed) return;
			closed = true;
			await client?.end?.().catch(() => {});
			client = undefined;
		},
	};
}
