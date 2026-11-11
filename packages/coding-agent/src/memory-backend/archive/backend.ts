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
 *  - `beforeAgentStartPrompt`: on a fresh session's first substantive prompt, hybrid lexical +
 *    vector recall runs and Jev (`~typesafe/jev-latest`) filters the shortlist to every memory
 *    clearing the relevance threshold (not capped at 5; 0 injected when nothing clears the bar).
 *  - `buildDeveloperInstructions`: a standing note that the archive exists and how to use it.
 *  - `search` (the `recall` tool): the same hybrid + Jev ranking, on demand.
 *
 * Retention (`archive/retain.ts`): `start` subscribes the session, and once enough user turns have
 * settled the session's own turns are chunked into the same table, so a later session recalls them.
 * `archive.autoRetain` turns it off; `/memory enqueue` writes what is unretained now.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchResult,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../types";
import type { ArchiveClient } from "./client.js";
import { openArchiveClient } from "./client.js";
import { openArchiveEmbedder, openArchiveJevJudge } from "./openrouter.js";
import { ArchiveRetainer, archiveScopeOf, archiveWriteFact } from "./retain.js";
import {
	ARCHIVE_RELEVANCE_THRESHOLD,
	archiveContextBlock,
	archiveRecall,
	type ArchiveContext,
	type ArchiveHit,
	type ArchiveJudge,
} from "./search.js";
import { cfgArchiveAutoRetain, cfgArchiveFirstTurnLimit, cfgArchiveRetainEveryNTurns } from "./settings.js";

/** Prompt text shorter than this is a slash command, a test ping or a one-word nudge: no recall. */
const MIN_RECALL_PROMPT_CHARS = 24;
/**
 * A first-turn recall may not delay the session longer than this. Covers cold connection wake +
 * parallel OpenRouter embedding + Jev shortlist scoring.
 */
const RECALL_TIMEOUT_MS = 6000;

interface ArchiveState {
	client: ArchiveClient;
	context: ArchiveContext;
	firstTurnLimit: () => number;
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
	/** Scores shortlisted hits against the query; keeps all hits >= `threshold`. */
	judge?: ArchiveJudge;
	/** Minimum relevance confidence ([0, 1]) when `judge` is active. Default 0.65. */
	threshold?: number;
	now?: () => Date;
}

function stateFor(
	session: object,
	cwd: string,
	client: ArchiveClient,
	firstTurnLimit: () => number = () => 6,
): ArchiveState {
	const existing = states.get(session);
	if (existing && existing.context.cwd === cwd) {
		existing.firstTurnLimit = firstTurnLimit;
		return existing;
	}
	const state: ArchiveState = {
		client,
		context: { cwd, repository: archiveRepositoryOf(cwd) },
		firstTurnLimit,
		recalled: false,
	};
	states.set(session, state);
	return state;
}

async function recallFor(
	state: ArchiveState,
	query: string,
	fallbackLimit: number,
	options: ArchiveBackendOptions,
): Promise<ArchiveHit[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
	try {
		const result = await archiveRecall(state.client, query, state.context, {
			// When a Jev judge is active, do not cap at `fallbackLimit` (e.g. 6): inject every
			// memory that clears the relevance threshold.
			...(options.judge === undefined ? { limit: fallbackLimit } : {}),
			signal: controller.signal,
			...(options.embed === undefined ? {} : { embed: options.embed }),
			...(options.judge === undefined ? {} : { judge: options.judge }),
			threshold: options.threshold ?? ARCHIVE_RELEVANCE_THRESHOLD,
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
	let sharedClient: ArchiveClient | undefined = options.client;
	const clientOf = (): ArchiveClient => {
		sharedClient ??= openArchiveClient();
		return sharedClient;
	};

	return {
		id: "archive",

		start(startOptions): void {
			try {
				const client = clientOf();
				const cwd = startOptions.session.sessionManager.getCwd() ?? process.cwd();
				const state = stateFor(startOptions.session, cwd, client, () =>
					cfgArchiveFirstTurnLimit.get(startOptions.settings),
				);
				retainers.get(startOptions.session)?.detach();
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
				void client.query("select 1").catch(() => {});
			} catch (error) {
				logger.warn("archive: backend did not start", { error: String(error) });
			}
		},

		async buildDeveloperInstructions(_agentDir, cwd, _settings, session): Promise<string | undefined> {
			const state = session ? states.get(session) : undefined;
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
			const limit = state.firstTurnLimit();
			if (limit <= 0) {
				state.recalled = true;
				return undefined;
			}
			const hits = await recallFor(state, promptText, limit, options);
			const context = archiveContextBlock(hits);
			if (context === undefined) {
				state.recalled = true;
				return undefined;
			}
			return {
				context,
				commit: () => {
					if (states.get(session) !== state) return false;
					state.recalled = true;
					return true;
				},
			};
		},

		async clear(): Promise<void> {
			// The archive is shared and append-only by design; `/memory clear` must not erase another
			// repository's history.
		},

		async enqueue(_agentDir, _cwd, session): Promise<void> {
			if (session) await retainers.get(session)?.retain(true);
		},

		async status(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus> {
			const state = context.session ? states.get(context.session) : undefined;
			try {
				const client = state?.client ?? clientOf();
				const [row] = await client.query<{ n: number | string; newest: string | null }>(
					"select count(*)::int as n, max(occurred_at)::text as newest from public.memory_chunks",
				);
				return {
					backend: "archive",
					active: true,
					writable: true,
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
			const client = state?.client ?? clientOf();
			const archiveContext: ArchiveContext = state?.context ?? {
				cwd: context.cwd,
				repository: archiveRepositoryOf(context.cwd),
			};
			const result = await archiveRecall(client, query, archiveContext, {
				...(searchOptions?.limit === undefined ? {} : { limit: searchOptions.limit }),
				...(searchOptions?.signal === undefined ? {} : { signal: searchOptions.signal }),
				...(options.embed === undefined ? {} : { embed: options.embed }),
				...(options.judge === undefined ? {} : { judge: options.judge }),
				threshold: options.threshold ?? ARCHIVE_RELEVANCE_THRESHOLD,
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
					score: hit.confidence ?? hit.score,
				})),
				...(result.hits.length === 0 && !result.lexical.used && !result.vector.used
					? { message: result.lexical.reason ?? result.vector.reason ?? "no result" }
					: {}),
			};
		},

		async save(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult> {
			const state = context.session ? states.get(context.session) : undefined;
			const client = state?.client ?? clientOf();
			const repository = state?.context.repository ?? archiveRepositoryOf(context.cwd);
			const sessionPath = context.session?.sessionManager.getSessionFile();
			const result = await archiveWriteFact(
				client,
				context.cwd,
				{
					content: input.content,
					context: input.context,
					scope: input.scope,
					repository,
					source: input.source,
					sessionPath,
				},
				{
					...(options.embed === undefined ? {} : { embed: options.embed }),
					...(options.now === undefined ? {} : { now: options.now }),
				},
			);
			return {
				backend: "archive",
				stored: result.stored,
				...(result.id === undefined ? {} : { ids: [result.id] }),
			};
		},
	};
}

/** The singleton the resolver hands out: wired with OpenRouter embeddings and Jev relevance judging. */
export const archiveBackend: MemoryBackend = createArchiveBackend({
	embed: openArchiveEmbedder(),
	judge: openArchiveJevJudge(),
});
