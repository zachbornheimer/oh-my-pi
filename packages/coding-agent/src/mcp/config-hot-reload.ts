/**
 * Polls MCP configuration files (`mcp.json`, `.mcp.json`, and discovered provider
 * configs) and reconciles added, updated, or removed MCP servers once the session
 * is idle.
 */
import * as fs from "node:fs/promises";

export const MCP_CONFIG_HOT_RELOAD_POLL_MS = 1_500;
const DIGEST_ALGORITHM = "blake2b256";

export interface McpConfigRefreshSummary {
	added: string[];
	updated: string[];
	removed: string[];
	errors: Array<{ serverName: string; error: string }>;
}

export interface McpConfigNotice {
	level: "info" | "warning";
	message: string;
}

/**
 * Formats a concise notice for what an MCP config refresh changed. Returns
 * `undefined` when nothing changed and no server failed to connect.
 */
export function describeMcpConfigRefresh(summary: McpConfigRefreshSummary): McpConfigNotice | undefined {
	const changed = summary.added.length + summary.updated.length + summary.removed.length > 0;
	if (!changed && summary.errors.length === 0) return undefined;

	const counts = `+${summary.added.length} ~${summary.updated.length} -${summary.removed.length}`;
	const head = changed ? `mcp config reloaded: ${counts}` : `mcp config unchanged: ${counts}`;
	if (summary.errors.length === 0) {
		return { level: "info", message: head };
	}

	const failureLines = summary.errors.map(({ serverName, error }) => `  ${serverName}: ${error}`);
	return {
		level: "warning",
		message: [`${head}, ${summary.errors.length} failed`, ...failureLines].join("\n"),
	};
}

async function fileDigest(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return undefined;
		const hasher = new Bun.CryptoHasher(DIGEST_ALGORITHM);
		for await (const chunk of Bun.file(filePath).stream()) {
			hasher.update(chunk);
		}
		return `${stat.size}:${hasher.digest("hex")}`;
	} catch {
		return undefined;
	}
}

/**
 * Deterministic content signature of the watched MCP configuration file paths.
 * Missing files record `missing` so creating or deleting a config file changes
 * the signature; touching a file without changing its contents keeps it stable.
 */
export async function mcpConfigSignature(paths: readonly string[]): Promise<string> {
	const unique = [...new Set(paths)].sort();
	const lines: string[] = [];
	for (const filePath of unique) {
		const digest = await fileDigest(filePath);
		lines.push(`${filePath}:${digest ?? "missing"}`);
	}
	return lines.join("\n");
}

export interface McpConfigHotReloadOptions {
	/** Config file paths to watch (existing or candidate). */
	paths: () => readonly string[];
	/** Whether a turn is in flight. */
	isBusy: () => boolean;
	/** Subscribe to the session settling idle; returns the unsubscribe callback. */
	onIdle: (listener: () => void) => () => void;
	/** Reconcile MCP servers and refresh the session's MCP tools. */
	reload: () => Promise<McpConfigRefreshSummary | void>;
	notify: (level: "info" | "warning" | "error", message: string) => void;
	/** Poll period. Default 1500 ms. */
	pollIntervalMs?: number;
}

/**
 * Polls MCP configuration files and reconciles connections once the session is idle.
 */
export class McpConfigHotReloadWatcher {
	readonly #options: McpConfigHotReloadOptions;
	#active = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	#unsubscribeIdle: (() => void) | undefined;
	#signature = "";
	#pending = false;
	#deferralAnnounced = false;
	#working: Promise<void> = Promise.resolve();

	constructor(options: McpConfigHotReloadOptions) {
		this.#options = options;
	}

	/** Records the current config files as the baseline, then begins polling. */
	async start(): Promise<void> {
		if (this.#active) return;
		this.#active = true;
		const signature = await mcpConfigSignature(this.#options.paths());
		if (!this.#active) return;
		this.#signature = signature;
		this.#timer = setInterval(() => void this.poll(), this.#options.pollIntervalMs ?? MCP_CONFIG_HOT_RELOAD_POLL_MS);
		this.#timer.unref?.();
		this.#unsubscribeIdle = this.#options.onIdle(() => void this.#serialized(() => this.#flush()));
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

	/** One poll: notice if any watched config file changed, then reload if idle. */
	poll(): Promise<void> {
		return this.#serialized(async () => {
			if (!this.#active) return;
			const next = await mcpConfigSignature(this.#options.paths());
			if (next !== this.#signature) {
				this.#signature = next;
				this.#pending = true;
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
		if (!this.#active || !this.#pending) return;
		if (this.#options.isBusy()) {
			if (!this.#deferralAnnounced) {
				this.#deferralAnnounced = true;
				this.#options.notify("info", "MCP config changed; reload deferred until the current turn ends");
			}
			return;
		}
		this.#pending = false;
		this.#deferralAnnounced = false;
		try {
			const summary = await this.#options.reload();
			if (summary) {
				const notice = describeMcpConfigRefresh(summary);
				if (notice) this.#options.notify(notice.level, notice.message);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#options.notify("error", `mcp config hot reload failed: ${reason}`);
		}
	}
}
