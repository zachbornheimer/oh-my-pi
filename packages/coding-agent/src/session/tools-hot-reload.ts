/**
 * Live reload of custom tools and skills.
 *
 * {@link CustomToolsRefreshSummary} is what one custom-tool refresh changed and
 * {@link describeCustomToolsRefresh} is its user-visible report. {@link ToolsHotReloadWatcher}
 * (the opt-in `tools.hotReload` setting) polls the tool and skill source directories and applies
 * a refresh when they change, but only while the session is idle: a change that lands mid-turn
 * is announced as deferred and applied when the turn ends.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { CustomToolsRefreshOptions } from "../extensibility/custom-tools/types";

/** Names changed by one custom-tool refresh, plus the modules that could not be loaded. */
export interface CustomToolsRefreshSummary {
	added: string[];
	replaced: string[];
	removed: string[];
	errors: Array<{ path: string; error: string }>;
}

/** Re-reads the custom tool sources and applies the difference to the live session. */
export type CustomToolsRefresher = (options?: CustomToolsRefreshOptions) => Promise<CustomToolsRefreshSummary>;

export interface CustomToolsRefreshNotice {
	level: "info" | "warning";
	message: string;
}

/**
 * The status line for a refresh, e.g. `tools reloaded: +2 ~1 -0`, followed by one line per
 * failed module. `undefined` when nothing changed and nothing failed.
 */
export function describeCustomToolsRefresh(summary: CustomToolsRefreshSummary): CustomToolsRefreshNotice | undefined {
	const changed = summary.added.length + summary.replaced.length + summary.removed.length > 0;
	if (!changed && summary.errors.length === 0) return undefined;
	const counts = `+${summary.added.length} ~${summary.replaced.length} -${summary.removed.length}`;
	const failures = summary.errors.length > 0 ? `, ${summary.errors.length} failed` : "";
	const lines = [`tools ${changed ? "reloaded" : "unchanged"}: ${counts}${failures}`];
	for (const { path: modulePath, error } of summary.errors) lines.push(`  ${path.basename(modulePath)}: ${error}`);
	return { level: summary.errors.length > 0 ? "warning" : "info", message: lines.join("\n") };
}

const SIGNATURE_MAX_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

/** Appends `relative:mtime:size` for `entryPath` and, when it is a directory, everything under it. */
async function collectSignature(root: string, entryPath: string, depth: number, into: string[]): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(entryPath);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	into.push(`${path.relative(root, entryPath)}:${stat.mtimeMs}:${stat.size}`);
	if (!stat.isDirectory() || depth >= SIGNATURE_MAX_DEPTH) return;
	const names = await fs.readdir(entryPath);
	for (const name of names.sort()) {
		if (SKIPPED_DIRECTORIES.has(name)) continue;
		await collectSignature(root, path.join(entryPath, name), depth + 1, into);
	}
}

/**
 * A fingerprint of everything under `roots` (files, or directories down to a few levels) that
 * changes when any of it is added, edited, or removed. A missing or unreadable root counts as empty.
 */
export async function sourceSignature(roots: readonly string[]): Promise<string> {
	const parts: string[] = [];
	for (const root of roots) {
		parts.push(`@${root}`);
		try {
			await collectSignature(root, root, 0, parts);
		} catch {
			// Unreadable now; the signature changes when it becomes readable.
		}
	}
	return parts.join("\n");
}

export interface ToolsHotReloadOptions {
	/** Directories and files holding custom tool modules. */
	toolRoots: () => readonly string[];
	/** Directories holding skills. */
	skillRoots: () => readonly string[];
	/** Whether a turn is in flight. */
	isBusy: () => boolean;
	/** Subscribe to the session settling idle; returns the unsubscribe. */
	onIdle: (listener: () => void) => () => void;
	reloadTools: () => Promise<void>;
	reloadSkills: () => Promise<void>;
	notify: (level: "info" | "warning" | "error", message: string) => void;
	/** Poll period. Default 2000 ms. */
	pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Polls tool and skill sources and reloads whichever changed once the session is idle. */
export class ToolsHotReloadWatcher {
	readonly #options: ToolsHotReloadOptions;
	#active = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	#unsubscribeIdle: (() => void) | undefined;
	#toolsSignature = "";
	#skillsSignature = "";
	#toolsPending = false;
	#skillsPending = false;
	#deferralAnnounced = false;
	#working: Promise<void> = Promise.resolve();

	constructor(options: ToolsHotReloadOptions) {
		this.#options = options;
	}

	/** Records the current sources as the baseline, then begins polling. A no-op when already started. */
	async start(): Promise<void> {
		if (this.#active) return;
		this.#active = true;
		const toolsSignature = await sourceSignature(this.#options.toolRoots());
		const skillsSignature = await sourceSignature(this.#options.skillRoots());
		// Stopped while the baseline was being read.
		if (!this.#active) return;
		this.#toolsSignature = toolsSignature;
		this.#skillsSignature = skillsSignature;
		this.#timer = setInterval(() => void this.poll(), this.#options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		this.#timer.unref();
		this.#unsubscribeIdle = this.#options.onIdle(() => void this.#serialized(() => this.#flush()));
	}

	stop(): void {
		this.#active = false;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#unsubscribeIdle?.();
		this.#unsubscribeIdle = undefined;
	}

	/** One poll: notice what changed since the last one, then reload it if the session is idle. */
	poll(): Promise<void> {
		return this.#serialized(async () => {
			if (!this.#active) return;
			const tools = await sourceSignature(this.#options.toolRoots());
			if (tools !== this.#toolsSignature) {
				this.#toolsSignature = tools;
				this.#toolsPending = true;
			}
			const skills = await sourceSignature(this.#options.skillRoots());
			if (skills !== this.#skillsSignature) {
				this.#skillsSignature = skills;
				this.#skillsPending = true;
			}
			await this.#flush();
		});
	}

	#serialized(work: () => Promise<void>): Promise<void> {
		const next = this.#working.then(work, work);
		this.#working = next.catch(() => {});
		return next;
	}

	async #flush(): Promise<void> {
		if (!this.#active || (!this.#toolsPending && !this.#skillsPending)) return;
		if (this.#options.isBusy()) {
			if (!this.#deferralAnnounced) {
				this.#deferralAnnounced = true;
				this.#options.notify("info", "tool or skill files changed; reload deferred until the current turn ends");
			}
			return;
		}
		const reloadTools = this.#toolsPending;
		const reloadSkills = this.#skillsPending;
		this.#toolsPending = false;
		this.#skillsPending = false;
		this.#deferralAnnounced = false;
		if (reloadTools) await this.#reload("tools", this.#options.reloadTools);
		if (reloadSkills) await this.#reload("skills", this.#options.reloadSkills);
	}

	async #reload(what: "tools" | "skills", reload: () => Promise<void>): Promise<void> {
		try {
			await reload();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#options.notify("error", `${what} hot reload failed: ${reason}`);
		}
	}
}
