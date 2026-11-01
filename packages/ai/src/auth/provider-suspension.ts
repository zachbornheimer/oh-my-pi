/**
 * One shared durable suspension record for LLM providers, keyed by provider +
 * credential id + model, written from the classified response body of a failed
 * call and read by model selection and every fallback chain before the HTTP
 * call so a suspended key is skipped instead of re-hit.
 *
 * Two classes come out of the body classifier ({@link classifyProviderSuspension}):
 *
 * - **billing** — OpenAI billing/spend/quota codes (including
 *   `credit_balance_exhausted` on a 429), Anthropic `billing_error` /
 *   `enforced_spend_limit_reached`, OpenRouter key/credit/budget limits. The
 *   key stays suspended until the body's `resets_at`, or until the credential
 *   id or the recorded credit/budget generation changes.
 * - **usage-limit** — suspends only that key until the provider-stated
 *   `Retry-After` or a parsed "try again in N". The delay is a minimum: the
 *   record never shortens it, and it is not extended to session end.
 *
 * An unrecognized 402/403 classifies as nothing and is never recorded, so it
 * stays retryable and no ban is written.
 *
 * Durability is a JSON file under the agent directory, shared by every process
 * that places LLM calls (chat turn, sub-agent, one-shot jobs) — never a
 * process-local map. Writes are atomic (temp file + rename) and
 * last-write-wins across processes, which is acceptable for a best-effort
 * skip: the next observed failure re-records the suspension.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { extractRetryHint } from "@oh-my-pi/pi-utils/fetch-retry";
import {
	isAccountScopedCapText,
	isBillingSuspensionBody,
	matchesUsageLimitText,
	parseSuspensionGeneration,
	parseSuspensionResetsAtMs,
} from "../error/rate-limit";

/** What kind of suspension the response body classified into. */
export type SuspensionKind = "billing" | "usage-limit";

/** One durable suspension record. */
export interface ProviderSuspension {
	provider: string;
	/** Model id the request targeted; suspension applies per model. */
	modelId: string;
	/**
	 * Durable credential row id when the failing bearer resolved to one, else
	 * `""` when the writer had no credential context. `""` records apply to
	 * every credential of the provider+model until they expire or clear.
	 */
	credentialId: string;
	kind: SuspensionKind;
	/** Suspension class reported by skip logs and reads: `billing` or `usage-limit`. */
	reasonClass: SuspensionKind;
	/** Earliest epoch ms the key is eligible again. A minimum, never extended. */
	untilMs: number;
	/** Recorded credit/budget generation, when the body carried one. */
	generation?: string;
	recordedAtMs: number;
}

export interface ClassifiedSuspension {
	kind: SuspensionKind;
	reasonClass: SuspensionKind;
	/** The body's own reset time for a billing suspension, when stated. */
	resetsAtMs?: number;
	/** Credit/budget generation the body recorded, when stated. */
	generation?: string;
	/** Provider-stated delay for a usage-limit suspension. */
	retryAfterMs?: number;
}

export interface SuspensionQuery {
	provider: string;
	/** Omit to match any model of the provider. */
	modelId?: string;
	/** The credential about to be used; omit to match any recorded credential. */
	credentialId?: string;
	/** Current credit/budget generation, when the caller has observed one. */
	generation?: string;
	nowMs?: number;
}

/**
 * Classify a failed response body into the suspension it warrants. Returns
 * `undefined` for anything else — notably an unrecognized 402/403, which stays
 * retryable and must never be recorded as a ban.
 *
 * A usage limit is recorded only when the body or headers state a delay
 * (`Retry-After`, "try again in N"): the record holds that stated minimum and
 * never a fixed heuristic cooldown.
 */
export function classifyProviderSuspension(
	message: string | undefined,
	status?: number,
): ClassifiedSuspension | undefined {
	if (!message) return undefined;
	if (isBillingSuspensionBody(message, status)) {
		return {
			kind: "billing",
			reasonClass: "billing",
			resetsAtMs: parseSuspensionResetsAtMs(message),
			generation: parseSuspensionGeneration(message),
		};
	}
	if (matchesUsageLimitText(message) || (status === 403 && isAccountScopedCapText(message))) {
		const retryAfterMs = extractRetryHint(undefined, message);
		if (retryAfterMs !== undefined && retryAfterMs > 0) {
			return { kind: "usage-limit", reasonClass: "usage-limit", retryAfterMs };
		}
	}
	return undefined;
}

const STORE_VERSION = 1;
/**
 * Safety valve: a billing suspension whose body stated no reset cannot outlive
 * a plausible top-up cycle. Credit or generation changes clear it earlier.
 */
const MAX_BILLING_SUSPENSION_MS = 7 * 24 * 60 * 60 * 1000;

interface StoreFile {
	version: number;
	records: Record<string, ProviderSuspension>;
}

/** Composite record key: provider, model id, credential id. */
export function suspensionRecordKey(provider: string, modelId: string, credentialId: string): string {
	return `${provider}\u0000${modelId}\u0000${credentialId}`;
}

/**
 * Builds the durable record a writer stores for a classified failure. A
 * billing suspension ends at the body's `resets_at` (or the cap below when the
 * body stated none); a usage-limit suspension ends at `nowMs + retryAfterMs`.
 */
export function suspensionFromClassification(args: {
	provider: string;
	modelId: string;
	credentialId: string;
	classified: ClassifiedSuspension;
	nowMs?: number;
}): ProviderSuspension {
	const nowMs = args.nowMs ?? Date.now();
	if (args.classified.kind === "billing") {
		const untilMs = args.classified.resetsAtMs ?? nowMs + MAX_BILLING_SUSPENSION_MS;
		return {
			provider: args.provider,
			modelId: args.modelId,
			credentialId: args.credentialId,
			kind: "billing",
			reasonClass: "billing",
			untilMs,
			...(args.classified.generation === undefined ? {} : { generation: args.classified.generation }),
			recordedAtMs: nowMs,
		};
	}
	return {
		provider: args.provider,
		modelId: args.modelId,
		credentialId: args.credentialId,
		kind: "usage-limit",
		reasonClass: "usage-limit",
		untilMs: nowMs + Math.max(0, args.classified.retryAfterMs ?? 0),
		recordedAtMs: nowMs,
	};
}

/** Durable provider-suspension record store backed by one JSON file. */
export class ProviderSuspensionStore {
	readonly #path: string;
	#cache: Record<string, ProviderSuspension> = {};
	#cacheMtimeMs: number | undefined;
	#loaded = false;

	constructor(filePath: string) {
		this.#path = filePath;
	}

	get filePath(): string {
		return this.#path;
	}

	#read(): Record<string, ProviderSuspension> {
		if (this.#loaded) {
			try {
				const stat = fs.statSync(this.#path);
				if (stat.mtimeMs === this.#cacheMtimeMs) return this.#cache;
				this.#cacheMtimeMs = stat.mtimeMs;
			} catch {
				// No file yet (or unreadable): keep what this process knows.
				return this.#cache;
			}
		}
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#path, "utf8")) as StoreFile | null;
			this.#cache =
				parsed?.version === STORE_VERSION && parsed.records && typeof parsed.records === "object"
					? (parsed.records as Record<string, ProviderSuspension>)
					: {};
			this.#loaded = true;
			try {
				this.#cacheMtimeMs = fs.statSync(this.#path).mtimeMs;
			} catch {
				// File vanished between read and stat; next read reloads.
			}
		} catch {
			// Missing or damaged store: an empty record set, never a thrown error.
			this.#cache = {};
			this.#loaded = true;
		}
		return this.#cache;
	}

	#write(): void {
		fs.mkdirSync(path.dirname(this.#path), { recursive: true });
		const tmp = `${this.#path}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, records: this.#cache } satisfies StoreFile));
		fs.renameSync(tmp, this.#path);
		try {
			this.#cacheMtimeMs = fs.statSync(this.#path).mtimeMs;
		} catch {
			// Renamed away underneath us; the next read reloads from disk.
		}
	}

	/**
	 * Upsert one suspension record. A repeated usage-limit classification keeps
	 * the longest stated minimum; a billing record replaces the old one, so a
	 * newer body's reset time or credit generation is authoritative.
	 */
	record(suspension: ProviderSuspension): void {
		const records = this.#read();
		const nowMs = Date.now();
		for (const [key, record] of Object.entries(records)) {
			if (record.untilMs <= nowMs) delete records[key];
		}
		const key = suspensionRecordKey(suspension.provider, suspension.modelId, suspension.credentialId);
		const existing = records[key];
		if (existing?.kind === "usage-limit" && suspension.kind === "usage-limit") {
			records[key] = { ...suspension, untilMs: Math.max(existing.untilMs, suspension.untilMs) };
		} else {
			records[key] = suspension;
		}
		this.#write();
	}

	/**
	 * The live suspension for this provider (+ model, + credential when known),
	 * or `undefined` when the key is eligible. Clearing rules for billing:
	 * a different credential id, or a caller-observed generation differing
	 * from the recorded one, ends the suspension. A usage limit applies only
	 * to the recorded key and only until its stated minimum.
	 */
	active(query: SuspensionQuery): ProviderSuspension | undefined {
		const nowMs = query.nowMs ?? Date.now();
		for (const record of Object.values(this.#read())) {
			if (record.provider !== query.provider) continue;
			if (query.modelId !== undefined && record.modelId !== query.modelId) continue;
			if (nowMs >= record.untilMs) continue;
			if (
				query.credentialId !== undefined &&
				record.credentialId !== "" &&
				query.credentialId !== record.credentialId
			) {
				continue;
			}
			if (
				record.kind === "billing" &&
				query.generation !== undefined &&
				record.generation !== undefined &&
				query.generation !== record.generation
			) {
				continue;
			}
			return record;
		}
		return undefined;
	}
}

let overrideStore: ProviderSuspensionStore | undefined;
let defaultStore: ProviderSuspensionStore | undefined;

/**
 * Where the shared store lives. Production resolves next to the agent
 * directory so every omp process (chat turn, sub-agent, one-shot jobs) reads
 * and writes the same record; under bun test it resolves inside a per-process
 * temp file so suites exercising the writers never touch a real agent
 * directory.
 */
function defaultStorePath(): string {
	if (isBunTestRuntime()) return path.join(os.tmpdir(), `omp-provider-suspensions-${process.pid}.json`);
	return path.join(getAgentDir(), "provider-suspensions.json");
}

/** The process-wide suspension store, shared by every caller in this process. */
export function providerSuspensionStore(): ProviderSuspensionStore {
	if (overrideStore) return overrideStore;
	defaultStore ??= new ProviderSuspensionStore(defaultStorePath());
	return defaultStore;
}

/** Test seam: route all record/query traffic through an explicit store, or back to the default. */
export function setProviderSuspensionStoreForTests(store: ProviderSuspensionStore | undefined): void {
	overrideStore = store;
}

export function recordProviderSuspension(suspension: ProviderSuspension): void {
	providerSuspensionStore().record(suspension);
}

export function activeProviderSuspension(query: SuspensionQuery): ProviderSuspension | undefined {
	return providerSuspensionStore().active(query);
}

/**
 * The skip log. Call it on the same path that records a failed chat call, so
 * every skipped request says why the key was not called: provider, credential
 * id, model, reason class, and until.
 */
export function logSuspensionSkip(context: string, suspension: ProviderSuspension): void {
	logger.warn("provider suspended; skipping before request", {
		context,
		provider: suspension.provider,
		credentialId: suspension.credentialId,
		model: suspension.modelId,
		reasonClass: suspension.reasonClass,
		until: new Date(suspension.untilMs).toISOString(),
	});
}
