import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";

const SUSPENSION_FILE_NAME = "provider-suspensions.json";
const BILLING_MODEL = "*";
const FILE_VERSION = 1;
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const EARLIEST_SUPPORTED_EPOCH_SECONDS = 1_000_000_000;
const EARLIEST_SUPPORTED_EPOCH_MILLISECONDS = 1_000_000_000_000;
const MAX_ERROR_DEPTH = 12;
const MAX_ERROR_NODES = 512;

type ProviderErrorClassification =
	| { kind: "billing"; untilMs: null }
	| { kind: "usage-limit"; untilMs: number }
	| { kind: "other"; untilMs: null };
type StoredSuspension = {
	provider: string;
	credentialHash: string;
	model: string;
	untilMs: number | null;
};
type SuspensionFile = { version: 1; records: Record<string, StoredSuspension> };

const BILLING_CODES = new Set([
	"billing_error",
	"billing_hard_limit_reached",
	"billing_limit_reached",
	"budget_limit_exceeded",
	"credit_balance_exhausted",
	"credits_exhausted",
	"enforced_spend_limit_reached",
	"insufficient_credits",
	"insufficient_quota",
	"key_budget_exceeded",
	"key_limit_exceeded",
	"key_quota_exceeded",
	"monthly_budget_exceeded",
	"quota_exceeded",
	"quota_limit_exceeded",
	"spend_limit_exceeded",
	"spend_limit_reached",
	"usage_limit_reached",
]);

/** Classify provider response evidence without changing retry policy. */
export function classifyProviderError(
	status: number,
	headers: Headers | Record<string, string | undefined> | null | undefined,
	body: unknown,
): ProviderErrorClassification {
	if (status >= 200 && status < 300) return { kind: "other", untilMs: null };

	const now = Date.now();
	const evidence = collectErrorEvidence(body);
	const resetAtMs = Math.max(0, ...evidence.resetTimestamps);
	const normalized = evidence.text
		.join(" ")
		.toLowerCase()
		.replace(/[\s_-]+/g, " ");
	const openRouterLimit = isOpenRouterLimitError(normalized, evidence.text);
	if (hasBillingError(evidence.text, normalized) && !(resetAtMs > 0 && openRouterLimit)) {
		return { kind: "billing", untilMs: null };
	}

	const retryAfterMs = getRetryAfterUntilMs(headers, now);
	const hintedDelayMs = parseRetryHintMs(normalized);
	if (retryAfterMs !== undefined || resetAtMs > 0 || hintedDelayMs !== undefined) {
		return {
			kind: "usage-limit",
			untilMs: Math.max(
				now,
				retryAfterMs ?? now,
				resetAtMs,
				hintedDelayMs === undefined ? now : now + hintedDelayMs,
			),
		};
	}

	return { kind: "other", untilMs: null };
}

/** Durable provider suspension state shared by turns and one-shot processes. */
export class SuspensionRegistry {
	readonly #directory: string;
	readonly #filePath: string;

	constructor(directory = getAgentDir()) {
		this.#directory = directory;
		this.#filePath = path.join(directory, SUSPENSION_FILE_NAME);
	}

	/** Persist billing failures for the credential, timed limits for one model. */
	async recordFailure(
		provider: string,
		credential: string,
		model: string,
		classification: ProviderErrorClassification,
	): Promise<void> {
		if (classification.kind === "other") return;
		const credentialHash = hashCredential(credential);
		const suspendedModel = classification.kind === "billing" ? BILLING_MODEL : model;
		const untilMs = classification.kind === "billing" ? null : classification.untilMs;
		await this.#withRecords(Date.now(), records => {
			records[recordKey(provider, credentialHash, suspendedModel)] = {
				provider,
				credentialHash,
				model: suspendedModel,
				untilMs,
			};
			return { result: undefined, changed: true };
		});
	}

	/** Check credential-wide billing state before model-specific timed limits. */
	async isSuspended(provider: string, credential: string, model: string, now: number): Promise<boolean> {
		const credentialHash = hashCredential(credential);
		return this.#withRecords(now, records => {
			const credentialSuspension = records[recordKey(provider, credentialHash, BILLING_MODEL)];
			if (credentialSuspension) return { result: true, changed: false };
			return { result: records[recordKey(provider, credentialHash, model)] !== undefined, changed: false };
		});
	}

	/** A successful response clears this model and any credential-wide billing block. */
	async recordSuccess(provider: string, credential: string, model: string): Promise<void> {
		const credentialHash = hashCredential(credential);
		await this.#withRecords(Date.now(), records => {
			const keys = [recordKey(provider, credentialHash, BILLING_MODEL), recordKey(provider, credentialHash, model)];
			let changed = false;
			for (const key of keys) changed = delete records[key] || changed;
			return { result: undefined, changed };
		});
	}

	async #withRecords<T>(
		now: number,
		operation: (records: Record<string, StoredSuspension>) => { result: T; changed: boolean },
	): Promise<T> {
		await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
		return withFileLock(this.#filePath, async () => {
			const records = await readSuspensions(this.#filePath);
			let changed = false;
			for (const [key, suspension] of Object.entries(records)) {
				if (suspension.untilMs !== null && suspension.untilMs <= now) {
					delete records[key];
					changed = true;
				}
			}
			const outcome = operation(records);
			if (changed || outcome.changed) await writeSuspensionsAtomically(this.#filePath, records);
			return outcome.result;
		});
	}
}

function collectErrorEvidence(body: unknown): { text: string[]; resetTimestamps: number[] } {
	const text: string[] = [];
	const resetTimestamps: number[] = [];
	const visited = new WeakSet<object>();
	let visitedNodes = 0;

	function visit(value: unknown, key = "", depth = 0): void {
		if (depth > MAX_ERROR_DEPTH || visitedNodes++ >= MAX_ERROR_NODES || value === null || value === undefined) return;
		if (typeof value === "string") {
			text.push(value);
			if (key.toLowerCase() === "resets_at" || key.toLowerCase() === "reset_at") {
				const timestamp = parseTimestamp(value);
				if (timestamp !== undefined) resetTimestamps.push(timestamp);
			}
			return;
		}
		if (typeof value === "number") {
			if (key.toLowerCase() === "resets_at" || key.toLowerCase() === "reset_at") {
				const timestamp = parseTimestamp(value);
				if (timestamp !== undefined) resetTimestamps.push(timestamp);
			}
			return;
		}
		if (typeof value !== "object" || visited.has(value)) return;
		visited.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child, key, depth + 1);
			return;
		}
		for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
	}

	if (typeof body === "string") {
		text.push(body);
		try {
			visit(JSON.parse(body));
		} catch {
			// Provider bodies are often plain text rather than JSON.
		}
	} else {
		visit(body);
	}
	return { text, resetTimestamps };
}

function parseTimestamp(value: string | number): number | undefined {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return undefined;
		const timestamp =
			value >= EARLIEST_SUPPORTED_EPOCH_MILLISECONDS
				? value
				: value >= EARLIEST_SUPPORTED_EPOCH_SECONDS
					? value * MILLISECONDS_PER_SECOND
					: undefined;
		return timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return parseTimestamp(Number(trimmed));
	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function hasBillingError(text: string[], normalized: string): boolean {
	for (const entry of text) {
		const tokens = entry.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
		if (tokens.some(token => BILLING_CODES.has(token))) return true;
	}
	return (
		/\b(?:billing|spend|quota|credit balance|credit|budget|key) (?:hard )?(?:limit|exhausted|exceeded|reached|insufficient)\b/.test(
			normalized,
		) ||
		/\b(?:insufficient quota|insufficient credits|credit balance exhausted|exceeded (?:your )?(?:current )?quota)\b/.test(
			normalized,
		)
	);
}

function isOpenRouterLimitError(normalized: string, text: string[]): boolean {
	if (
		/\b(?:key|budget) (?:limit|exhausted|exceeded|reached|insufficient)\b/.test(normalized) ||
		/\b(?:insufficient credits|credits exhausted)\b/.test(normalized)
	) {
		return true;
	}
	return text.some(entry => {
		const tokens = entry.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
		return tokens.some(
			token =>
				/^(?:key|budget|credit(?!_balance_)s?).*(?:limit|exhaust|exceed|reach|insufficient)$/.test(token) ||
				token === "insufficient_credits",
		);
	});
}

function parseRetryHintMs(normalized: string): number | undefined {
	const match = /\btry again in\s+~?\s*(?:about\s+)?(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/.exec(
		normalized,
	);
	if (!match) return undefined;
	const minutes = Number(match[1]);
	return Number.isFinite(minutes) ? Math.ceil(minutes * MILLISECONDS_PER_MINUTE) : undefined;
}

function getRetryAfterUntilMs(
	headers: Headers | Record<string, string | undefined> | null | undefined,
	now: number,
): number | undefined {
	if (!headers) return undefined;
	let value: string | undefined;
	if (headers instanceof Headers) {
		value = headers.get("retry-after") ?? undefined;
	} else {
		const key = Object.keys(headers).find(header => header.toLowerCase() === "retry-after");
		if (key) value = headers[key];
	}
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	const seconds = Number(trimmed);
	if (trimmed && Number.isFinite(seconds)) return now + Math.max(0, seconds * MILLISECONDS_PER_SECOND);
	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? Math.max(now, timestamp) : now;
}

function hashCredential(credential: string): string {
	return createHash("sha256").update(credential).digest("hex");
}

function recordKey(provider: string, credentialHash: string, model: string): string {
	return createHash("sha256")
		.update(JSON.stringify([provider, credentialHash, model]))
		.digest("hex");
}

async function readSuspensions(filePath: string): Promise<Record<string, StoredSuspension>> {
	let contents: string;
	try {
		contents = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Invalid provider suspension file ${filePath}`, { cause: error });
	}
	if (!isSuspensionFile(parsed)) throw new Error(`Invalid provider suspension file ${filePath}`);
	return parsed.records;
}

function isSuspensionFile(value: unknown): value is SuspensionFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const file = value as Record<string, unknown>;
	if (
		file.version !== FILE_VERSION ||
		!file.records ||
		typeof file.records !== "object" ||
		Array.isArray(file.records)
	) {
		return false;
	}
	return Object.entries(file.records).every(([key, raw]) => {
		if (!/^[a-f0-9]{64}$/.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const record = raw as Record<string, unknown>;
		return (
			typeof record.provider === "string" &&
			typeof record.credentialHash === "string" &&
			/^[a-f0-9]{64}$/.test(record.credentialHash) &&
			typeof record.model === "string" &&
			(record.untilMs === null || (typeof record.untilMs === "number" && Number.isFinite(record.untilMs)))
		);
	});
}

async function writeSuspensionsAtomically(filePath: string, records: Record<string, StoredSuspension>): Promise<void> {
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	const payload: SuspensionFile = { version: FILE_VERSION, records };
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await fs.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}
