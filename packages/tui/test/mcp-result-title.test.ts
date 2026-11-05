import { describe, expect, it } from "bun:test";
import { describeMCPResult, mcpResultTitle, type MCPToolDetails } from "../src/tools/mcp";
import type { RenderResultOptions } from "../src/tools/renderer";

const opts = { expanded: false, isPartial: false } as RenderResultOptions;

describe("MCP result title", () => {
	it("names the refused route with an Auto-blocked marker for a hook-blocked call", () => {
		const details: MCPToolDetails = {
			serverName: "capability",
			mcpToolName: "run_command",
			isError: true,
			blocked: true,
			blockReason: "off-topic",
		};
		expect(mcpResultTitle(details)).toBe("capability/run_command — Auto-blocked");

		const view = describeMCPResult(
			{ content: [{ type: "text", text: "Scope guard: off-topic" }], details, isError: true },
			opts,
			{ command: "echo hi" },
		);
		expect(view?.tool?.title).toBe("capability/run_command — Auto-blocked");
		expect(JSON.stringify(view?.tool)).not.toContain("undefined");
	});

	it("falls back to MCP when details carry no route instead of rendering undefined/undefined", () => {
		const view = describeMCPResult(
			{ content: [{ type: "text", text: "blocked" }], details: {} as MCPToolDetails, isError: true },
			opts,
			{},
		);
		expect(view?.tool?.title).toBe("MCP");
		expect(JSON.stringify(view?.tool)).not.toContain("undefined");
	});

	it("marks a blocked call without route identity as Auto-blocked by hook", () => {
		expect(mcpResultTitle({ blocked: true } as MCPToolDetails)).toBe("Auto-blocked by hook");
		expect(mcpResultTitle(undefined)).toBe("MCP");
	});
});
