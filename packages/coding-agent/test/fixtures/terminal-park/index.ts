/**
 * Scale-to-zero for an interactive terminal session. After a long idle, flush the transcript, tell the
 * launching shell which session this was (`OMP_TERMINAL_PARK_MARKER`), and ask omp to shut down. The shell is
 * already the terminal's holder, so it stays, shows one line, and runs `omp --resume <id>` on the next keypress.
 * That turns an idle tab's ~500 MB of Bun-native memory into a shell's few MB.
 *
 * Opt-in: acts only when the shell set the marker path, and only in a session with a UI (headless sessions use
 * `session-park`). Never exits while a turn runs, a message is queued, a background job is alive (exit cancels
 * jobs), a goal is active, or the editor holds an unsent draft (exit would lose it).
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_IDLE_SEC = 600;

/** What a handler context exposes that parking uses. */
export interface TerminalParkContext {
	hasUI?: boolean;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	hasBackgroundWork?: () => boolean;
	/** Only `goal.status` is read; the host supplies the full `SessionModeState`. */
	sessionModes?: { getState?: () => { goal?: { status?: "inactive" | "active" | "paused" } } };
	getParkableTool?: () => { toolCallId: string; idleSec: number } | undefined;
	parkTool?: (key: string) => boolean;
	shutdown?: () => void;
	ui?: {
		getEditorText?: () => string;
		onTerminalInput?: (handler: (data: string) => undefined) => () => void;
	};
	sessionManager?: {
		flush?: () => Promise<void>;
		ensureOnDisk?: () => Promise<void>;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
}

export type TerminalParkKeptReason =
	| "busy"
	| "background"
	| "goal"
	| "draft"
	| "no_session_id"
	| "unsafe_name"
	| "flush_failed"
	| "marker_failed"
	| "probe_failed";

export type TerminalParkEvent =
	| { event: "parked"; session: string }
	| { event: "kept"; reason: TerminalParkKeptReason; detail?: string };

export interface TerminalParkDeps {
	/** Where to tell the shell the session id. Default: `OMP_TERMINAL_PARK_MARKER`. No path, no parking. */
	markerPath?: string | undefined;
	/** Idle time before parking. Default: `OMP_TERMINAL_PARK_IDLE_SEC` seconds, else 600. */
	idleMs?: number;
	toolIdleMs?: number;
	onEvent?: (event: TerminalParkEvent) => void;
}

function defaultIdleMs(): number {
	const seconds = Number(process.env.OMP_TERMINAL_PARK_IDLE_SEC);
	return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_IDLE_SEC) * 1000;
}

export function registerTerminalPark(pi: ExtensionAPI, deps: TerminalParkDeps = {}): void {
	const markerPath = "markerPath" in deps ? deps.markerPath : process.env.OMP_TERMINAL_PARK_MARKER;
	if (!markerPath) return;
	const idleMs = deps.idleMs ?? defaultIdleMs();
	/** A listener must never decide whether the process lives. */
	const emit = (event: TerminalParkEvent): void => {
		try {
			deps.onEvent?.(event);
		} catch {
			/* a listener's throw is not a reason to end the session */
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let parking = false;

	let lastActivity = Date.now();
	/** Host probes are untrusted: one that throws cannot say, and "cannot say" means "work present". */
	const toolProbe = (ctx: TerminalParkContext): { toolCallId: string; idleSec: number } | undefined => {
		try {
			return ctx.getParkableTool?.();
		} catch {
			return undefined;
		}
	};
	/** A host that dropped this method is the same as one that says work is present: never park on it, never reject. */
	const backgroundWork = (ctx: TerminalParkContext): boolean | undefined => {
		try {
			return ctx.hasBackgroundWork?.();
		} catch {
			return undefined;
		}
	};
	/** An active goal is work the session still owns. A missing accessor cannot say either way, so it never
	 * blocks parking; one that throws cannot say, and "cannot say" means work present. */
	const activeGoal = (ctx: TerminalParkContext): boolean => {
		try {
			return ctx.sessionModes?.getState?.().goal?.status === "active";
		} catch {
			return true;
		}
	};
	const arm = (ctx: TerminalParkContext, activity = true): void => {
		if (activity) lastActivity = Date.now();
		clearTimeout(timer);
		const tool = toolProbe(ctx);
		const grace = tool ? (deps.toolIdleMs ?? tool.idleSec * 1000) : idleMs;
		timer = setTimeout(
			() => void check(ctx),
			Math.max(1, Math.min(grace - (Date.now() - lastActivity), deps.toolIdleMs ?? 20_000)),
		);
	};

	/** Park if nothing needs the process; otherwise look again after another idle window. */
	const check = async (ctx: TerminalParkContext): Promise<void> => {
		timer = undefined;
		if (parking) return;
		const keep = (reason: TerminalParkKeptReason, detail?: string): void => {
			emit(detail === undefined ? { event: "kept", reason } : { event: "kept", reason, detail });
			arm(ctx);
		};
		// Nothing awaits this timer-backed call, so a throw that escapes here becomes an unhandled
		// rejection and ends the session. Every untrusted host call below lives inside this guard:
		// a probe that throws means "cannot say", which is work present, so keep the process.
		try {
			const tool = toolProbe(ctx);
			const grace = tool ? (deps.toolIdleMs ?? tool.idleSec * 1000) : idleMs;
			if (Date.now() - lastActivity < grace) {
				arm(ctx, false);
				return;
			}
			if ((!tool && ctx.isIdle?.() === false) || ctx.hasPendingMessages?.() === true) return keep("busy");
			// A host that cannot say reports work present, so an absent method must also keep the process.
			if (backgroundWork(ctx) !== false) return keep("background");
			if (activeGoal(ctx)) return keep("goal");
			if ((ctx.ui?.getEditorText?.() ?? "").trim() !== "") return keep("draft");
			const manager = ctx.sessionManager;
			const session = manager?.getSessionId?.();
			if (!session) return keep("no_session_id");
			const store = manager?.getSessionFile?.() ?? session;
			// The shell passes the id to `omp --resume` and reads the marker line by line.
			if (!/^[\w.-]+$/.test(session) || /[\r\n]/.test(store)) return keep("unsafe_name");
			parking = true;
			try {
				await manager?.flush?.();
				await manager?.ensureOnDisk?.();
			} catch (error) {
				parking = false;
				return keep("flush_failed", String(error));
			}
			try {
				if (
					Date.now() - lastActivity < grace ||
					ctx.hasPendingMessages?.() === true ||
					backgroundWork(ctx) !== false ||
					activeGoal(ctx) ||
					(ctx.ui?.getEditorText?.() ?? "").trim() !== ""
				) {
					parking = false;
					return keep("busy");
				}
				fs.writeFileSync(markerPath, tool ? `${session}\ntool ${tool.toolCallId}\n` : `${session}\n`);
				if (tool && ctx.parkTool?.(tool.toolCallId) !== true) {
					fs.rmSync(markerPath, { force: true });
					parking = false;
					return keep("busy");
				}
			} catch (error) {
				parking = false;
				return keep("marker_failed", error instanceof Error ? error.message : String(error));
			}
			emit({ event: "parked", session });
			// Supported exit: the host's graceful shutdown. Never process.exit or a signal.
			ctx.shutdown?.();
		} catch (error) {
			parking = false;
			keep("probe_failed", error instanceof Error ? error.message : String(error));
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const context = ctx as unknown as TerminalParkContext;
		if (context.hasUI !== true) return;
		// Every keystroke is activity, including typing a draft that never reaches an `input` event.
		unsubscribeInput?.();
		unsubscribeInput = context.ui?.onTerminalInput?.(() => {
			lastActivity = Date.now();
			if (!parking) arm(context);
			return undefined;
		});
		arm(context);
	});
	pi.on("agent_end", (event, ctx) => {
		if ("willContinue" in event && event.willContinue) return;
		const context = ctx as unknown as TerminalParkContext;
		if (context.hasUI === true) arm(context);
	});
	/** `unknown` parameters keep one handler assignable to every activity event without weakening the guard. */
	const armOnActivity = (_event: unknown, ctx: unknown): void => {
		const context = ctx as unknown as TerminalParkContext;
		if (context.hasUI === true && !parking) arm(context);
	};
	pi.on("input", armOnActivity);
	pi.on("before_agent_start", armOnActivity);
	pi.on("agent_start", armOnActivity);
	pi.on("tool_execution_start", armOnActivity);
	pi.on("session_shutdown", () => {
		clearTimeout(timer);
		timer = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
	});
}

export default function terminalPark(pi: ExtensionAPI): void {
	// The idle check re-runs at least every 20s, so a standing failure prints once, not once per check.
	let lastComplaint = "";
	registerTerminalPark(pi, {
		onEvent: event => {
			if (event.event !== "kept" || ["busy", "background", "draft"].includes(event.reason)) return;
			const line = `terminal-park: kept the process (${event.reason}${event.detail ? `: ${event.detail}` : ""})`;
			if (line === lastComplaint) return;
			lastComplaint = line;
			console.error(line);
		},
	});
}
