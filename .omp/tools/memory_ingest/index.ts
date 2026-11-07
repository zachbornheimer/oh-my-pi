import { createHash } from "node:crypto";
import type { CustomToolAPI, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { chunkDocument } from "./chunk.js";
import { type Db, sharedDb } from "./db.js";
import { type Embedder, openRouterEmbedder } from "./embed.js";
import { type Update, withHeartbeat } from "./heartbeat.js";
import type { OpRead } from "./openrouter_key.js";
import { dropStaleChunks, ensureMemorySchema, type MemoryChunkRow, writeMemoryChunks } from "./store.js";

export const NAME = "memory_ingest";

export const DESCRIPTION = [
  "Keep a durable fact, decision or document in this machine's session memory, where every later session's `memory_search` can read it.",
  'Call `{"content":"The migration decision: Neon holds session memory.","repository":"capability-replicas"}`. Optional `title` (names the document; the first 12 hex characters of the content\'s SHA-256 otherwise), `repository` (a directory name the note is filed under) and `occurred_at` (an ISO instant it belongs to; now when omitted).',
  '`content` MUST be non-blank: a blank one returns `{ok:false,degraded:true,reason:"empty content"}` and writes nothing.',
  "The content is cut into 4000-character chunks and upserted by chunk id into `public.memory_chunks`, so the same title and content again adds no row; re-ingesting a title replaces its earlier chunks, including a longer old tail.",
  "Vectors come from OpenRouter (`OPENROUTER_API_KEY`, else 1Password). Without a key, or if it refuses, the rows are STILL written without vectors and `degraded:true` with `reason` says so: `memory_search` then reaches them lexically only.",
  "Needs `SESSIONS_DB_URL`; an unreachable store throws and nothing is written.",
  "WRITES to the shared Neon database (creates the table and indexes when absent) and sends the content to OpenRouter; there is no delete or undo here.",
  "Returns `{ok,ids,embedded,degraded?,reason?}`: the chunk ids in order and how many vectors this call embedded.",
].join(" ");

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  env?: NodeJS.ProcessEnv;
  /** The store; defaults to the process's shared Bun Postgres client on `SESSIONS_DB_URL`. */
  db?: () => Db;
  /** The document embedder; defaults to OpenRouter's. */
  embed?: Embedder;
  fetch?: typeof fetch;
  opRead?: OpRead;
  /** The clock for a note with no `occurred_at`. */
  now?: () => Date;
}

interface Params {
  content: string;
  title?: string | null;
  repository?: string | null;
  occurred_at?: string | null;
}

export interface IngestOutcome {
  ok: boolean;
  ids: string[];
  embedded: number;
  degraded?: boolean;
  reason?: string;
}

/** The name a document goes by when it carries no title: a short content fingerprint. */
export const nameOf = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 12);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runMemoryIngest(params: Params, deps: Deps = {}, signal?: AbortSignal): Promise<IngestOutcome> {
  const content = typeof params.content === "string" ? params.content.trim() : "";
  if (content === "") return { ok: false, ids: [], embedded: 0, degraded: true, reason: "empty content" };
  let occurredAt: string;
  if (params.occurred_at == null) occurredAt = (deps.now?.() ?? new Date()).toISOString();
  else {
    const parsed = Date.parse(params.occurred_at);
    if (Number.isNaN(parsed)) throw new Error("occurred_at must be a timestamp");
    occurredAt = new Date(parsed).toISOString();
  }

  const name = params.title?.trim() ? params.title.trim() : nameOf(content);
  const sessionPath = `documents/${name}`;
  const source = "omp";
  const chunks = chunkDocument(content, source, name);
  const rows: MemoryChunkRow[] = chunks.map((chunk, chunkIndex) => ({
    id: chunk.id,
    sessionPath,
    source,
    ...(params.repository ? { repository: params.repository } : {}),
    occurredAt,
    chunkIndex,
    body: chunk.text,
  }));

  const env = deps.env ?? process.env;
  // The store is reached (schema ensured) before the embedder runs, so an unreachable store costs no embedding.
  const db = (deps.db ?? (() => sharedDb(env)))();
  await ensureMemorySchema(db);
  const embed = deps.embed ?? openRouterEmbedder({ env, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.opRead ? { opRead: deps.opRead } : {}) });

  let embedded = 0;
  let reason: string | undefined;
  signal?.throwIfAborted();
  try {
    const vectors = await embed(rows.map((row) => row.body), signal);
    vectors.forEach((vector, at) => {
      const row = rows[at];
      if (row !== undefined) row.embedding = vector;
    });
    embedded = vectors.length;
  } catch (error) {
    signal?.throwIfAborted();
    reason = `embedding refused: ${messageOf(error)} — the rows were written without vectors`;
  }

  signal?.throwIfAborted();
  await writeMemoryChunks(db, rows);
  await dropStaleChunks(db, sessionPath, rows.length);
  return {
    ok: true,
    ids: rows.map((row) => row.id),
    embedded,
    ...(reason === undefined ? {} : { degraded: true, reason }),
  };
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "Memory ingest",
    description: DESCRIPTION,
    loadMode: "discoverable" as const,
    approval: "write" as const,
    parameters: z.object({
      content: z.string().min(1).describe("The fact, decision or document to keep, in its own words."),
      title: z.string().nullable().optional().describe("What the document is called in the store; the content hash names it otherwise."),
      repository: z.string().nullable().optional().describe("The repository the note belongs to, named by its directory."),
      occurred_at: z.string().nullable().optional().describe("ISO instant the note belongs to; the ingest time when omitted."),
    }),
    async execute(_toolCallId: string, params: Params, onUpdate: Update | undefined, _ctx: unknown, signal?: AbortSignal) {
      const output = await withHeartbeat(onUpdate, "memory_ingest is writing", () => runMemoryIngest(params, deps, signal));
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  };
}

const factory: CustomToolFactory = (pi) => makeTool(pi) as never;

export default factory;
