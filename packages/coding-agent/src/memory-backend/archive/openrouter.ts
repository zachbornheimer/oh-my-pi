/**
 * OpenRouter providers for the `archive` memory backend:
 *  - `openArchiveEmbedder`: 1536-dim vectors via `openai/text-embedding-3-small` (`/api/v1/embeddings`).
 *  - `openArchiveJevJudge`: calibrated [0, 1] relevance probabilities via `~typesafe/jev-latest` (`/api/v1/systemone`).
 *  - `openArchiveHaikuCombiner`: merges a chronological cluster of similar facts into one canonical
 *    fact via `anthropic/claude-haiku-4.5` (`/api/v1/chat/completions`).
 *
 * All three resolve the API key once per process from `OPENROUTER_API_KEY` / `SYSTEM_ONE_API_KEY`,
 * `~/.cache/ai/keys.env`, or the macOS Keychain (`openrouter-api-key`).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ArchiveHit, ArchiveJudge } from "./search.js";

export const ARCHIVE_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const ARCHIVE_EMBEDDING_DIMENSION = 1536;
export const ARCHIVE_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

export const ARCHIVE_JEV_MODEL = "~typesafe/jev-latest";
export const ARCHIVE_JEV_URL = "https://openrouter.ai/api/v1/systemone";
export const ARCHIVE_JEV_MAX_QUESTIONS = 26;
export const ARCHIVE_JEV_SNIPPET_CHARS = 3600;

export const ARCHIVE_HAIKU_MODEL = "anthropic/claude-haiku-4.5";
export const ARCHIVE_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const KEY_CACHE_FAILURE_MS = 120_000;
const KEYCHAIN_TIMEOUT_MS = 2000;
const EMBED_TIMEOUT_MS = 8000;
const JEV_TIMEOUT_MS = 6000;
const HAIKU_TIMEOUT_MS = 25_000;

export interface ArchiveOpenRouterOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	apiKey?: string | (() => Promise<string | undefined>);
	fetch?: typeof fetch;
}

export interface ArchiveClusterFactInput {
	id: string;
	repository?: string;
	at: string;
	body: string;
}

export type ArchiveFactCombiner = (
	facts: readonly ArchiveClusterFactInput[],
	signal?: AbortSignal,
) => Promise<string | undefined>;

let cachedKey: string | undefined;
let cachedFailureAt = 0;

function readEnvFileKey(filePath: string, keyName: string): string | undefined {
	try {
		const content = readFileSync(filePath, "utf8");
		for (const line of content.split(/\r?\n/)) {
			const match = new RegExp(`^(?:export\\s+)?${keyName}=(.+)$`).exec(line.trim());
			if (match?.[1]) {
				const value = match[1].trim().replace(/^["']|["']$/g, "");
				if (value && !value.startsWith("op://")) return value;
			}
		}
	} catch {
		// Unreadable or absent file.
	}
	return undefined;
}

function readKeychainKey(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"security",
			["find-generic-password", "-s", "openrouter-api-key", "-w"],
			{ timeout: KEYCHAIN_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const trimmed = stdout.trim();
				resolve(trimmed === "" ? undefined : trimmed);
			},
		);
	});
}

/** Resolves the OpenRouter / System One API key, caching it in memory. */
export async function resolveArchiveOpenRouterKey(options: ArchiveOpenRouterOptions = {}): Promise<string | undefined> {
	if (typeof options.apiKey === "string") return options.apiKey.trim() || undefined;
	if (typeof options.apiKey === "function") return (await options.apiKey())?.trim() || undefined;
	const env = options.env ?? process.env;
	const fromEnv = (env.OPENROUTER_API_KEY ?? env.SYSTEM_ONE_API_KEY)?.trim();
	if (fromEnv && !fromEnv.startsWith("op://")) return fromEnv;
	if (cachedKey) return cachedKey;
	if (Date.now() - cachedFailureAt < KEY_CACHE_FAILURE_MS) return undefined;

	const home = options.home ?? env.HOME ?? homedir();
	const cacheFile = join(home, ".cache", "ai", "keys.env");
	const fromFile = readEnvFileKey(cacheFile, "OPENROUTER_API_KEY") ?? readEnvFileKey(cacheFile, "SYSTEM_ONE_API_KEY");
	if (fromFile) {
		cachedKey = fromFile;
		return fromFile;
	}
	const fromKeychain = await readKeychainKey();
	if (fromKeychain) {
		cachedKey = fromKeychain;
		return fromKeychain;
	}
	cachedFailureAt = Date.now();
	return undefined;
}

/** Embeds a single query or chunk with `openai/text-embedding-3-small` on OpenRouter. */
export function openArchiveEmbedder(
	options: ArchiveOpenRouterOptions = {},
): (text: string, signal?: AbortSignal) => Promise<readonly number[] | undefined> {
	const send = options.fetch ?? globalThis.fetch;
	return async (text, signal) => {
		const trimmed = text.trim();
		if (trimmed === "") return undefined;
		const key = await resolveArchiveOpenRouterKey(options);
		if (!key) return undefined;
		const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
		const response = await send(ARCHIVE_EMBEDDINGS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: ARCHIVE_EMBEDDING_MODEL,
				input: [trimmed.slice(0, 8000)],
			}),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			throw new Error(`OpenRouter embeddings HTTP ${response.status}`);
		}
		const body = (await response.json()) as { data?: { embedding?: unknown }[] };
		const vector = body.data?.[0]?.embedding;
		if (!Array.isArray(vector) || vector.length !== ARCHIVE_EMBEDDING_DIMENSION) {
			throw new Error(`OpenRouter embeddings returned invalid vector`);
		}
		return vector as number[];
	};
}

/** Scores candidate memories against the prompt in one batched Jev (`~typesafe/jev-latest`) call. */
export function openArchiveJevJudge(options: ArchiveOpenRouterOptions = {}): ArchiveJudge {
	const send = options.fetch ?? globalThis.fetch;
	return async (query, candidates: readonly ArchiveHit[], signal) => {
		if (candidates.length === 0) return new Map();
		const key = await resolveArchiveOpenRouterKey(options);
		if (!key) throw new Error("OpenRouter API key unavailable for Jev");

		const batch = candidates.slice(0, ARCHIVE_JEV_MAX_QUESTIONS);
		const questions: Record<
			string,
			{ type: "noul"; instructions: string; criteria: { true: string; false: string } }
		> = {};
		batch.forEach((candidate, index) => {
			const snippet = candidate.body.replace(/\s+/g, " ").trim().slice(0, ARCHIVE_JEV_SNIPPET_CHARS);
			const kind = candidate.kind ?? "memory";
			const repo = candidate.repository ?? "unknown";
			questions[`m_${index}`] = {
				type: "noul",
				instructions: `Would showing this recorded memory (${kind}, repo: ${repo}): "${snippet}" help the agent answer or avoid a mistake on this request?`,
				criteria: {
					true: "Contains the answer, a relevant past finding, or a rule/deprecation/gotcha about the tools, files, or repositories involved in the request.",
					false: "Unrelated to the request and only matches generic words.",
				},
			};
		});

		const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
		const response = await send(ARCHIVE_JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: ARCHIVE_JEV_MODEL,
				state: { request: query.slice(0, 4000) },
				questions,
			}),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			throw new Error(`Jev HTTP ${response.status}`);
		}
		const body = (await response.json()) as {
			answers?: Record<string, { noul?: unknown }>;
		};
		const scores = new Map<string, number>();
		batch.forEach((candidate, index) => {
			const raw = body.answers?.[`m_${index}`]?.noul;
			if (typeof raw === "number" && Number.isFinite(raw)) {
				scores.set(candidate.id, Math.max(0, Math.min(1, raw)));
			}
		});
		return scores;
	};
}

/** Combines a chronological cluster of similar facts into one canonical fact using Haiku. */
export function openArchiveHaikuCombiner(options: ArchiveOpenRouterOptions = {}): ArchiveFactCombiner {
	const send = options.fetch ?? globalThis.fetch;
	return async (facts, signal) => {
		if (facts.length === 0) return undefined;
		if (facts.length === 1) return facts[0]?.body;
		const key = await resolveArchiveOpenRouterKey(options);
		if (!key) throw new Error("OpenRouter API key unavailable for Haiku consolidation");

		const prompt = [
			"Combine the following chronologically ordered memory facts into ONE canonical fact.",
			"Rules:",
			"1. Preserve EVERY concrete identifier, file path, IP address, hostname, command, version, SHA, error message, and number from all entries.",
			"2. If a newer entry contradicts an older entry, keep the newer state.",
			"3. Keep a `[context: ...]` header on the first line, then concise prose or numbered points.",
			"4. Output ONLY the combined fact text, with no preamble or markdown code fences.",
			"",
			...facts.map(
				(fact, idx) =>
					`--- Fact ${idx + 1} (${fact.at}, repo: ${fact.repository ?? "unknown"}) ---\n${fact.body}`,
			),
		].join("\n\n");

		const timeout = AbortSignal.timeout(HAIKU_TIMEOUT_MS);
		const response = await send(ARCHIVE_CHAT_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: ARCHIVE_HAIKU_MODEL,
				messages: [{ role: "user", content: prompt }],
				temperature: 0,
				max_tokens: 1400,
			}),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			throw new Error(`OpenRouter Haiku HTTP ${response.status}`);
		}
		const body = (await response.json()) as {
			choices?: { message?: { content?: unknown } }[];
		};
		const content = body.choices?.[0]?.message?.content;
		return typeof content === "string" && content.trim() !== "" ? content.trim() : undefined;
	};
}
