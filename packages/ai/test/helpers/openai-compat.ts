import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec, ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";

const stockSpec: ModelSpec<"openai-completions"> = {
	id: "stock-chat-completions",
	name: "Stock chat completions",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

/**
 * Compat for message-conversion tests: the catalog's resolved stock chat-completions policy,
 * with the request-shaping fields those tests never exercise pinned off.
 * A new required compat field is picked up from the resolver, so no fixture needs a hand edit.
 */
export function openAICompat(overrides: Partial<ResolvedOpenAICompat> = {}): ResolvedOpenAICompat {
	const model: Model<"openai-completions"> = buildModel(stockSpec);
	return {
		...model.compat,
		openRouterRouting: {},
		vercelGatewayRouting: {},
		extraBody: {},
		toolStrictMode: "none",
		usesOpenAIToolCallIdLimit: false,
		...overrides,
	};
}
