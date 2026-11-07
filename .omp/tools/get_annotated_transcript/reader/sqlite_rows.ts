import type { HostMachine } from "./host_machine.js";
import type { Infer, Shape } from "./shape.js";

/** Ids that are safe to place inside a SQL string literal: the queries here are built by hand, not bound. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id);
}

export function assertSafeSessionId(id: string): void {
  if (!isSafeSessionId(id)) throw new Error(`session id "${id}" has characters outside A-Z a-z 0-9 _ . -`);
}

const CANNOT_OPEN = "unable to open database file";

/** The `file:` URI of a database that opens as unchanging: it needs no `-wal` or `-shm` file, which only a running writer keeps. */
const immutableUri = (database: string): string =>
  `file:${database.replace(/[%?#]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}?immutable=1`;

interface SqliteDatabase {
  query(sql: string): { all(...parameters: (string | number)[]): unknown[] };
  close(): void;
}
type SqliteModule = { Database: new (path: string, options?: { readonly?: boolean; create?: boolean }) => SqliteDatabase };

async function openReadOnly(database: string): Promise<SqliteDatabase> {
  const moduleName = "bun:sqlite";
  const sqlite = (await import(moduleName)) as SqliteModule;
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.Database(database, { readonly: true, create: false });
    // bun:sqlite opens lazily: the constructor succeeds and the failure only surfaces at the first statement, so one is run here.
    db.query("PRAGMA schema_version").all();
    return db;
  } catch (error) {
    db?.close();
    // A write-ahead-log database whose writer has exited leaves no `-shm` file, and a read-only connection cannot open
    // it; that one failure is retried as an immutable database (nothing writes to it then).
    if (!(error as Error).message.includes(CANNOT_OPEN)) throw error;
    return new sqlite.Database(immutableUri(database), { readonly: true, create: false });
  }
}

/** Runs a read-only query and returns its rows, each checked against `row`. Any failing query is an error naming what it said. */
export async function queryRows<Row extends Shape<unknown>>(
  _machine: HostMachine,
  database: string,
  sql: string,
  row: Row,
  parameters: readonly (string | number)[] = [],
): Promise<Infer<Row>[]> {
  let rows: unknown[];
  try {
    const db = await openReadOnly(database);
    try {
      rows = db.query(sql).all(...parameters);
    } finally {
      db.close();
    }
  } catch (error) {
    throw new Error(`sqlite on ${database} failed: ${(error as Error).message}`);
  }
  try {
    return rows.map((value, index) => row.check(value, `row ${index}`)) as Infer<Row>[];
  } catch (error) {
    throw new Error(`sqlite on ${database} returned rows this reader does not understand: ${(error as Error).message}`);
  }
}
