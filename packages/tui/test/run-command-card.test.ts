import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import {
	capabilityRunCommandOutput,
	capabilityRunCommandRenderer,
	isCapabilityRunCommand,
} from "@oh-my-pi/pi-tui/tools/run-command";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../src/tools/renderer";

/** The server and tool the gateway's shell answers under. */
const shellTool = { serverName: "capability", mcpToolName: "agentmux_capability_run_command" };

/**
 * A call the gateway answered live: `agentmux_capability_run_command { command: "echo card-fixture" }`.
 * `jobId`, `log` and `exitCode` sit inside `output`, beside the `status`/`exit_code`/`body` contract, and
 * the whole envelope is what the harness stored as the MCP result's structured content and as its text.
 */
const envelope = {
	capability: "run_command",
	output: {
		status: "ok",
		exit_code: 0,
		body: "card-fixture\n",
		jobId: "e5ff2ad0-430d-46ef-9966-485eda1a0157",
		log: "/tmp/capability-bash-A5yxXe/output.log",
		exitCode: 0,
	},
	usage: {
		calls: [],
		steps: [],
		totals: { wall_ms: 24, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 },
	},
	runIds: [],
	cached: false,
};

const options: RenderResultOptions = { expanded: false, isPartial: false };

/** A result carrying `payload` as the server's structured content, or only as the model-facing text. */
function resultOf(payload: unknown, structured: boolean) {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details: { ...shellTool, structuredContent: structured ? (payload as Record<string, unknown>) : undefined },
		isError: false,
	};
}

describe("the capability gateway's shell card", () => {
	let theme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		theme = loaded;
	});

	it("claims the gateway's shell tool and no other MCP tool", () => {
		expect(isCapabilityRunCommand("agentmux_capability_run_command")).toBe(true);
		expect(isCapabilityRunCommand("run_command")).toBe(true);
		expect(isCapabilityRunCommand("agentmux_capability_web_search")).toBe(false);
		expect(isCapabilityRunCommand("run_command_batch")).toBe(false);
	});

	it("lifts the command's result out of the envelope, from structured content or from the text", () => {
		const expected = {
			status: "ok",
			exit_code: 0,
			body: "card-fixture\n",
			reason: undefined,
			jobId: "e5ff2ad0-430d-46ef-9966-485eda1a0157",
		};
		expect(capabilityRunCommandOutput(resultOf(envelope, true))).toEqual(expected);
		expect(capabilityRunCommandOutput(resultOf(envelope, false))).toEqual(expected);
	});

	it("draws the command and its output instead of the envelope's keys", () => {
		const component = capabilityRunCommandRenderer.renderResult?.(resultOf(envelope, true), options, theme, {
			command: "echo card-fixture",
			purpose: "smoke the card",
		});
		expect(component).toBeDefined();
		const rendered = sanitizeText(component?.render(120).join("\n") ?? "");
		expect(rendered).toContain("echo card-fixture");
		expect(rendered).toContain("card-fixture");
		expect(rendered).not.toContain("exit_code");
		expect(rendered).not.toContain("capability");
	});

	it("shows a promoted job as a running job with no body", () => {
		const running = {
			capability: "run_command",
			output: { status: "ok", exit_code: 0, jobId: "job-7", log: "/tmp/job-7.log" },
		};
		const output = capabilityRunCommandOutput(resultOf(running, true));
		expect(output?.jobId).toBe("job-7");
		expect(output?.body).toBeUndefined();
		const component = capabilityRunCommandRenderer.renderResult?.(resultOf(running, true), options, theme, {
			command: "sleep 30",
		});
		const rendered = sanitizeText(component?.render(120).join("\n") ?? "");
		expect(rendered).toContain("job-7");
	});

	it("leaves a result that is not the gateway's envelope to the MCP card", () => {
		expect(capabilityRunCommandOutput(resultOf("plain text", false))).toBeUndefined();
		expect(capabilityRunCommandOutput(resultOf({ output: { status: "ok" } }, true))).toBeUndefined();
		expect(
			capabilityRunCommandRenderer.renderResult?.(
				{ content: [{ type: "text", text: "plain text" }], details: shellTool, isError: false },
				options,
				theme,
				{},
			),
		).toBeUndefined();
	});
});
