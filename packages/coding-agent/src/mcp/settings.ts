/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { setMcpRenderMarkdownResults } from "@oh-my-pi/pi-tui/tools/mcp";
import { effect, register } from "../config/registry";

// MCP
export const cfgMcpEnableProjectConfig = register({
	id: "mcp.enableProjectConfig",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Project Config",
		description: "Load .mcp.json/mcp.json from project root",
	},
});

export const cfgMcpStartupTimeoutMs = register({
	id: "mcp.startupTimeoutMs",
	type: "number",
	default: 250,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Startup Window",
		description: "Wait this many milliseconds for initial MCP tool discovery; 0 waits until connections settle",
	},
});

export const cfgMcpRenderMarkdownResults = register({
	id: "mcp.renderMarkdownResults",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Markdown Results",
		description: "Render non-JSON MCP text results as Markdown in the transcript",
	},
});
effect(cfgMcpRenderMarkdownResults, setMcpRenderMarkdownResults);

export const cfgMcpHotReload = register({
	id: "mcp.hotReload",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Hot Reload",
		description:
			"Enable live MCP hot reload (config file changes and stdio server binary changes, controlled individually below)",
	},
});

export const cfgMcpHotReloadConfig = register({
	id: "mcp.hotReloadConfig",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "Hot Reload MCP Config",
		description:
			"Watch mcp.json and .mcp.json files and reconcile added, updated, or removed MCP servers in the running session when idle",
	},
});

export const cfgMcpHotReloadServers = register({
	id: "mcp.hotReloadServers",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "Hot Reload MCP Stdio Servers",
		description: "Reconnect a stdio MCP server when its executable or script changes on disk",
	},
});

export const cfgMcpNotifications = register({
	id: "mcp.notifications",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Update Injection",
		description: "Inject MCP resource updates into the agent conversation",
	},
});

export const cfgMcpNotificationDebounceMs = register({
	id: "mcp.notificationDebounceMs",
	type: "number",
	default: 500,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Notification Debounce",
		description:
			"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
	},
});
