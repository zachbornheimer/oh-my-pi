import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	activeProviderSuspension,
	classifyProviderSuspension,
	ProviderSuspensionStore,
	recordProviderSuspension,
	setProviderSuspensionStoreForTests,
	suspensionFromClassification,
	type ProviderSuspension,
} from "@oh-my-pi/pi-ai/auth/provider-suspension";
import { isBillingSuspensionBody, parseSuspensionResetsAtMs } from "@oh-my-pi/pi-ai/error/rate-limit";

let storeDir: string;

beforeAll(() => {
	storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-suspension-test-"));
});

afterAll(() => {
	fs.rmSync(storeDir, { recursive: true, force: true });
});

/** One shared store per test, and the module singleton routed through it. */
function freshStore(name: string): ProviderSuspensionStore {
	const store = new ProviderSuspensionStore(path.join(storeDir, `${name}.json`));
	setProviderSuspensionStoreForTests(store);
	return store;
}

const OPENAI_CREDIT_429 =
	'{"error":{"message":"You have exceeded your credit balance.","code":"credit_balance_exhausted"}}';
const OPENAI_CREDIT_429_WITH_RESET =
	'{"error":{"message":"You have exceeded your credit balance.","code":"credit_balance_exhausted","resets_at":1767225600}}';
const ANTHROPIC_BILLING_402 =
	'{"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low to access the Anthropic API"}}';
const ANTHROPIC_SPEND_CAP =
	'{"type":"error","error":{"type":"error","message":"Request would exceed your organization\'s enforced_spend_limit_reached"}}';
const OPENROUTER_KEY_LIMIT_402 =
	'{"error":{"message":"Monthly key limit reached. Add credits or wait for the reset."}}';
const USAGE_LIMIT_429 =
	'{"error":{"message":"You have hit your usage limit for this model. Please try again in 45 seconds.","type":"usage_limit_reached"}}';

describe("classifyProviderSuspension", () => {
	it("classifies a 429 credit_balance_exhausted body as billing, from the body not the status", () => {
		const classified = classifyProviderSuspension(OPENAI_CREDIT_429, 429);
		expect(classified?.kind).toBe("billing");
		expect(classified?.reasonClass).toBe("billing");
	});

	it("reads the billing body's resets_at as the suspension end", () => {
		const classified = classifyProviderSuspension(OPENAI_CREDIT_429_WITH_RESET, 429);
		expect(classified?.kind).toBe("billing");
		expect(classified?.resetsAtMs).toBe(1767225600 * 1000);
		expect(parseSuspensionResetsAtMs('{"resets_at":"2026-01-01T00:00:00Z"}')).toBe(
			Date.parse("2026-01-01T00:00:00Z"),
		);
	});

	it("classifies Anthropic billing_error and enforced_spend_limit_reached as billing", () => {
		expect(classifyProviderSuspension(ANTHROPIC_BILLING_402, 402)?.kind).toBe("billing");
		expect(classifyProviderSuspension(ANTHROPIC_SPEND_CAP, 429)?.kind).toBe("billing");
	});

	it("classifies OpenRouter key and budget limits as billing on a billing-shaped status", () => {
		expect(classifyProviderSuspension(OPENROUTER_KEY_LIMIT_402, 402)?.kind).toBe("billing");
		// The prose arm is gated on a billing-shaped status; elsewhere it must not fire.
		expect(classifyProviderSuspension(OPENROUTER_KEY_LIMIT_402, 500)).toBeUndefined();
	});

	it("classifies a usage limit with a stated delay, suspending only until it passes", () => {
		const classified = classifyProviderSuspension(USAGE_LIMIT_429, 429);
		expect(classified?.kind).toBe("usage-limit");
		expect(classified?.retryAfterMs).toBeGreaterThan(0);
	});

	it("leaves an unrecognized 402 unclassified so it stays retryable and unbanned", () => {
		expect(classifyProviderSuspension('{"error":{"message":"Endpoint subscription required"}}', 402)).toBeUndefined();
		expect(classifyProviderSuspension("some opaque gateway failure", 402)).toBeUndefined();
	});

	it("never records a fixed cooldown for a hintless transient 429", () => {
		expect(classifyProviderSuspension('{"error":{"message":"Too many requests"}}', 429)).toBeUndefined();
		expect(isBillingSuspensionBody('{"error":{"message":"Too many requests"}}', 429)).toBe(false);
	});
});

describe("ProviderSuspensionStore", () => {
	it("keeps the billing suspension until the body's resets_at", () => {
		const store = freshStore("billing-resets-at");
		const resetsAtMs = 1_900_000_000_000;
		store.record({
			provider: "openai",
			modelId: "gpt-5",
			credentialId: "12",
			kind: "billing",
			reasonClass: "billing",
			untilMs: resetsAtMs,
			recordedAtMs: 1_800_000_000_000,
		});
		expect(store.active({ provider: "openai", modelId: "gpt-5", nowMs: resetsAtMs - 1 })?.kind).toBe("billing");
		expect(store.active({ provider: "openai", modelId: "gpt-5", nowMs: resetsAtMs })).toBeUndefined();
	});

	it("holds a usage-limit until as a minimum: never shortened, eligible again after it passes", () => {
		const store = freshStore("usage-limit-minimum");
		const nowMs = 1_800_000_000_000;
		const classified = { kind: "usage-limit", reasonClass: "usage-limit", retryAfterMs: 60_000 } as const;
		const first = suspensionFromClassification({
			provider: "anthropic",
			modelId: "claude-opus",
			credentialId: "7",
			classified,
			nowMs,
		});
		store.record(first);
		expect(
			store.active({ provider: "anthropic", modelId: "claude-opus", credentialId: "7", nowMs: nowMs + 59_999 }),
		).toBeDefined();
		expect(
			store.active({ provider: "anthropic", modelId: "claude-opus", credentialId: "7", nowMs: nowMs + 60_000 }),
		).toBeUndefined();
		// A later, shorter stated delay never shortens the wait.
		const shorter = suspensionFromClassification({
			provider: "anthropic",
			modelId: "claude-opus",
			credentialId: "7",
			classified: { kind: "usage-limit", reasonClass: "usage-limit", retryAfterMs: 10_000 },
			nowMs,
		});
		store.record(shorter);
		expect(
			store.active({ provider: "anthropic", modelId: "claude-opus", credentialId: "7", nowMs: nowMs + 59_999 }),
		).toBeDefined();
	});

	it("clears a billing suspension when the credential id changes", () => {
		const store = freshStore("billing-credential-change");
		const record = suspensionFromClassification({
			provider: "openai",
			modelId: "gpt-5",
			credentialId: "12",
			classified: { kind: "billing", reasonClass: "billing" },
		});
		store.record(record);
		expect(store.active({ provider: "openai", modelId: "gpt-5", credentialId: "12" })).toBeDefined();
		expect(store.active({ provider: "openai", modelId: "gpt-5", credentialId: "13" })).toBeUndefined();
	});

	it("clears a billing suspension when the recorded credit/budget generation changes", () => {
		const store = freshStore("billing-generation-change");
		const record = suspensionFromClassification({
			provider: "openai",
			modelId: "gpt-5",
			credentialId: "12",
			classified: { kind: "billing", reasonClass: "billing", generation: "credits=0" },
		});
		store.record(record);
		expect(
			store.active({ provider: "openai", modelId: "gpt-5", credentialId: "12", generation: "credits=0" }),
		).toBeDefined();
		expect(
			store.active({ provider: "openai", modelId: "gpt-5", credentialId: "12", generation: "credits=500" }),
		).toBeUndefined();
	});

	it("serves a second caller from the same durable file while the record is live", () => {
		const filePath = path.join(storeDir, "shared.json");
		const writer = new ProviderSuspensionStore(filePath);
		const reader = new ProviderSuspensionStore(filePath);
		writer.record({
			provider: "openrouter",
			modelId: "deepseek/r1",
			credentialId: "3",
			kind: "billing",
			reasonClass: "billing",
			untilMs: Date.now() + 3_600_000,
			recordedAtMs: Date.now(),
		});
		const record = reader.active({ provider: "openrouter", modelId: "deepseek/r1" });
		expect(record?.kind).toBe("billing");
		expect(record?.credentialId).toBe("3");
	});

	it("leaves a healthy provider selected: no record, no suspension", () => {
		const store = freshStore("healthy");
		store.record({
			provider: "anthropic",
			modelId: "claude-opus",
			credentialId: "7",
			kind: "usage-limit",
			reasonClass: "usage-limit",
			untilMs: Date.now() - 1, // already expired
			recordedAtMs: Date.now() - 60_000,
		});
		expect(store.active({ provider: "healthy-provider", modelId: "any-model" })).toBeUndefined();
		expect(store.active({ provider: "anthropic", modelId: "claude-opus" })).toBeUndefined();
		expect(activeProviderSuspension({ provider: "healthy-provider" })).toBeUndefined();
	});

	it("keeps the module singleton routing through the injected store for one-shot callers", () => {
		const store = freshStore("singleton-routing");
		const record: ProviderSuspension = suspensionFromClassification({
			provider: "openai",
			modelId: "gpt-5",
			credentialId: "",
			classified: { kind: "billing", reasonClass: "billing" },
		});
		recordProviderSuspension(record);
		expect(store.active({ provider: "openai", modelId: "gpt-5" })).toBeDefined();
		expect(activeProviderSuspension({ provider: "openai", modelId: "gpt-5" })).toBeDefined();
	});
});
