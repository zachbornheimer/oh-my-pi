import type { CustomToolAPI, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type Db, sharedDb } from "./db.js";
import { type Embedder, openRouterEmbedder } from "./embed.js";
import { type Update, withHeartbeat } from "./heartbeat.js";
import type { OpRead } from "./openrouter_key.js";
import { MAX_LIMIT, recallMemory, type RecallOutcome } from "./search.js";

export const NAME = "memory_search";

export const DESCRIPTION = [
  "Search this machine's past agent sessions: what was tried, what broke, what was decided, and in which repository. Use it before rebuilding something that may already exist or to learn what a command was for; use `grep` for files in the current repository.",
  'Call `{"query":"what did we decide about the memory backend"}`. Optional `limit` (1-50, default 20, best match first), `repository` (a repository directory name, keeps only sessions that worked there) and `as_of` (an ISO instant: reads the store as it stood then, newest first). An empty `query` is refused.',
  "A BM25 arm and a vector arm rank the query and fuse by reciprocal rank. The vector arm embeds the query through OpenRouter (`OPENROUTER_API_KEY`, else 1Password); without a key, or when the store cannot be reached, the call still returns and `arms.vector.reason` or `reason` says why: it NEVER throws for that and NEVER returns a silently empty list.",
  "Needs `SESSIONS_DB_URL` (Neon Postgres, table `public.memory_chunks`). Read-only: runs SELECTs, writes nothing, caches nothing; sends the query text to OpenRouter for the embedding.",
  "Returns JSON `{evidence:[{id,score,source,session,at,repository?,text}],arms:{bm25,vector},degraded?,reason?}`: each chunk's own words (up to 4000 characters) with the session file and instant to cite it by, NEVER a summary. `degraded` is true only when no arm ran.",
].join(" ");

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  env?: NodeJS.ProcessEnv;
  /** The store; defaults to the process's shared Bun Postgres client on `SESSIONS_DB_URL`. */
  db?: () => Db;
  /** The query embedder; defaults to OpenRouter's. */
  embed?: Embedder;
  fetch?: typeof fetch;
  opRead?: OpRead;
}

interface Params {
  query: string;
  limit?: number | null;
  repository?: string | null;
  as_of?: string | null;
}

/** The instant as ISO, so Postgres reads one unambiguous UTC value whatever shape the caller wrote. */
export function isoInstant(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a timestamp`);
  return new Date(parsed).toISOString();
}

export async function runMemorySearch(params: Params, deps: Deps = {}, signal?: AbortSignal): Promise<RecallOutcome> {
  if (typeof params.query !== "string" || params.query === "") throw new Error("query is required: an empty query is refused");
  if (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_LIMIT)) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const asOf = params.as_of == null ? undefined : isoInstant(params.as_of, "as_of");
  const env = deps.env ?? process.env;
  let db: Db | undefined;
  let storeFailure: string | undefined;
  try {
    db = (deps.db ?? (() => sharedDb(env)))();
  } catch (error) {
    storeFailure = error instanceof Error ? error.message : String(error);
  }
  const embed = deps.embed ?? openRouterEmbedder({ env, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.opRead ? { opRead: deps.opRead } : {}) });
  return recallMemory(
    {
      query: params.query,
      ...(params.limit == null ? {} : { limit: params.limit }),
      ...(params.repository == null ? {} : { repository: params.repository }),
      ...(asOf === undefined ? {} : { asOf }),
    },
    { ...(db === undefined ? {} : { db }), ...(storeFailure === undefined ? {} : { storeFailure }), embed, ...(signal ? { signal } : {}) },
  );
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "Memory search",
    description: DESCRIPTION,
    loadMode: "essential" as const,
    approval: "read" as const,
    parameters: z.object({
      query: z.string().min(1).describe("What to remember, in plain words: a behaviour, an error, a decision, a path."),
      limit: z.number().int().positive().max(MAX_LIMIT).nullable().optional().describe("At most this many chunks, best match first (1-50, default 20)."),
      repository: z.string().nullable().optional().describe("Keep only sessions that worked in this repository (its directory name)."),
      as_of: z.string().nullable().optional().describe("ISO instant: read the store as it stood then, newest first."),
    }),
    async execute(_toolCallId: string, params: Params, onUpdate: Update | undefined, _ctx: unknown, signal?: AbortSignal) {
      const output = await withHeartbeat(onUpdate, "memory_search is searching", () => runMemorySearch(params, deps, signal));
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  };
}

const factory: CustomToolFactory = (pi) => makeTool(pi) as never;

export default factory;
