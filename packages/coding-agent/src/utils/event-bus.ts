import { logger } from "@oh-my-pi/pi-utils";

/**
 * Methods are bound arrow fields: upstream Pi's `createEventBus()` returns
 * closures, so extensions (e.g. `pi-gemini-acp`) detach `pi.events.on` and
 * `pi.events.emit` and call them without a receiver.
 */
export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	emit = (channel: string, data: unknown): void => {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	};

	on = (channel: string, handler: (data: unknown) => void): (() => void) => {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	};

	clear = (): void => {
		this.#listeners.clear();
	};
}

/**
 * A view of a parent bus that remembers what its owner subscribed to, so the owner can be
 * retired (an extension reloaded or removed) without leaving its listeners behind. Emitting and
 * subscribing reach the parent bus; {@link disposeAll} unsubscribes only what this view added.
 */
export class ScopedEventBus extends EventBus {
	readonly #subscriptions = new Set<() => void>();

	constructor(parent: EventBus) {
		super();
		this.emit = parent.emit;
		this.clear = parent.clear;
		this.on = (channel, handler) => {
			const unsubscribe = parent.on(channel, handler);
			const tracked = () => {
				this.#subscriptions.delete(tracked);
				unsubscribe();
			};
			this.#subscriptions.add(tracked);
			return tracked;
		};
	}

	/** Unsubscribes every listener this view added and has not already removed. */
	disposeAll(): void {
		// Each unsubscribe removes itself from the set mid-iteration, which Set iteration tolerates.
		for (const unsubscribe of this.#subscriptions) unsubscribe();
	}
}

/**
 * Publishes a subagent frame on the session bus and the observability bus.
 * SDK embedders may pass the same EventBus for both slots; the identity check
 * skips the aliased re-emit so listeners never see duplicate frames.
 */
export function emitSubagentFrame(
	eventBus: EventBus | undefined,
	subagentEventBus: EventBus | undefined,
	channel: string,
	payload: unknown,
): void {
	eventBus?.emit(channel, payload);
	if (subagentEventBus && subagentEventBus !== eventBus) {
		subagentEventBus.emit(channel, payload);
	}
}
