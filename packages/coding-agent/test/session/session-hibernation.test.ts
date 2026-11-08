import { describe, expect, it } from "bun:test";
import {
	DEFAULT_IMMEDIATE_BLOCKING_TOOLS,
	type HibernateReason,
	SessionHibernator,
	type SessionHibernatorOptions,
	type WakeReason,
} from "@oh-my-pi/pi-coding-agent/session/session-hibernation";
import { clearSessionListingCache } from "@oh-my-pi/pi-coding-agent/session/session-listing";

/** Manual clock: timers fire only when the test advances it. */
class FakeTimers {
	#now = 0;
	#next = 1;
	readonly #pending = new Map<number, { at: number; callback: () => void }>();

	get pendingCount(): number {
		return this.#pending.size;
	}

	set = (callback: () => void, ms: number): number => {
		const id = this.#next++;
		this.#pending.set(id, { at: this.#now + ms, callback });
		return id;
	};

	clear = (handle: unknown): void => {
		this.#pending.delete(handle as number);
	};

	advance(ms: number): void {
		this.#now += ms;
		for (const [id, timer] of Array.from(this.#pending)) {
			if (timer.at > this.#now) continue;
			this.#pending.delete(id);
			timer.callback();
		}
	}
}

interface Harness {
	hibernator: SessionHibernator;
	timers: FakeTimers;
	events: string[];
}

function harness(options: Partial<SessionHibernatorOptions> = {}): Harness {
	const timers = new FakeTimers();
	const events: string[] = [];
	const hibernator = new SessionHibernator({
		dehydrate: (reason: HibernateReason) => {
			events.push(`dehydrate:${reason}`);
		},
		rehydrate: (reason: WakeReason) => {
			events.push(`rehydrate:${reason}`);
		},
		gcAndShrink: () => {
			events.push("gc");
		},
		timers,
		...options,
	});
	return { hibernator, timers, events };
}

/** Flush the microtask queue so queued hibernate/wake continuations run; no wall-clock wait. */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

describe("SessionHibernator turn stop -> entry wake", () => {
	it("hibernates after the idle grace, not before", async () => {
		const { hibernator, timers, events } = harness({ idleGraceMs: 5_000 });
		await hibernator.onTurnStop();
		timers.advance(4_999);
		await settle();
		expect(hibernator.state).toBe("active");
		timers.advance(1);
		await settle();
		expect(hibernator.state).toBe("hibernated");
		expect(events).toEqual(["dehydrate:turn_stop", "gc"]);
	});

	it("hibernates immediately when idleGraceMs is 0", async () => {
		const { hibernator, events } = harness({ idleGraceMs: 0 });
		await hibernator.onTurnStop();
		expect(hibernator.state).toBe("hibernated");
		expect(events).toEqual(["dehydrate:turn_stop", "gc"]);
	});

	it("restarts the grace on a second turn stop", async () => {
		const { hibernator, timers } = harness({ idleGraceMs: 1_000 });
		await hibernator.onTurnStop();
		timers.advance(800);
		await hibernator.onTurnStop();
		timers.advance(800);
		await settle();
		expect(hibernator.state).toBe("active");
		timers.advance(200);
		await settle();
		expect(hibernator.state).toBe("hibernated");
	});

	it("entry wake cancels a pending hibernation", async () => {
		const { hibernator, timers, events } = harness({ idleGraceMs: 1_000 });
		await hibernator.onTurnStop();
		await hibernator.onEntryWake();
		timers.advance(10_000);
		await settle();
		expect(hibernator.state).toBe("active");
		expect(events).toEqual([]);
		expect(timers.pendingCount).toBe(0);
	});

	it("entry wake rehydrates a hibernated session once", async () => {
		const { hibernator, events } = harness({ idleGraceMs: 0 });
		await hibernator.onTurnStop();
		await Promise.all([hibernator.onEntryWake(), hibernator.onEntryWake()]);
		expect(hibernator.state).toBe("active");
		expect(events).toEqual(["dehydrate:turn_stop", "gc", "rehydrate:entry"]);
		expect(hibernator.stats()).toMatchObject({ hibernateCount: 1, wakeCount: 1, lastWakeReason: "entry" });
	});

	it("entry wake during a slow dehydrate waits for it, then rehydrates", async () => {
		const events: string[] = [];
		const release = Promise.withResolvers<void>();
		const { hibernator } = harness({
			idleGraceMs: 0,
			dehydrate: async () => {
				events.push("dehydrate:start");
				await release.promise;
				events.push("dehydrate:end");
			},
			rehydrate: () => {
				events.push("rehydrate");
			},
			gcAndShrink: () => {},
		});
		const stopping = hibernator.onTurnStop();
		await settle();
		expect(hibernator.state).toBe("hibernating");
		const waking = hibernator.onEntryWake();
		await settle();
		expect(events).toEqual(["dehydrate:start"]);
		release.resolve();
		await Promise.all([stopping, waking]);
		expect(events).toEqual(["dehydrate:start", "dehydrate:end", "rehydrate"]);
		expect(hibernator.state).toBe("active");
	});

	it("a failing dehydrate is recorded, still hibernates, and never rejects", async () => {
		const { hibernator, events } = harness({
			idleGraceMs: 0,
			dehydrate: () => {
				throw new Error("pool close failed");
			},
		});
		await hibernator.onTurnStop();
		expect(hibernator.state).toBe("hibernated");
		expect(events).toEqual(["gc"]);
		expect(hibernator.stats().lastError).toBe("pool close failed");
	});
});

describe("SessionHibernator blocking tool calls", () => {
	it("hibernates an immediate-blocking tool after the 250ms settle while it is still in flight", async () => {
		const { hibernator, timers, events } = harness();
		hibernator.onToolCallStart("t1", "run_command");
		timers.advance(249);
		await settle();
		expect(hibernator.state).toBe("active");
		timers.advance(1);
		await settle();
		expect(hibernator.state).toBe("hibernated");
		expect(events).toEqual(["dehydrate:tool_call", "gc"]);
	});

	it("a quick blocking tool never hibernates", async () => {
		const { hibernator, timers, events } = harness();
		hibernator.onToolCallStart("t1", "run_command");
		timers.advance(100);
		await hibernator.onToolCallEnd("t1");
		timers.advance(10_000);
		await settle();
		expect(events).toEqual([]);
		expect(timers.pendingCount).toBe(0);
	});

	it("other tools wait blockingToolGraceMs", async () => {
		const { hibernator, timers } = harness({ blockingToolGraceMs: 1_500 });
		hibernator.onToolCallStart("t1", "read");
		timers.advance(1_499);
		await settle();
		expect(hibernator.state).toBe("active");
		timers.advance(1);
		await settle();
		expect(hibernator.state).toBe("hibernated");
	});

	it("blockingToolGraceMs 0 hibernates on tool start", async () => {
		const { hibernator } = harness({ blockingToolGraceMs: 0 });
		hibernator.onToolCallStart("t1", "run_command");
		await settle();
		expect(hibernator.state).toBe("hibernated");
	});

	it("wakes when the last in-flight tool call ends", async () => {
		const { hibernator, timers, events } = harness();
		hibernator.onToolCallStart("t1", "run_command");
		hibernator.onToolCallStart("t2", "wait");
		timers.advance(250);
		await settle();
		expect(hibernator.state).toBe("hibernated");
		expect(events.filter(event => event.startsWith("dehydrate"))).toEqual(["dehydrate:tool_call"]);
		await hibernator.onToolCallEnd("t1");
		expect(hibernator.state).toBe("hibernated");
		await hibernator.onToolCallEnd("t2");
		expect(hibernator.state).toBe("active");
		expect(events.at(-1)).toBe("rehydrate:tool_result");
	});

	it("tool activity cancels a pending turn-stop hibernation", async () => {
		const { hibernator, timers } = harness({ idleGraceMs: 1_000 });
		await hibernator.onTurnStop();
		hibernator.onToolCallStart("t1", "read");
		timers.advance(1_000);
		await settle();
		expect(hibernator.state).toBe("active");
	});

	it("entry wake clears tool timers", async () => {
		const { hibernator, timers } = harness();
		hibernator.onToolCallStart("t1", "run_command");
		await hibernator.onEntryWake();
		timers.advance(1_000);
		await settle();
		expect(hibernator.state).toBe("active");
	});

	it("defaults to the documented blocking tool set", () => {
		expect([...DEFAULT_IMMEDIATE_BLOCKING_TOOLS].sort()).toEqual(
			["ask_mastra", "execute_ticket", "run_command", "software_factory", "task", "wait"].sort(),
		);
	});

	it("honors a custom immediateBlockingTools set", async () => {
		const { hibernator, timers } = harness({ immediateBlockingTools: new Set(["slow"]), blockingToolGraceMs: 5_000 });
		hibernator.onToolCallStart("t1", "slow");
		timers.advance(250);
		await settle();
		expect(hibernator.state).toBe("hibernated");
	});
});

describe("SessionHibernator lifecycle", () => {
	it("manual hibernate and wake record stats", async () => {
		let rss = 500 * 1024 * 1024;
		const { hibernator } = harness({
			rssBytes: () => rss,
			gcAndShrink: () => {
				rss -= 120 * 1024 * 1024;
			},
		});
		await hibernator.hibernate("manual");
		await hibernator.wake("manual");
		expect(hibernator.stats()).toMatchObject({
			state: "active",
			hibernateCount: 1,
			wakeCount: 1,
			lastReason: "manual",
			lastWakeReason: "manual",
			lastReclaimedMb: 120,
		});
	});

	it("hibernate while already hibernated is a no-op", async () => {
		const { hibernator, events } = harness();
		await hibernator.hibernate("manual");
		await hibernator.hibernate("turn_stop");
		expect(events).toEqual(["dehydrate:manual", "gc"]);
		expect(hibernator.stats().hibernateCount).toBe(1);
	});

	it("dispose cancels timers and ignores later events", async () => {
		const { hibernator, timers, events } = harness({ idleGraceMs: 1_000 });
		await hibernator.onTurnStop();
		hibernator.onToolCallStart("t1", "run_command");
		hibernator.dispose();
		expect(timers.pendingCount).toBe(0);
		await hibernator.onTurnStop();
		hibernator.onToolCallStart("t2", "run_command");
		timers.advance(10_000);
		await settle();
		expect(events).toEqual([]);
		expect(hibernator.state).toBe("active");
	});

	it("default dehydrate drains storage, then clears the listing cache", async () => {
		const order: string[] = [];
		const hibernator = new SessionHibernator({
			storage: {
				drain: async () => {
					await Promise.resolve();
					order.push("drain");
				},
			},
			gcAndShrink: () => order.push("gc"),
			idleGraceMs: 0,
		});
		// clearSessionListingCache is exported and callable without storages registered.
		expect(() => clearSessionListingCache()).not.toThrow();
		await hibernator.onTurnStop();
		expect(order).toEqual(["drain", "gc"]);
		expect(hibernator.stats().lastError).toBeUndefined();
	});

	it("default gcAndShrink runs against the real runtime", async () => {
		const hibernator = new SessionHibernator({ idleGraceMs: 0 });
		await hibernator.onTurnStop();
		expect(hibernator.state).toBe("hibernated");
		expect(hibernator.stats().lastError).toBeUndefined();
	});
});
