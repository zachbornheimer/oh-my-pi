/**
 * Session hibernation: return an idle (or blocked) process's reclaimable
 * memory and connections to the OS, and re-establish them on demand.
 *
 * One controller serves both triggers:
 * - turn stop: {@link SessionHibernator.onTurnStop} -> {@link SessionHibernator.onEntryWake}
 * - a tool call that blocks the turn: {@link SessionHibernator.onToolCallStart} ->
 *   {@link SessionHibernator.onToolCallEnd}
 *
 * Hibernating runs the caller's `dehydrate` (drain queued writes, drop caches,
 * close pools), then a garbage collection and heap shrink. Waking runs the
 * caller's `rehydrate`; storages reconnect lazily, so the default needs none.
 */
import type { SessionStorage } from "./session-storage";
import { clearSessionListingCache } from "./session-listing";

export type HibernationState = "active" | "hibernating" | "hibernated";
export type HibernateReason = "turn_stop" | "tool_call" | "manual";
export type WakeReason = "entry" | "tool_result" | "manual";

/** Tools that block a turn for as long as they run; hibernation starts after a short settle. */
export const DEFAULT_IMMEDIATE_BLOCKING_TOOLS: ReadonlySet<string> = new Set([
	"run_command",
	"wait",
	"task",
	"ask_mastra",
	"execute_ticket",
	"software_factory",
]);

/** Settle delay for {@link SessionHibernatorOptions.immediateBlockingTools}: a command that returns within it never hibernates. */
export const IMMEDIATE_BLOCKING_TOOL_SETTLE_MS = 250;

export interface SessionHibernatorTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface SessionHibernatorOptions {
	/** Quiet time after a turn stops before hibernating; `0` hibernates immediately. Default `5_000`. */
	idleGraceMs?: number;
	/** How long a tool call outside `immediateBlockingTools` runs before hibernating; `0` hibernates immediately. Default `1_500`. */
	blockingToolGraceMs?: number;
	/** Tools that hibernate after {@link IMMEDIATE_BLOCKING_TOOL_SETTLE_MS} (capped by `blockingToolGraceMs`). */
	immediateBlockingTools?: ReadonlySet<string>;
	/** Storage whose queued writes the default `dehydrate` drains. Ignored when `dehydrate` is given. */
	storage?: Pick<SessionStorage, "drain"> | { drain?(): Promise<void> };
	/** Release what can be re-acquired. Default: drain `storage`, then clear the session listing cache. */
	dehydrate?: (reason: HibernateReason) => Promise<void> | void;
	/** Re-acquire what `dehydrate` released. Default: nothing (storages reconnect lazily). */
	rehydrate?: (reason: WakeReason) => Promise<void> | void;
	/** Runs after every `dehydrate`. Default: `Bun.gc(true)` then `Bun.shrink?.()`. */
	gcAndShrink?: () => void;
	/** Resident set size in bytes, sampled around `dehydrate` for {@link HibernationStats.lastReclaimedMb}. Default `process.memoryUsage.rss()`. */
	rssBytes?: () => number;
	/** Timer seam. Default `setTimeout`/`clearTimeout`, unref'd so a pending timer never holds the process open. */
	timers?: SessionHibernatorTimers;
}

export interface HibernationStats {
	state: HibernationState;
	hibernateCount: number;
	wakeCount: number;
	lastReason: HibernateReason | undefined;
	lastWakeReason: WakeReason | undefined;
	/** Resident MB released by the last hibernation; never negative. */
	lastReclaimedMb: number;
	/** The last `dehydrate`/`rehydrate` failure, kept so a failing hook is visible without breaking the session. */
	lastError: string | undefined;
}

const BYTES_PER_MB = 1024 * 1024;

const defaultTimers: SessionHibernatorTimers = {
	set(callback, ms) {
		const handle = setTimeout(callback, ms);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clear(handle) {
		clearTimeout(handle as NodeJS.Timeout);
	},
};

function defaultGcAndShrink(): void {
	Bun.gc(true);
	(Bun as unknown as { shrink?: () => void }).shrink?.();
}

export class SessionHibernator {
	readonly #idleGraceMs: number;
	readonly #blockingToolGraceMs: number;
	readonly #immediateBlockingTools: ReadonlySet<string>;
	readonly #dehydrate: (reason: HibernateReason) => Promise<void> | void;
	readonly #rehydrate: ((reason: WakeReason) => Promise<void> | void) | undefined;
	readonly #gcAndShrink: () => void;
	readonly #rssBytes: () => number;
	readonly #timers: SessionHibernatorTimers;
	readonly #inFlightTools = new Set<string>();
	readonly #toolTimers = new Map<string, unknown>();
	#idleTimer: unknown;
	#state: HibernationState = "active";
	#hibernation: Promise<void> | undefined;
	#disposed = false;
	#hibernateCount = 0;
	#wakeCount = 0;
	#lastReason: HibernateReason | undefined;
	#lastWakeReason: WakeReason | undefined;
	#lastReclaimedMb = 0;
	#lastError: string | undefined;

	constructor(options: SessionHibernatorOptions = {}) {
		this.#idleGraceMs = Math.max(0, options.idleGraceMs ?? 5_000);
		this.#blockingToolGraceMs = Math.max(0, options.blockingToolGraceMs ?? 1_500);
		this.#immediateBlockingTools = options.immediateBlockingTools ?? DEFAULT_IMMEDIATE_BLOCKING_TOOLS;
		const storage = options.storage;
		this.#dehydrate =
			options.dehydrate ??
			(async () => {
				await storage?.drain?.();
				clearSessionListingCache();
			});
		this.#rehydrate = options.rehydrate;
		this.#gcAndShrink = options.gcAndShrink ?? defaultGcAndShrink;
		this.#rssBytes = options.rssBytes ?? (() => process.memoryUsage.rss());
		this.#timers = options.timers ?? defaultTimers;
	}

	get state(): HibernationState {
		return this.#state;
	}

	stats(): HibernationStats {
		return {
			state: this.#state,
			hibernateCount: this.#hibernateCount,
			wakeCount: this.#wakeCount,
			lastReason: this.#lastReason,
			lastWakeReason: this.#lastWakeReason,
			lastReclaimedMb: this.#lastReclaimedMb,
			lastError: this.#lastError,
		};
	}

	/** A turn ended and the session is idle at the prompt: hibernate now (`idleGraceMs === 0`) or after the grace. */
	onTurnStop(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#cancelIdleTimer();
		if (this.#idleGraceMs === 0) return this.hibernate("turn_stop");
		this.#idleTimer = this.#timers.set(() => {
			this.#idleTimer = undefined;
			void this.hibernate("turn_stop");
		}, this.#idleGraceMs);
		return Promise.resolve();
	}

	/** The session is about to be used (input, agent start): cancel pending hibernation and wake if dehydrated. */
	async onEntryWake(): Promise<void> {
		if (this.#disposed) return;
		this.#cancelIdleTimer();
		this.#cancelToolTimers();
		await this.wake("entry");
	}

	/** A tool call began; one that stays in flight past its settle delay hibernates the process while it blocks. */
	onToolCallStart(toolCallId: string, toolName: string): void {
		if (this.#disposed) return;
		// Tool activity means the turn is live: a pending turn-stop hibernation no longer applies.
		this.#cancelIdleTimer();
		this.#inFlightTools.add(toolCallId);
		this.#cancelToolTimer(toolCallId);
		const delayMs = this.#immediateBlockingTools.has(toolName)
			? Math.min(IMMEDIATE_BLOCKING_TOOL_SETTLE_MS, this.#blockingToolGraceMs)
			: this.#blockingToolGraceMs;
		const fire = (): void => {
			this.#toolTimers.delete(toolCallId);
			if (this.#inFlightTools.has(toolCallId)) void this.hibernate("tool_call");
		};
		if (delayMs === 0) {
			fire();
			return;
		}
		this.#toolTimers.set(toolCallId, this.#timers.set(fire, delayMs));
	}

	/** A tool call finished; once none remain in flight, a tool-call hibernation wakes. */
	async onToolCallEnd(toolCallId: string): Promise<void> {
		if (this.#disposed) return;
		this.#inFlightTools.delete(toolCallId);
		this.#cancelToolTimer(toolCallId);
		if (this.#inFlightTools.size > 0) return;
		await this.wake("tool_result");
	}

	/** Dehydrate, then collect garbage and shrink the heap. No-op unless active. Never rejects. */
	hibernate(reason: HibernateReason): Promise<void> {
		if (this.#disposed || this.#state !== "active") return this.#hibernation ?? Promise.resolve();
		this.#state = "hibernating";
		const run = this.#runHibernation(reason);
		this.#hibernation = run;
		return run;
	}

	async #runHibernation(reason: HibernateReason): Promise<void> {
		const before = this.#rssBytes();
		try {
			await this.#dehydrate(reason);
		} catch (error) {
			this.#lastError = errorMessage(error);
		}
		try {
			this.#gcAndShrink();
		} catch (error) {
			this.#lastError = errorMessage(error);
		}
		this.#lastReclaimedMb = Math.max(0, Math.round(((before - this.#rssBytes()) / BYTES_PER_MB) * 10) / 10);
		this.#lastReason = reason;
		this.#hibernateCount++;
		this.#state = "hibernated";
		this.#hibernation = undefined;
	}

	/** Rehydrate after a hibernation, waiting out one still dehydrating. No-op when active. Never rejects. */
	async wake(reason: WakeReason): Promise<void> {
		if (this.#disposed) return;
		await this.#hibernation;
		if (this.#state !== "hibernated") return;
		// Flip before the awaited rehydrate so a concurrent wake does not rehydrate twice.
		this.#state = "active";
		this.#wakeCount++;
		this.#lastWakeReason = reason;
		try {
			await this.#rehydrate?.(reason);
		} catch (error) {
			this.#lastError = errorMessage(error);
		}
	}

	/** Cancel every pending timer and ignore later events. */
	dispose(): void {
		this.#disposed = true;
		this.#cancelIdleTimer();
		this.#cancelToolTimers();
		this.#inFlightTools.clear();
	}

	#cancelIdleTimer(): void {
		if (this.#idleTimer === undefined) return;
		this.#timers.clear(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	#cancelToolTimer(toolCallId: string): void {
		const timer = this.#toolTimers.get(toolCallId);
		if (timer === undefined) return;
		this.#timers.clear(timer);
		this.#toolTimers.delete(toolCallId);
	}

	#cancelToolTimers(): void {
		for (const timer of this.#toolTimers.values()) this.#timers.clear(timer);
		this.#toolTimers.clear();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
