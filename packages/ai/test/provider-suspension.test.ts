import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyProviderError, SuspensionRegistry } from "../src/llm/provider-suspension";

const FIXED_NOW = 1_700_000_000_000;
let tempDir: string | undefined;

async function createRegistry(): Promise<SuspensionRegistry> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-suspension-"));
	return new SuspensionRegistry(tempDir);
}

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("classifyProviderError", () => {
	it("classifies OpenAI billing, spend, quota, and exhausted-credit errors, including 429", () => {
		for (const code of [
			"billing_hard_limit_reached",
			"billing_limit_reached",
			"spend_limit_exceeded",
			"insufficient_quota",
			"quota_exceeded",
			"credit_balance_exhausted",
		]) {
			expect(classifyProviderError(429, {}, { error: { code } })).toEqual({ kind: "billing", untilMs: null });
		}
	});

	it("classifies Anthropic billing and enforced spend-limit errors", () => {
		for (const code of ["billing_error", "enforced_spend_limit_reached"]) {
			expect(classifyProviderError(400, {}, { type: "error", error: { type: code } })).toEqual({
				kind: "billing",
				untilMs: null,
			});
		}
	});

	it("classifies OpenRouter key, credit, and budget limits as billing without a reset", () => {
		for (const code of ["key_limit_exceeded", "insufficient_credits", "budget_limit_exceeded"]) {
			expect(classifyProviderError(402, {}, { error: { code } })).toEqual({ kind: "billing", untilMs: null });
		}
	});

	it("uses the longest Retry-After or body delay and never shortens the stated floor", () => {
		const clock = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		try {
			expect(classifyProviderError(429, { "Retry-After": "30" }, { message: "try again in ~2 min" })).toEqual({
				kind: "usage-limit",
				untilMs: FIXED_NOW + 120_000,
			});
			expect(classifyProviderError(429, { "retry-after": "180" }, { message: "try again in 2 minutes" })).toEqual({
				kind: "usage-limit",
				untilMs: FIXED_NOW + 180_000,
			});
		} finally {
			clock.mockRestore();
		}
	});

	it("parses approximate and plural minute hints", () => {
		const clock = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		try {
			for (const [message, delay] of [
				["Try again in ~ 3 mins", 180_000],
				["try again in about 1 minute", 60_000],
			] as const) {
				expect(classifyProviderError(429, {}, { message })).toEqual({
					kind: "usage-limit",
					untilMs: FIXED_NOW + delay,
				});
			}
		} finally {
			clock.mockRestore();
		}
	});

	it("honors reset timestamps and limits reset override to OpenRouter billing codes", () => {
		const clock = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		try {
			const resetAt = "2023-11-14T22:15:20.000Z";
			expect(classifyProviderError(429, {}, { error: { code: "key_limit_exceeded", resets_at: resetAt } })).toEqual({
				kind: "usage-limit",
				untilMs: Date.parse(resetAt),
			});
			expect(classifyProviderError(402, {}, { error: { code: "insufficient_credits", reset_at: resetAt } })).toEqual(
				{ kind: "usage-limit", untilMs: Date.parse(resetAt) },
			);
			expect(classifyProviderError(429, {}, { error: { reset_at: 1_700_000_180 } })).toEqual({
				kind: "usage-limit",
				untilMs: FIXED_NOW + 180_000,
			});
			expect(
				classifyProviderError(429, {}, { error: { code: "credit_balance_exhausted", resets_at: resetAt } }),
			).toEqual({ kind: "billing", untilMs: null });
		} finally {
			clock.mockRestore();
		}
	});

	it("classifies unrelated and unparseable errors as other", () => {
		expect(classifyProviderError(500, {}, { message: "internal error" })).toEqual({ kind: "other", untilMs: null });
		expect(classifyProviderError(500, {}, "plain error text")).toEqual({ kind: "other", untilMs: null });
	});
});

describe("SuspensionRegistry", () => {
	it("does not persist other provider failures", async () => {
		const registry = await createRegistry();
		await registry.recordFailure("openai", "credential", "gpt-test", { kind: "other", untilMs: null });

		expect(await Bun.file(path.join(tempDir!, "provider-suspensions.json")).exists()).toBeFalse();
	});

	it("persists billing suspensions across instances and applies them to every model for the credential", async () => {
		const registry = await createRegistry();
		await registry.recordFailure("openai", "credential-secret", "gpt-test", { kind: "billing", untilMs: null });

		const reloaded = new SuspensionRegistry(tempDir!);
		expect(await reloaded.isSuspended("openai", "credential-secret", "gpt-test", FIXED_NOW)).toBeTrue();
		expect(await reloaded.isSuspended("openai", "credential-secret", "other-model", FIXED_NOW)).toBeTrue();
		const persisted = await fs.readFile(path.join(tempDir!, "provider-suspensions.json"), "utf8");
		expect(persisted).not.toContain("credential-secret");
	});

	it("keeps usage suspensions model-specific and drops them once expired", async () => {
		const registry = await createRegistry();
		await registry.recordFailure("anthropic", "credential", "claude-test", {
			kind: "usage-limit",
			untilMs: FIXED_NOW + 1_000,
		});

		expect(await registry.isSuspended("anthropic", "credential", "claude-test", FIXED_NOW)).toBeTrue();
		expect(await registry.isSuspended("anthropic", "credential", "another-model", FIXED_NOW)).toBeFalse();
		expect(await registry.isSuspended("anthropic", "credential", "claude-test", FIXED_NOW + 1_000)).toBeFalse();
		const persisted = JSON.parse(await fs.readFile(path.join(tempDir!, "provider-suspensions.json"), "utf8"));
		expect(Object.keys(persisted.records)).toHaveLength(0);
	});

	it("clears the matching model and credential-wide suspensions after success", async () => {
		const registry = await createRegistry();
		await registry.recordFailure("openai", "credential", "gpt-test", { kind: "billing", untilMs: null });
		await registry.recordFailure("openai", "credential", "gpt-test", {
			kind: "usage-limit",
			untilMs: FIXED_NOW + 60_000,
		});

		await registry.recordSuccess("openai", "credential", "gpt-test");
		expect(await registry.isSuspended("openai", "credential", "gpt-test", FIXED_NOW)).toBeFalse();
		expect(await registry.isSuspended("openai", "credential", "another-model", FIXED_NOW)).toBeFalse();
	});

	it("preserves concurrent records with whole-file atomic replacement", async () => {
		const registry = await createRegistry();
		await Promise.all(
			["model-a", "model-b", "model-c"].map(model =>
				registry.recordFailure("openrouter", "credential", model, {
					kind: "usage-limit",
					untilMs: FIXED_NOW + 60_000,
				}),
			),
		);

		for (const model of ["model-a", "model-b", "model-c"]) {
			expect(await registry.isSuspended("openrouter", "credential", model, FIXED_NOW)).toBeTrue();
		}
	});
});
