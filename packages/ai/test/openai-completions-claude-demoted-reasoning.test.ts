import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function target(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "gw",
		baseUrl: "http://gateway.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} satisfies ModelSpec<"openai-completions">);
}

function grokTurn(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "gw",
		model: "xai-oauth/grok-4.7",
		content: [
			{ type: "thinking", thinking: "grok private plan", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "Done." },
		],
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function conversation(): Message[] {
	return [
		{ role: "user", content: "Plan it.", timestamp: 0 },
		grokTurn(),
		{ role: "user", content: "Continue.", timestamp: 0 },
	];
}

function assistantContent(model: Model<"openai-completions">): unknown {
	const wire = convertMessages(model, { messages: conversation() }, model.compat);
	return wire.find(message => message.role === "assistant")?.content;
}

describe("another model's reasoning replayed to Claude over chat completions", () => {
	it("is left out, so the reasoning_extraction classifier is not tripped", () => {
		expect(assistantContent(target("anthropic/claude-sonnet-5-5"))).toBe("Done.");
	});

	it("is still replayed as text to a model whose provider does not classify it", () => {
		expect(String(assistantContent(target("openai-codex/gpt-6.1-sol")))).toContain("grok private plan");
	});
});
