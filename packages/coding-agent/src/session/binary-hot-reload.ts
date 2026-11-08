/**
 * Idle reload of the omp binary inside herdr or tmux.
 *
 * {@link decideBinaryReload} is the compare: the running executable against the
 * executable `$which("omp")` would launch now. {@link BinaryHotReloadWatcher}
 * polls that compare only while the session is idle; a change mid-turn is
 * deferred until the turn ends.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$which,
	isCompiledBinary,
	isExecutable,
	stripWindowsExtendedLengthPathPrefix,
	WhichCachePolicy,
} from "@oh-my-pi/pi-utils";
import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { readRemoteLatestOmp, resolveOmpRemoteTarget } from "./omp-remote-target";

/** How often an idle session asks what `$which("omp")` would launch. */
export const BINARY_HOT_RELOAD_POLL_MS = 2_000;

export interface BinaryReloadFacts {
	/** `realpath` of `process.execPath`. */
	runningPath: string;
	/** Executable `$which("omp")` would launch, when one can be named. */
	launchPath: string | undefined;
	launchExecutable: boolean;
	/** True only inside herdr or tmux. A plain terminal never auto-restarts. */
	inMultiplexer: boolean;
	/** `session.hotReloadBinary`. Default on; the multiplexer gate still applies. */
	enabled: boolean;
}

export type BinaryReloadDecision = "relaunch" | "stay";

/**
 * Relaunch only when a newer executable is on PATH, the session is inside
 * herdr or tmux, and hot reload is enabled. A matching path, a missing or
 * non-executable launch path, a plain terminal, or a disabled setting stays.
 */
export function decideBinaryReload(facts: BinaryReloadFacts): BinaryReloadDecision {
	if (!facts.enabled || !facts.inMultiplexer) return "stay";
	if (!facts.launchPath || !facts.launchExecutable) return "stay";
	if (facts.runningPath === facts.launchPath) return "stay";
	return "relaunch";
}

/** True when herdr or tmux owns this session. Other multiplexers do not auto-restart. */
export function inHerdrOrTmuxSession(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return hasTerminalMultiplexerSession("herdr", env) || hasTerminalMultiplexerSession("tmux", env);
}

/**
 * Auto-reload only for a compiled binary inside herdr or tmux, with the
 * setting on. A bun dev session's execPath is bun, which always differs from
 * `$which("omp")`; watching it would restart off the dev session every idle poll.
 */
export function shouldWatchBinaryReload(enabled: boolean, env: NodeJS.ProcessEnv = Bun.env): boolean {
	return enabled && isCompiledBinary() && inHerdrOrTmuxSession(env);
}

function commandName(filePath: string): string {
	const base = path.basename(filePath);
	return base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
}

/**
 * The executable a `$which` hit would launch, after `realpath` on both sides.
 *
 * A PATH entry whose realpath is still named `omp` launches that file. A mise
 * shim realpaths to the `mise` binary, not the install; `miseInstall` is what
 * `mise which omp` names. Without that install path the shim is not a launch
 * target — exec'ing the mise binary would not be omp, and comparing it to
 * `process.execPath` would differ on every poll.
 */
export function executableWhichWouldLaunch(
	whichPath: string,
	resolvedPath: string,
	miseInstall?: string,
): string | undefined {
	if (commandName(resolvedPath) === commandName(whichPath)) return resolvedPath;
	if (commandName(resolvedPath) !== "mise" || !miseInstall) return undefined;
	return miseInstall;
}

function realpathOr(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

/** `$which("omp")` with the cache bypassed, when that PATH entry is executable. */
export function resolveWhichOmp(): string | undefined {
	const whichPath = $which("omp", { requireAbsolutePaths: true, cache: WhichCachePolicy.Bypass });
	if (!whichPath || !isExecutable(whichPath)) return undefined;
	return whichPath;
}

/**
 * Symlink mise writes for the current omp install. The PATH shim stays a
 * symlink to the mise binary; this file is the binary that shim launches.
 */
export function miseLatestOmpPath(home: string): string {
	return path.join(home, ".local", "share", "mise", "installs", "github-zachbornheimer-oh-my-pi", "build-latest", "omp");
}

/**
 * `realpath` of {@link miseLatestOmpPath}. Undefined when the symlink is
 * missing or the target is not executable — then do not reload.
 */
export function readMiseLatestOmp(
	home: string = os.homedir(),
	realpath: (filePath: string) => string = fs.realpathSync,
	executable: (filePath: string) => boolean = isExecutable,
): string | undefined {
	try {
		const resolved = realpath(miseLatestOmpPath(home));
		return executable(resolved) ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `realpath` of `$which("omp")`, cache bypassed. A mise shim is resolved to
 * `build-latest/omp`. Undefined when omp is not on PATH, that symlink is
 * missing, or the resolved file is not executable.
 */
export function resolveLiveOmpExecutable(env: NodeJS.ProcessEnv = Bun.env): string | undefined {
	const remote = resolveOmpRemoteTarget(env);
	if (remote) return readRemoteLatestOmp(remote.host);
	const whichPath = resolveWhichOmp();
	if (!whichPath) return undefined;
	const resolved = realpathOr(whichPath);
	const miseInstall = commandName(resolved) === "mise" ? readMiseLatestOmp() : undefined;
	const launched = executableWhichWouldLaunch(whichPath, resolved, miseInstall);
	if (!launched || !isExecutable(launched)) return undefined;
	return launched;
}

/** `realpath` of the running executable, or the path itself when it is already gone. */
export function runningExecutablePath(execPath: string = process.execPath): string {
	return realpathOr(stripWindowsExtendedLengthPathPrefix(execPath));
}

/**
 * Live omp path for `/restart`, or undefined when this process is not a
 * compiled binary. A bun dev session must keep relaunching bun.
 *
 * Prefers `build-latest/omp` when the PATH entry realpaths to the mise binary,
 * otherwise `realpath($which("omp"))`. Falls back to the PATH entry itself
 * when that symlink is missing.
 */
export function restartLiveExecutable(): string | undefined {
	if (!isCompiledBinary()) return undefined;
	return resolveLiveOmpExecutable() ?? resolveWhichOmp();
}

/** Facts for one poll. Only a compiled binary is compared; a bun dev session must not jump to the install. */
export function readBinaryReloadFacts(
	env: NodeJS.ProcessEnv = Bun.env,
	enabled = true,
): BinaryReloadFacts {
	const launchPath = isCompiledBinary() ? resolveLiveOmpExecutable(env) : undefined;
	return {
		runningPath: runningExecutablePath(),
		launchPath,
		launchExecutable: launchPath !== undefined,
		inMultiplexer: inHerdrOrTmuxSession(env),
		enabled,
	};
}

export interface BinaryHotReloadOptions {
	observe: () => BinaryReloadFacts | Promise<BinaryReloadFacts>;
	isBusy: () => boolean;
	onIdle: (listener: () => void) => () => void;
	restart: () => Promise<void>;
	notify: (level: "info" | "error", message: string) => void;
	pollIntervalMs?: number;
}

/** Polls the live omp path and restarts once the session is idle. */
export class BinaryHotReloadWatcher {
	readonly #options: BinaryHotReloadOptions;
	#active = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	#unsubscribeIdle: (() => void) | undefined;
	#pending = false;
	#deferralAnnounced = false;
	#working: Promise<void> = Promise.resolve();

	constructor(options: BinaryHotReloadOptions) {
		this.#options = options;
	}

	/** Begins polling. A no-op when already started. */
	start(): Promise<void> {
		if (this.#active) return Promise.resolve();
		this.#active = true;
		this.#timer = setInterval(() => void this.poll(), this.#options.pollIntervalMs ?? BINARY_HOT_RELOAD_POLL_MS);
		this.#timer.unref?.();
		this.#unsubscribeIdle = this.#options.onIdle(() => void this.#serialized(() => this.#flush()));
		return this.poll();
	}

	stop(): void {
		this.#active = false;
		this.#pending = false;
		this.#deferralAnnounced = false;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#unsubscribeIdle?.();
		this.#unsubscribeIdle = undefined;
	}

	/** One poll: notice a newer binary, then restart if the session is idle. */
	poll(): Promise<void> {
		return this.#serialized(async () => {
			if (!this.#active) return;
			const facts = await this.#options.observe();
			this.#pending = decideBinaryReload(facts) === "relaunch";
			if (!this.#pending) this.#deferralAnnounced = false;
			await this.#flush();
		});
	}

	#serialized(work: () => Promise<void>): Promise<void> {
		const next = this.#working.then(work, work);
		this.#working = next.catch(() => {});
		return next;
	}

	async #flush(): Promise<void> {
		if (!this.#active || !this.#pending) return;
		if (this.#options.isBusy()) {
			if (!this.#deferralAnnounced) {
				this.#deferralAnnounced = true;
				this.#options.notify("info", "a newer omp is on PATH; restart deferred until the current turn ends");
			}
			return;
		}
		this.#pending = false;
		this.#deferralAnnounced = false;
		// exec replaces this process. Stop first so a poll during teardown cannot restart again.
		this.stop();
		try {
			await this.#options.restart();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#options.notify("error", `omp binary reload failed: ${reason}`);
		}
	}
}
