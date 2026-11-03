import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";

// Minted registry names (`createMCPToolName("capability", "agentmux_capability_…")`)
// of the capability gateway's job tools, mirrored here so the RED run exercises
// the unmodified renderers rather than a missing module.
const MCP_CAPABILITY_WAIT_NAME = "mcp__capability_agentmux_capability_wait";
const MCP_CAPABILITY_RUN_COMMAND_NAME = "mcp__capability_agentmux_capability_run_command";

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

function waitResult(output: Record<string, unknown>): ToolResultFrame {
	return {
		content: [{ type: "text", text: JSON.stringify({ capability: "wait", output }) }],
		details: { serverName: "capability", mcpToolName: "agentmux_capability_wait" },
	};
}

function runCommandResult(output: Record<string, unknown>): ToolResultFrame {
	return {
		content: [{ type: "text", text: JSON.stringify({ capability: "run_command", output }) }],
		details: { serverName: "capability", mcpToolName: "agentmux_capability_run_command" },
	};
}

describe("capability gateway background-job rows", () => {
	it("renders a settled wait on a job as one background-job row, not the MCP card", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{ job_id: "job-123" },
			waitResult({ status: "settled", job: { job_id: "job-123", state: "exited", exit_code: 0 }, elapsed_ms: 80 }),
		);
		expect(out).toContain("Background job completed [job] job-123 (exit 0)");
		expect(out).not.toContain("capability/agentmux_capability_wait");
		expect(out).not.toContain("Expand");
		expect(out).not.toContain("Args");
	});

	it("renders a failed job with the failed row variant", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{ job_id: "job-f" },
			waitResult({ status: "settled", job: { job_id: "job-f", state: "exited", exit_code: 1 } }),
		);
		expect(out).toContain("Background job failed [job] job-f (exit 1)");
		expect(out).not.toContain("Expand");
	});

	it("renders a settled wait on a queued completion as one row without subject or body", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{},
			waitResult({
				status: "settled",
				completion: {
					id: "c-1",
					kind: "completion",
					channel: "completions",
					from: "job:job-9",
					subject: "wt switch exited 0",
					body: "/tmp/log",
					about: { type: "job", id: "job-9", exit_code: 0, state: "exited" },
					more_pending: 4,
				},
				elapsed_ms: 80,
			}),
		);
		expect(out).toContain("Background job completed [job] job-9 (exit 0)");
		expect(out).not.toContain("wt switch exited 0");
		expect(out).not.toContain("more_pending");
		expect(out).not.toContain("Expand");
	});

	it("renders a settled wait on a task as one row with the task title", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{},
			waitResult({ status: "settled", task: { id: "t-1", title: "Refactor renderers" } }),
		);
		expect(out).toContain("Background job completed [task] Refactor renderers");
		expect(out).not.toContain("Expand");
	});

	it("renders a timed-out wait as one muted row while the work still runs", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{ timeout_seconds: 290 },
			waitResult({ status: "timed_out", elapsed_ms: 290000 }),
		);
		expect(out).toContain("Wait timed out");
		expect(out).toContain("the work is still running");
		expect(out).not.toContain("capability/agentmux_capability_wait");
		expect(out).not.toContain("Expand");
	});

	it("renders nothing-to-wait-for as one muted row", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{},
			waitResult({ status: "nothing_to_wait_for" }),
		);
		expect(out).toContain("Nothing to wait for");
		expect(out).not.toContain("Expand");
	});

	it("keeps the MCP card for structured wait winners the row does not cover", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{},
			waitResult({ status: "settled", wait: { wait_id: "w-1", state: "fired" } }),
		);
		expect(out).toContain("capability/agentmux_capability_wait");
		expect(out).toContain("Expand");
	});

	it("renders a backgrounded run_command dispatch as one row with the job id and command preview", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_run_command"),
			MCP_CAPABILITY_RUN_COMMAND_NAME,
			{ command: "wt step commit", purpose: "checkpoint", session: "main", background: true },
			runCommandResult({ status: "ok", exit_code: 0, body: "dispatched", jobId: "job-abc" }),
		);
		expect(out).toContain("Backgrounded as job job-abc");
		expect(out).toContain("wt step commit");
		expect(out).not.toContain("capability/agentmux_capability_run_command");
		expect(out).not.toContain("Expand");
		expect(out).not.toContain("Args");
	});

	it("keeps the MCP card for a foreground run_command with real output", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_run_command"),
			MCP_CAPABILITY_RUN_COMMAND_NAME,
			{ command: "echo hello" },
			runCommandResult({ status: "ok", exit_code: 0, body: "hello\n" }),
		);
		expect(out).toContain("capability/agentmux_capability_run_command");
		expect(out).toContain("Expand");
	});

	it("keeps the MCP card for a malformed capability payload", () => {
		const out = renderSettled(
			capabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{},
			{
				content: [{ type: "text", text: "not json at all" }],
				details: { serverName: "capability", mcpToolName: "agentmux_capability_wait" },
			},
		);
		expect(out).toContain("capability/agentmux_capability_wait");
	});

	it("routes the deferred capability tool twin the same way", () => {
		const out = renderSettled(
			deferredCapabilityTool("agentmux_capability_wait"),
			MCP_CAPABILITY_WAIT_NAME,
			{ job_id: "job-d" },
			waitResult({ status: "settled", job: { job_id: "job-d", state: "exited", exit_code: 0 } }),
		);
		expect(out).toContain("Background job completed [job] job-d (exit 0)");
		expect(out).not.toContain("Expand");
	});
});
