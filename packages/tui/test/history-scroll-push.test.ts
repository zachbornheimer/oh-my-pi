import { describe, expect, it } from "bun:test";
import {
	type AnimationFrame,
	TranscriptContainer,
	type TranscriptStableRow,
} from "@oh-my-pi/pi-tui/chrome/transcript-container";
import {
	type Component,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// Scroll-push integrity: while a history batch is appended below committed
// rows, the physical write scrolls the top of the screen into native
// scrollback. Rows baked into scrollback are immutable to every later
// repaint, so the write must only ever push committed history rows and
// blanks — never an unfinished frame — and the writer's screen model must
// keep matching the terminal after every acknowledged paint.

interface ScriptedFrame {
	history?: { id: number; rows: string[] };
	viewport: string[];
}

class ScriptedProvider implements TerminalFrameProvider {
	#frames: ScriptedFrame[];
	#index = 0;
	readonly acknowledged: number[] = [];

	constructor(frames: ScriptedFrame[]) {
		this.#frames = frames;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		const frame = this.#frames[Math.min(this.#index, this.#frames.length - 1)]!;
		this.#index++;
		return { history: frame.history, viewport: frame.viewport };
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		// Like the real composer: a retired batch is never offered again.
		for (const frame of this.#frames) {
			if (frame.history?.id === id) frame.history = undefined;
		}
	}
}

/** Virtual terminal with a controllable output backlog, for render deferral. */
class BacklogTerminal extends VirtualTerminal {
	pending = 0;

	get pendingOutputBytes(): number | undefined {
		return this.pending;
	}
}

/**
 * Immediate forced renders; delayed renders (cadence, backlog retries) queue
 * until `settle()` pumps them, so deferral paths stay observable instead of
 * recursing synchronously.
 */
class SettleScheduler {
	#pending = new Set<() => void>();

	settle(): void {
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}

	now(): number {
		return 0;
	}

	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel: () => this.#pending.delete(callback) };
	}

	scheduleRender(callback: () => void) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}
}

function openTui(terminal: VirtualTerminal, provider: TerminalFrameProvider): { tui: TUI; scheduler: SettleScheduler } {
	const scheduler = new SettleScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	return { tui, scheduler };
}

/** Stripped scrollback rows that scrolled past the live viewport. */
function scrollbackOf(terminal: VirtualTerminal): string[] {
	const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	return buffer.slice(0, terminal.getBufferPosition().baseY);
}

/** Stripped live screen rows (the active grid). */
function screenOf(terminal: VirtualTerminal): string[] {
	const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	return buffer.slice(terminal.getBufferPosition().baseY);
}

/** Stripped scrollback plus screen rows, blank rows removed. */
function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

describe("history scroll-push", () => {
	it("a streaming commit chain scrolls only committed rows into scrollback", () => {
		const terminal = new VirtualTerminal(24, 6);
		const provider = new ScriptedProvider([
			// First paint fills the screen with the live tail.
			{ viewport: ["a1", "a2", "a3", "a4", "a5", "ed"] },
			// Blocks settle and retire while streaming continues below.
			{ history: { id: 1, rows: ["a1", "a2"] }, viewport: ["a3", "a4", "a5", "b1", "ed"] },
			{ history: { id: 2, rows: ["a3"] }, viewport: ["a4", "a5", "b1", "b2", "ed"] },
			{ history: { id: 3, rows: ["a4"] }, viewport: ["a5", "b1", "b2", "b3", "ed"] },
			{ history: { id: 4, rows: ["a5"] }, viewport: ["b1", "b2", "b3", "b4", "ed"] },
			{ history: { id: 5, rows: ["b1"] }, viewport: ["b2", "b3", "b4", "b5", "ed"] },
		]);
		const { tui, scheduler } = openTui(terminal, provider);
		for (let frame = 1; frame < 6; frame++) tui.requestRender(true);
		scheduler.settle();

		expect(provider.acknowledged).toEqual([1, 2, 3, 4, 5]);
		expect(scrollbackOf(terminal)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
		expect(screenOf(terminal)).toEqual(["b1", "b2", "b3", "b4", "b5", "ed"]);
		tui.stop();
	});

	it("an oversized batch pushes committed rows and blanks, never the old frame", () => {
		const terminal = new VirtualTerminal(24, 6);
		const provider = new ScriptedProvider([
			{ viewport: ["a1", "a2", "a3", "ed"] },
			{
				history: { id: 1, rows: ["h1", "h2", "h3"] },
				viewport: ["a1", "a2", "a3", "ed"],
			},
		]);
		const { tui, scheduler } = openTui(terminal, provider);
		tui.requestRender(true);
		scheduler.settle();

		expect(scrollbackOf(terminal)).toEqual(["h1"]);
		expect(screenOf(terminal)).toEqual(["h2", "h3", "a1", "a2", "a3", "ed"]);
		tui.stop();
	});

	it("a backpressure-deferred render advances no committed state", () => {
		const terminal = new BacklogTerminal(24, 6);
		const provider = new ScriptedProvider([
			{ viewport: ["a1", "a2", "a3", "a4", "a5", "ed"] },
			{ history: { id: 1, rows: ["a1", "a2"] }, viewport: ["a3", "a4", "a5", "b1", "ed"] },
			{ history: { id: 2, rows: ["a3"] }, viewport: ["a4", "a5", "b1", "b2", "ed"] },
		]);
		const { tui, scheduler } = openTui(terminal, provider);
		expect(scrollbackOf(terminal)).toEqual([]);

		// The terminal owes bytes: the frame composes nothing, acks nothing,
		// and the physical screen still shows the old frame untouched.
		terminal.pending = 1024 * 1024;
		tui.requestRender(true);
		expect(provider.acknowledged).toEqual([]);
		expect(scrollbackOf(terminal)).toEqual([]);
		expect(screenOf(terminal)).toEqual(["a1", "a2", "a3", "a4", "a5", "ed"]);

		// Backlog drains: the retry paints the freshest state in one frame.
		terminal.pending = 0;
		for (let frame = 0; frame < 4; frame++) scheduler.settle();
		expect(provider.acknowledged).toEqual([1, 2]);
		expect(scrollbackOf(terminal)).toEqual(["a1", "a2"]);
		expect(screenOf(terminal)).toEqual(["a3", "a4", "a5", "b1", "b2", "ed"]);
		tui.stop();
	});

	it("keeps a scrolling commit on the row grid for exact-width rows", () => {
		const width = 10;
		const full = (text: string): string => text.padEnd(width, "x");
		const terminal = new VirtualTerminal(width, 4);
		const provider = new ScriptedProvider([
			{ viewport: [full("live"), full("mor"), full("rows"), "ed"] },
			{
				history: { id: 1, rows: [full("hist-1"), full("hist-2")] },
				viewport: [full("live"), full("mor"), full("rows"), "ed"],
			},
		]);
		const { tui } = openTui(terminal, provider);
		tui.requestRender(true);

		expect(provider.acknowledged).toEqual([1]);
		// Both history rows overflow the 4-row screen with the 4-row viewport,
		// so the write pushes exactly the two committed rows.
		expect(scrollbackOf(terminal)).toEqual([full("hist-1"), full("hist-2")]);
		expect(screenOf(terminal)).toEqual([full("live"), full("mor"), full("rows"), "ed"]);
		tui.stop();
	});

	it("keeps a scrolling commit on the row grid for non-ASCII rows", () => {
		const terminal = new VirtualTerminal(24, 4);
		const provider = new ScriptedProvider([
			{ viewport: ["活着就是改变", "⚡ streaming ⚡", "表格 | 内容 | 行", "ed"] },
			{
				history: { id: 1, rows: ["历史第一行内容", "历史第二行内容"] },
				viewport: ["活着就是改变", "⚡ streaming ⚡", "表格 | 内容 | 行", "ed"],
			},
		]);
		const { tui } = openTui(terminal, provider);
		tui.requestRender(true);

		expect(provider.acknowledged).toEqual([1]);
		expect(scrollbackOf(terminal)).toEqual(["历史第一行内容", "历史第二行内容"]);
		expect(screenOf(terminal)).toEqual(["活着就是改变", "⚡ streaming ⚡", "表格 | 内容 | 行", "ed"]);
		tui.stop();
	});

	it("quarantines control characters that would move the cursor between rows", () => {
		const terminal = new VirtualTerminal(24, 4);
		const provider = new ScriptedProvider([
			{ viewport: ["live-1", "live-2", "ed"] },
			{
				history: { id: 1, rows: ["line-one\nline-two"] },
				viewport: ["live-1", "live-2", "ed"],
			},
			{ viewport: ["fresh-1", "fresh-2", "ed"] },
		]);
		const { tui } = openTui(terminal, provider);
		tui.requestRender(true);
		tui.requestRender(true);

		// A row containing a line feed would scroll the bottom row off the
		// grid untracked: every later row lands one row too low and the writer
		// diffs against a screen that no longer exists.
		expect(provider.acknowledged).toEqual([1]);
		expect(scrollbackOf(terminal)).toEqual([]);
		expect(screenOf(terminal)).toEqual(["line-one line-two", "fresh-1", "fresh-2", "ed"]);
		tui.stop();
	});

	// The production pipeline: a real TranscriptContainer retires streaming
	// rows under capacity pressure while the real writer scrolls them into
	// native scrollback. The oracle is the ledger invariant: every row the
	// terminal ever received must appear exactly once, committed rows in order,
	// and the live tail at the bottom — no missing, duplicated, or overlapped
	// rows in either scrollback or screen.
	it("streams a whole response through the real container and writer without losing a row", () => {
		const height = 10;
		const chrome = ["composer", "status"];
		const capacity = height - chrome.length;
		const terminal = new BacklogTerminal(30, height);
		const transcript = new TranscriptContainer();
		const ledger: string[] = [];
		let offeredRows: readonly string[] = [];
		class StreamBlock implements Component {
			#rows: string[] = [];
			#finalized = false;
			readonly transcriptBlockMode = "appendOnly" as const;

			publish(row: string): void {
				this.#rows.push(row);
			}

			settle(): void {
				this.#finalized = true;
			}

			isTranscriptBlockFinalized(): boolean {
				return this.#finalized;
			}

			getTranscriptStableRows(): TranscriptStableRow[] {
				return this.#rows.map(row => ({ key: row }));
			}

			renderTranscriptStableRows(count: number): string[] {
				return this.#rows.slice(0, count);
			}

			render(): string[] {
				return this.#rows;
			}
		}
		const head = new StreamBlock();
		transcript.addChild(head);
		const frame: AnimationFrame = { now: 0, tick: 0 };
		const provider: TerminalFrameProvider = {
			renderFrame(viewport: ViewportSize): TerminalFramePlan {
				transcript.beginFrame(frame);
				// Like the composer: while a batch waits for its acknowledgement,
				// re-compose it so a discarded frame can be rendered again.
				const recomposed = transcript.rerenderOfferedBatch(viewport.columns);
				if (recomposed !== undefined) offeredRows = recomposed.rows;
				const history = recomposed ?? transcript.peekFinalizedBatch(viewport.columns, capacity);
				if (history !== undefined && recomposed === undefined) offeredRows = history.rows;
				const live = transcript.renderViewport(viewport.columns, capacity, frame);
				return { history, viewport: [...live, ...chrome] };
			},
			acknowledgeHistory(id: number): void {
				transcript.acknowledgeFinalizedBatch(id);
				ledger.push(...offeredRows.filter(row => row !== ""));
			},
		};
		const scheduler = new SettleScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		const published: string[] = [];
		const stream = (count: number): void => {
			for (let index = 0; index < count; index++) {
				const row = `row-${published.length + 1}`;
				published.push(row);
				head.publish(row);
				tui.requestRender(true);
			}
			scheduler.settle();
		};
		const expectIntact = (): void => {
			const received = plainBuffer(terminal).filter(row => row !== "");
			const live = published.slice(ledger.length);
			expect(received).toEqual([...ledger, ...live, ...chrome]);
		};

		// A long response streams under pressure: retirement batches commit while
		// the head keeps publishing, and the writer scroll-pushes each batch.
		stream(26);
		expectIntact();

		// The response finishes: the head settles and its remaining rows commit.
		head.settle();
		tui.requestRender(true);
		scheduler.settle();
		expectIntact();
		tui.stop();
	});
});
