import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TerminalParkContext, type TerminalParkEvent, registerTerminalPark } from "./index";

type Handler = (event: unknown, ctx: unknown) => void;

/** Just enough of ExtensionAPI: records handlers so the test can fire events. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	const fire = (name: string, event: unknown, ctx: unknown): void => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return { pi: pi as never, fire, handlers };
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function markerPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-park-"));
	dirs.push(dir);
	return path.join(dir, "marker");
}

interface Probe {
	ctx: TerminalParkContext;
	calls: string[];
	/** Typed keystrokes reach the extension through this handler once it subscribed. */
	keystroke: () => void;
	state: { editor: string; background: boolean; idle: boolean; goal: "inactive" | "active" | "paused" };
}

function probe(options: { sessionModes?: boolean } = {}): Probe {
	const calls: string[] = [];
	const state: Probe["state"] = { editor: "", background: false, idle: true, goal: "inactive" };
	let onInput: (() => void) | undefined;
	const ctx: TerminalParkContext = {
		hasUI: true,
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		hasBackgroundWork: () => state.background,
		shutdown: () => void calls.push("shutdown"),
		ui: {
			getEditorText: () => state.editor,
			onTerminalInput: handler => {
				onInput = () => handler("x");
				return () => {};
			},
		},
		sessionManager: {
			flush: async () => void calls.push("flush"),
			ensureOnDisk: async () => void calls.push("ensureOnDisk"),
			getSessionId: () => "sess-1",
			getSessionFile: () => "/sessions/sess-1.jsonl",
		},
	};
	// The real host exposes the full SessionModeState; parking only reads goal.status.
	if (options.sessionModes !== false) {
		ctx.sessionModes = { getState: () => ({ goal: { status: state.goal } }) };
	}
	return { ctx, calls, keystroke: () => onInput?.(), state };
}

function events() {
	const seen: TerminalParkEvent[] = [];
	let waiting: ((event: TerminalParkEvent) => void) | undefined;
	return {
		seen,
		onEvent: (event: TerminalParkEvent) => {
			seen.push(event);
			waiting?.(event);
		},
		next: () => new Promise<TerminalParkEvent>(resolve => (waiting = resolve)),
	};
}

describe("terminal park", () => {
	it("writes the session id for the shell to resume, flushes first, then shuts omp down", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe();

		fire("session_start", {}, p.ctx);
		const event = await sink.next();

		expect(event.event).toBe("parked");
		expect(fs.readFileSync(marker, "utf8")).toBe("sess-1\n");
		// The transcript must be durable before the process is allowed to go.
		expect(p.calls).toEqual(["flush", "ensureOnDisk", "shutdown"]);
	});

	it("keeps the process while a background job runs, then parks once it ends", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe();
		p.state.background = true;

		fire("session_start", {}, p.ctx);
		const kept = await sink.next();
		expect(kept).toMatchObject({ event: "kept", reason: "background" });
		expect(fs.existsSync(marker)).toBe(false);
		expect(p.calls).toEqual([]);

		p.state.background = false;
		expect((await sink.next()).event).toBe("parked");
		expect(p.calls).toContain("shutdown");
	});

	it("keeps an unsent draft: exiting would lose what the user typed", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe();
		p.state.editor = "half a thought";

		fire("session_start", {}, p.ctx);

		expect(await sink.next()).toMatchObject({ event: "kept", reason: "draft" });
		expect(fs.existsSync(marker)).toBe(false);
		expect(p.calls).toEqual([]);
	});

	it("keeps an active goal: a parked tab cannot finish the work it owns", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe();
		p.state.goal = "active";

		fire("session_start", {}, p.ctx);

		expect(await sink.next()).toMatchObject({ event: "kept", reason: "goal" });
		expect(fs.existsSync(marker)).toBe(false);
		expect(p.calls).toEqual([]);
	});

	it("parks a paused goal: paused work does not hold the process", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe();
		p.state.goal = "paused";

		fire("session_start", {}, p.ctx);

		expect(await sink.next()).toMatchObject({ event: "parked", session: "sess-1" });
		expect(p.calls).toEqual(["flush", "ensureOnDisk", "shutdown"]);
	});

	it("parks when the host exposes no session modes: a missing accessor must not block", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe({ sessionModes: false });

		fire("session_start", {}, p.ctx);

		expect(await sink.next()).toMatchObject({ event: "parked", session: "sess-1" });
		expect(p.calls).toContain("shutdown");
	});

	it("restarts the idle clock on every keystroke", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 60, onEvent: sink.onEvent });
		const p = probe();

		fire("session_start", {}, p.ctx);
		// Type three times, each inside the idle window: the total outlasts one window.
		for (let i = 0; i < 3; i++) {
			await Bun.sleep(35);
			p.keystroke();
		}
		expect(sink.seen).toEqual([]);

		expect((await sink.next()).event).toBe("parked");
	});

	it("never parks while a turn is running", async () => {
		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 20, onEvent: sink.onEvent });
		const p = probe();
		p.state.idle = false;

		fire("session_start", {}, p.ctx);

		expect(await sink.next()).toMatchObject({ event: "kept", reason: "busy" });
		expect(p.calls).toEqual([]);
	});

	it("installs nothing without a marker path, and ignores sessions without a UI", async () => {
		const none = fakePi();
		registerTerminalPark(none.pi, { markerPath: undefined, idleMs: 10 });
		expect(none.handlers.size).toBe(0);

		const marker = markerPath();
		const { pi, fire } = fakePi();
		const sink = events();
		registerTerminalPark(pi, { markerPath: marker, idleMs: 10, onEvent: sink.onEvent });
		const p = probe();
		p.ctx.hasUI = false;
		fire("session_start", {}, p.ctx);
		await Bun.sleep(60);
		expect(sink.seen).toEqual([]);
		expect(p.calls).toEqual([]);
	});
	it.skipIf(!process.env.OMP_JOBOWNER)(
		"parks a real foreground owner job after tool idle grace without cancelling",
		async () => {
			const ownerScript = process.env.OMP_JOBOWNER!;
			const { brokerJobOwner, spawnBrokerJob, waitBrokerJob, parkableBrokerJob, parkBrokerJob } = await import(
				process.env.OMP_JOBOWNER_MODULE ?? "@oh-my-pi/pi-coding-agent/tools/job-owner"
			);
			const marker = markerPath();
			const root = path.dirname(marker);
			const owner = brokerJobOwner({ OMP_JOBOWNER: ownerScript, OMP_JOBS_ROOT: root })!;
			const job = await spawnBrokerJob(owner, {
				sessionId: "sess-1",
				toolCallId: "real-tool",
				command: "while [ ! -f release ]; do sleep 0.1; done; printf survived",
				cwd: root,
				env: {},
			});
			void waitBrokerJob(owner, "sess-1", "real-tool", job.dir);
			const { pi, fire } = fakePi();
			const sink = events();
			registerTerminalPark(pi, { markerPath: marker, idleMs: 5000, toolIdleMs: 30, onEvent: sink.onEvent });
			const p = probe();
			p.state.idle = false;
			p.ctx.getParkableTool = () => {
				const job = parkableBrokerJob("sess-1");
				return job && { toolCallId: job.toolCallId, idleSec: 0.03 };
			};
			p.ctx.parkTool = key => parkBrokerJob("sess-1", key);
			fire("session_start", {}, p.ctx);
			expect((await sink.next()).event).toBe("parked");
			expect(fs.readFileSync(marker, "utf8")).toBe("sess-1\ntool real-tool\n");
			expect(p.calls).toEqual(["flush", "ensureOnDisk", "shutdown"]);
			fs.writeFileSync(path.join(root, "release"), "");
			const result = await waitBrokerJob(owner, "sess-1", "real-tool", job.dir);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("survived");
		},
		30000,
	);
});
