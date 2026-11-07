import { SQL } from "bun";

/** The one thing the memory store needs from a Postgres driver; tests pass a fake. */
export interface Db {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * The connection string of the session store: `SESSIONS_DB_URL` with `-pooler` stripped from the host. The pooled
 * endpoint drops session state between statements, which the schema and the BM25 query depend on.
 */
export function sessionsDbUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SESSIONS_DB_URL?.trim();
  if (raw === undefined || raw === "") {
    throw new Error("no SESSIONS_DB_URL: the session store's connection string is not set in this process");
  }
  const url = new URL(raw);
  // Both spellings Neon uses: `-pooler.<region>...` and a bare `-pooler` suffix.
  url.hostname = url.hostname.replace(/-pooler(\.|$)/, "$1");
  return url.toString();
}

const withoutChannelBinding = (urlText: string): string => {
  const url = new URL(urlText);
  url.searchParams.delete("channel_binding");
  return url.toString();
};

type Client = Pick<SQL, "unsafe" | "close">;

const bunClient = (url: string): Client => new SQL(url, { max: 4, idleTimeout: 20, connectionTimeout: 15 });

/**
 * A Db over Bun's built-in Postgres client. A URL that demands `channel_binding=require` is tried as given; only
 * when the driver itself reports it cannot honor channel binding is the parameter dropped and the statement
 * retried, once (TLS and SCRAM stay on).
 */
export function bunDb(url: string, make: (url: string) => Client = bunClient): Db {
  let client = make(url);
  let relaxed = false;
  return {
    async query(text, values = []) {
      try {
        return { rows: [...(await client.unsafe(text, [...values]))] as Record<string, unknown>[] };
      } catch (error) {
        if (relaxed || !/channel binding/i.test((error as Error).message)) throw error;
        relaxed = true;
        await client.close().catch(() => {});
        client = make(withoutChannelBinding(url));
        return { rows: [...(await client.unsafe(text, [...values]))] as Record<string, unknown>[] };
      }
    },
  };
}

let shared: { url: string; db: Db } | undefined;

/** The process's one Db onto the session store, created on first use and reused while the URL is unchanged. */
export function sharedDb(env: NodeJS.ProcessEnv = process.env): Db {
  const url = sessionsDbUrl(env);
  if (shared === undefined || shared.url !== url) shared = { url, db: bunDb(url) };
  return shared.db;
}
