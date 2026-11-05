import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

interface ToolResultFrame {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

/** Render a settled tool call exactly as the transcript would (ANSI path). */
function renderSettled(
	tool: { label: string; renderCall?: unknown; renderResult?: unknown; mergeCallAndResult?: boolean },
	name: string,
	args: unknown,
	result: ToolResultFrame,
): string {
	const tui = new TUI(new VirtualTerminal(120, 20));
	const component = new ToolExecutionComponent(name, args, {}, tool as never, tui);
	component.updateResult(result, false);
	component.setTranscriptAllocation(20, { tick: 0, now: 0 });
	return Bun.stripANSI(component.render(120).join("\n"));
}

function capabilityTool(serverToolName: string): MCPTool {
	return new MCPTool(
		{ name: "capability", config: {} } as never,
		{
			name: serverToolName,
			inputSchema: { type: "object" },
		} as never,
	);
}

function deferredCapabilityTool(serverToolName: string): DeferredMCPTool {
	return new DeferredMCPTool(
		"capability",
		{ name: serverToolName, inputSchema: { type: "object" } } as never,
		async () => {
			throw new Error("not needed for rendering");
		},
	);
}

function otherServerTool(serverName: string, serverToolName: string): MCPTool {
	return new MCPTool(
		{ name: serverName, config: {} } as never,
		{
			name: serverToolName,
			inputSchema: { type: "object" },
		} as never,
	);
}

function capabilityResult(mcpToolName: string, output: Record<string, unknown>): ToolResultFrame {
	return {
		content: [{ type: "text", text: JSON.stringify({ capability: mcpToolName, output }) }],
		details: { serverName: "capability", mcpToolName },
	};
}

const READ_NAME = "mcp__capability_agentmux_capability_read";
const TOOL_CALL_NAME = "mcp__capability_tool_call";

describe("capability gateway abbreviated display", () => {
	it("renders a capability read result as one line named `read`, without the server prefix, envelope, or expand hint", () => {
		for (const tool of [
			capabilityTool("agentmux_capability_read"),
			deferredCapabilityTool("agentmux_capability_read"),
		]) {
			const out = renderSettled(
				tool,
				READ_NAME,
				{ path: "/tmp/notes.md" },
				capabilityResult("agentmux_capability_read", { content: "hello" }),
			);
			expect(out).toContain("read");
			expect(out).toContain('path="/tmp/notes.md"');
			expect(out).not.toContain("capability/");
			expect(out).not.toContain('"capability":');
			expect(out).not.toContain("Expand");
		}
	});

	it("titles a tool_call row with the addressed tool and shows its args, not the dispatcher", () => {
		const out = renderSettled(
			capabilityTool("tool_call"),
			TOOL_CALL_NAME,
			{ address: "capability/edit_replace", args: { path: "/tmp/a.ts", old_string: "a", new_string: "b" } },
			capabilityResult("tool_call", { status: "ok" }),
		);
		expect(out).toContain("edit_replace");
		expect(out).toContain('path="/tmp/a.ts"');
		expect(out).not.toContain("tool_call");
		expect(out).not.toContain("address=");
		expect(out).not.toContain("Expand");
	});

	it("keeps the verbose card and its output for a capability error result", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_read"),
			READ_NAME,
			{ path: "/tmp/missing.md" },
			{
				content: [{ type: "text", text: "no such file: /tmp/missing.md" }],
				details: { serverName: "capability", mcpToolName: "agentmux_capability_read", isError: true },
				isError: true,
			},
		);
		expect(out).toContain("no such file: /tmp/missing.md");
		expect(out).toContain("agentmux_capability_read");
	});

	it("keeps the verbose MCP card for a non-capability server", () => {
		const out = renderSettled(
			otherServerTool("weather", "get_forecast"),
			"mcp__weather_get_forecast",
			{ city: "Oslo" },
			{
				content: [{ type: "text", text: JSON.stringify({ weather: "rain", temp: 4 }) }],
				details: { serverName: "weather", mcpToolName: "get_forecast" },
			},
		);
		expect(out).toContain("weather/get_forecast");
		expect(out).toContain("Expand");
	});
});
