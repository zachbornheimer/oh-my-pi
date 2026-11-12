import { describe, expect, it } from "bun:test";
import { ALWAYS_ON_CAPABILITY_NAMES } from "@oh-my-pi/pi-coding-agent/session/prompt-tool-activation";

describe("ALWAYS_ON_CAPABILITY_NAMES", () => {
	it("is restricted to the essential core", () => {
		expect([...ALWAYS_ON_CAPABILITY_NAMES]).toEqual([
			"read",
			"write",
			"run_command",
			"tool_search",
			"skill_search",
			"tool_call",
		]);
	});
});
