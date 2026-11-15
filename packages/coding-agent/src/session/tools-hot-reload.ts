/**
 * Live reload of custom tools and skills.
 *
 * {@link CustomToolsRefreshSummary} is what one custom-tool refresh changed and
 * {@link describeCustomToolsRefresh} is its user-visible report. {@link createToolsHotReloadSubsystem}
 * and {@link createSkillsHotReloadSubsystem} register custom tools and skills on a
 * {@link HotReloadCoordinator}.
 */
import { existsSync, type FSWatcher, type Stats, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { CustomToolsRefreshOptions } from "../extensibility/custom-tools/types";
import type { HotReloadSubsystem } from "./hot-reload";

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
	return {
		level: summary.errors.length > 0 ? "warning" : "info",
		message: lines.join("\n"),
	};
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

/** A full rescan this often backstops a watcher that dropped an event. */
export const SAFETY_RESCAN_MS = 300_000;

function isSkippedEvent(name: string | Buffer | null): boolean {
	if (typeof name !== "string") return false;
	return name.split(path.sep).some(part => SKIPPED_DIRECTORIES.has(part));
}

/**
 * {@link sourceSignature} for roots that are also watched for changes. While every existing root has a
 * live watcher and no event has arrived since the last scan, {@link quiescent} says a rescan would
 * find nothing, so a scheduled poll skips the walk instead of statting every file every tick.
 *
 * A root that does not exist costs one `existsSync` per tick, and its appearing is a change. A root
 * that exists but cannot be watched (no recursive watch on this platform) keeps the source from
 * ever being quiescent, which is the plain polling behaviour.
 */
export class WatchedSourceSignature {
	readonly #roots: () => readonly string[];
	readonly #safetyRescanMs: number;
	readonly #watchers = new Map<string, FSWatcher>();
	#key = "";
	#unwatchable = false;
	#dirty = true;
	#scannedAt = 0;

	constructor(roots: () => readonly string[], safetyRescanMs: number = SAFETY_RESCAN_MS) {
		this.#roots = roots;
		this.#safetyRescanMs = safetyRescanMs;
	}

	async signature(): Promise<string> {
		const roots = this.#roots();
		const key = roots.join("\0");
		// Reopening everything now and then also covers a root deleted and recreated in place.
		if (key !== this.#key || performance.now() - this.#scannedAt >= this.#safetyRescanMs) this.#closeWatchers();
		this.#key = key;
		this.#reconcile(roots);
		// Cleared before the scan, so an event that lands mid-scan keeps the next tick honest.
		this.#dirty = false;
		const signature = await sourceSignature(roots);
		this.#scannedAt = performance.now();
		return signature;
	}

	/** True when nothing watched has changed since the last {@link signature} call. */
	quiescent(): boolean {
		if (this.#dirty || this.#unwatchable) return false;
		if (performance.now() - this.#scannedAt >= this.#safetyRescanMs) return false;
		const roots = this.#roots();
		if (roots.join("\0") !== this.#key) return false;
		// A root that appeared, or one whose watcher outlived it, is a change no watcher reports.
		return roots.every(root => existsSync(root) === this.#watchers.has(root));
	}

	dispose(): void {
		this.#closeWatchers();
		this.#key = "";
		this.#unwatchable = false;
		this.#dirty = true;
	}

	#closeWatchers(): void {
		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
	}

	/** Opens a watcher for each existing root that lacks one, and closes those of roots that are gone. */
	#reconcile(roots: readonly string[]): void {
		for (const [root, watcher] of this.#watchers) {
			if (roots.includes(root) && existsSync(root)) continue;
			watcher.close();
			this.#watchers.delete(root);
		}
		this.#unwatchable = false;
		for (const root of roots) {
			if (this.#watchers.has(root) || !existsSync(root)) continue;
			try {
				const watcher = watch(root, { recursive: true }, (_event, name) => {
					if (!isSkippedEvent(name)) this.#dirty = true;
				});
				watcher.on("error", () => {
					this.#dirty = true;
					this.#watchers.delete(root);
				});
				watcher.unref();
				this.#watchers.set(root, watcher);
			} catch {
				this.#unwatchable = true;
			}
		}
	}
}

/** The `signature`, `quiescent` and `dispose` members of a subsystem that watches `roots`. */
export function watchedSignature(
	roots: () => readonly string[],
): Pick<HotReloadSubsystem, "signature" | "quiescent" | "dispose"> {
	const source = new WatchedSourceSignature(roots);
	return {
		signature: () => source.signature(),
		quiescent: () => source.quiescent(),
		dispose: () => source.dispose(),
	};
}

const TOOLS_AND_SKILLS_DEFERRAL_GROUP = "tools-and-skills";
const TOOLS_AND_SKILLS_DEFERRED_MESSAGE = "tool or skill files changed; reload deferred until the current turn ends";

export function createToolsHotReloadSubsystem(options: {
	roots: () => readonly string[];
	enabled?: () => boolean;
	reload: () => Promise<void>;
}): HotReloadSubsystem {
	return {
		id: "tools",
		source: "tools",
		deferralGroup: TOOLS_AND_SKILLS_DEFERRAL_GROUP,
		enabled: options.enabled,
		...watchedSignature(options.roots),
		reload: options.reload,
		deferredMessage: TOOLS_AND_SKILLS_DEFERRED_MESSAGE,
		errorPrefix: "tools hot reload failed",
	};
}

export function createSkillsHotReloadSubsystem(options: {
	roots: () => readonly string[];
	enabled?: () => boolean;
	reload: () => Promise<void>;
}): HotReloadSubsystem {
	return {
		id: "skills",
		source: "tools",
		deferralGroup: TOOLS_AND_SKILLS_DEFERRAL_GROUP,
		enabled: options.enabled,
		...watchedSignature(options.roots),
		reload: options.reload,
		deferredMessage: TOOLS_AND_SKILLS_DEFERRED_MESSAGE,
		errorPrefix: "skills hot reload failed",
	};
}
