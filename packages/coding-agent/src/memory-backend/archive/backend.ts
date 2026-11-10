/**
 * The `archive` backend: this machine's own transcript archive, `public.memory_chunks` in the
 * session store, as omp's memory.
 *
 * Why it exists: every other backend either keeps memory on one machine (Mnemopi's SQLite) or
 * depends on a service this machine no longer runs (Hindsight). The archive already holds every
 * session omp has written, is reachable from the Mac and the fleet through the same
 * `SESSIONS_DB_URL` the session store uses, and needs no model call to write.
 *
 * What it does, in the three places a backend can act:
 *  - `beforeAgentStartPrompt`: on a fresh session's first substantive prompt, the closest earlier
 *    work is recalled and appended to that turn's prompt, so the first answer already knows it.
 *  - `buildDeveloperInstructions`: a standing note that the archive exists and how to use it.
 *  - `search` (the `recall` tool; not this step): the same ranking, on demand.
 *
 * Retention (`archive/retain.ts`): `start` subscribes the session, and once enough user turns have
 * settled the session's own turns are chunked into the same table, so a later session recalls them.
 * `archive.autoRetain` turns it off; `/memory enqueue` writes what is unretained now.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { MemoryBackend, MemoryBackendOperationContext, MemoryBackendSearchResult, MemoryBackendStatus, MemoryPromptPreparation } from "../types";
import type { ArchiveClient } from "./client.js";
import { openArchiveClient } from "./client.js";
import { ArchiveRetainer, archiveScopeOf } from "./retain.js";
import { archiveContextBlock, archiveRecall, type ArchiveContext, type ArchiveHit } from "./search.js";
import { cfgArchiveAutoRetain, cfgArchiveRetainEveryNTurns } from "./settings.js";

/** Prompt text shorter than this is a slash command, a test ping or a one-word nudge: no recall. */
const MIN_RECALL_PROMPT_CHARS = 24;
/**
 * A first-turn recall may not delay the session longer than this. A cold connection costs about
 * 2.5 s (TLS, auth, a suspended compute waking) and a warm query 150-400 ms, so the budget covers
 * the cold case once per session; `start` also warms the connection in the background.
 */
const RECALL_TIMEOUT_MS = 4000;

interface ArchiveState {
	client: ArchiveClient;
	context: ArchiveContext;
	/** Set once a first-turn recall has been delivered, so the block lands exactly once. */
	recalled: boolean;
}

/** One state per live session; a backend instance is shared by every session in the process. */
const states = new WeakMap<object, ArchiveState>();

/** One retainer per live session; a repeated `start` replaces the subscription instead of doubling it. */
const retainers = new WeakMap<object, ArchiveRetainer>();

/** The repository label for a directory: the checkout or worktree name, lowercased. */
export function archiveRepositoryOf(cwd: string): string | undefined {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	if (trimmed === "") return undefined;
	const worktree = trimmed.split(/[\\/]\.worktrees[\\/]/).at(-1);
	const base = (worktree ?? trimmed).split(/[\\/]/).at(-1)?.trim();
	return base === undefined || base === "" ? undefined : base.toLowerCase();
}

export interface ArchiveBackendOptions {
	/** Overrides the client; tests pass a fake. */
	client?: ArchiveClient;
	/** Embeds the query for the vector arm; absent means the lexical arm ranks alone. */
	embed?: (query: string, signal?: AbortSignal) => Promise<readonly number[] | undefined>;
	now?: () => Date;
}

function stateFor(session: object, cwd: string, client: ArchiveClient): ArchiveState {
	const existing = states.get(session);
	if (existing && existing.context.cwd === cwd) return existing;
	const state: ArchiveState = { client, context: { cwd, repository: archiveRepositoryOf(cwd) }, recalled: false };
	states.set(session, state);
	return state;
}

async function recallFor(state: ArchiveState, query: string, limit: number, options: ArchiveBackendOptions): Promise<ArchiveHit[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
	try {
		const result = await archiveRecall(state.client, query, state.context, {
			limit,
			signal: controller.signal,
			...(options.embed === undefined ? {} : { embed: options.embed }),
		});
		return result.hits;
	} catch (error) {
		logger.debug("archive: recall failed", { error: String(error) });
		return [];
	} finally {
		clearTimeout(timer);
	}
}

export function createArchiveBackend(options: ArchiveBackendOptions = {}): MemoryBackend {
	return {
		id: "archive",

		start(startOptions): void {
			// Non-throwing by contract: a store that cannot be opened is a backend that reports it, not a
			// session that fails to start.
			try {
				const client = options.client ?? openArchiveClient();
				const cwd = startOptions.session.sessionManager.getCwd() ?? process.cwd();
				const state = stateFor(startOptions.session, cwd, client);
				retainers.get(startOptions.session)?.detach();
				// Only a top-level session retains; a subagent's work reaches its parent's turns as a result.
				if (startOptions.taskDepth === 0) {
					const retainer = new ArchiveRetainer({
						client,
						session: startOptions.session,
						repository: state.context.repository,
						scope: archiveScopeOf(cwd),
						enabled: () => cfgArchiveAutoRetain.get(startOptions.settings) === true,
						everyNTurns: () => cfgArchiveRetainEveryNTurns.get(startOptions.settings),
						...(options.embed === undefined ? {} : { embed: options.embed }),
						...(options.now === undefined ? {} : { now: options.now }),
					});
					retainers.set(startOptions.session, retainer);
					retainer.attach();
				}
				// Warm the connection while the session boots so the first-turn recall is not the call that
				// pays for TLS, auth and a suspended compute waking.
				void client.query("select 1").catch(() => {});
			} catch (error) {
				logger.warn("archive: backend did not start", { error: String(error) });
			}
		},

		async buildDeveloperInstructions(_agentDir, cwd, _settings, session): Promise<string | undefined> {
			const state = session ? states.get(session) : undefined;
			if (state === undefined && options.client === undefined) return undefined;
			const repository = state?.context.repository ?? archiveRepositoryOf(cwd);
			return [
				"## Archive memory",
				`This machine records every session it runs in a shared archive. Call \`recall\` with what you are trying to do to read the earlier work on it; the archive covers every repository, and a hit from another one is still evidence.${repository === undefined ? "" : ` You are in \`${repository}\`; its own history is recorded under that name.`}`,
				"When the work settles a durable fact, a convention or a fix a later session would need, call `retain` before the final answer.",
			].join("\n");
		},

		async beforeAgentStartPrompt(session, promptText, signal): Promise<MemoryPromptPreparation | undefined> {
			const state = states.get(session);
			if (state === undefined || state.recalled) return undefined;
			if (promptText.trim().length < MIN_RECALL_PROMPT_CHARS) return undefined;
			if (signal?.aborted) return undefined;
			const hits = await recallFor(state, promptText, 6, options);
			const context = archiveContextBlock(hits);
			if (context === undefined) {
				state.recalled = true;
				return undefined;
			}
			return {
				context,
				commit: () => {
					// Lost ownership (the session rebound or was replaced) rejects the delivery without marking.
					if (states.get(session) !== state) return false;
					state.recalled = true;
					return true;
				},
			};
		},

		async clear(): Promise<void> {
			// The archive is shared and append-only by design; `/memory clear` must not erase another
			// repository's history. Retention TTLs are the next step's job.
		},

		async enqueue(_agentDir, _cwd, session): Promise<void> {
			// Retention runs when a session settles; this forces the write now, past the turn threshold.
			if (session) await retainers.get(session)?.retain(true);
		},

		async status(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus> {
			const state = context.session ? states.get(context.session) : undefined;
			const client = state?.client ?? options.client ?? openArchiveClient();
			try {
				const [row] = await client.query<{ n: number | string; newest: string | null }>(
					"select count(*)::int as n, max(occurred_at)::text as newest from public.memory_chunks",
				);
				return {
					backend: "archive",
					active: true,
					writable: false,
					searchable: true,
					...(state?.context.repository === undefined ? {} : { scope: state.context.repository }),
					database: client.url,
					...(row === undefined ? {} : { episodicCount: Number(row.n) }),
					...(row?.newest == null ? {} : { lastMemory: row.newest }),
				};
			} catch (error) {
				return { backend: "archive", active: false, writable: false, searchable: false, error: String(error) };
			}
		},

		async search(context, query, searchOptions): Promise<MemoryBackendSearchResult> {
			const state = context.session ? states.get(context.session) : undefined;
			const client = state?.client ?? options.client ?? openArchiveClient();
			const archiveContext: ArchiveContext = state?.context ?? {
				cwd: context.cwd,
				repository: archiveRepositoryOf(context.cwd),
			};
			const result = await archiveRecall(client, query, archiveContext, {
				...(searchOptions?.limit === undefined ? {} : { limit: searchOptions.limit }),
				...(searchOptions?.signal === undefined ? {} : { signal: searchOptions.signal }),
				...(options.embed === undefined ? {} : { embed: options.embed }),
			});
			return {
				backend: "archive",
				query,
				count: result.hits.length,
				items: result.hits.map((hit) => ({
					id: hit.id,
					content: hit.body,
					...(hit.source === undefined ? {} : { source: hit.source }),
					timestamp: hit.at,
					score: hit.score,
				})),
				...(result.hits.length === 0 && !result.lexical.used && !result.vector.used
					? { message: result.lexical.reason ?? result.vector.reason ?? "no result" }
					: {}),
			};
		},
	};
}

/** The singleton the resolver hands out. */
export const archiveBackend: MemoryBackend = createArchiveBackend();
