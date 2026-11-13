import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createTestSession(disabled: string[], overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "",
		settings: Settings.isolated({ "tools.disabled": disabled, "tools.xdev": false }),
		...overrides,
	};
}

describe("tools.disabled", () => {
	it("removes disabled built-ins from the default plan, registry, and tool list", async () => {
		const session = createTestSession(["write", "edit"]);
		const plan = await resolveBuiltinToolPlan(session);
		expect(plan.names).not.toContain("write");
		expect(plan.names).not.toContain("edit");
		expect(plan.isAllowed("write")).toBe(false);
		expect(plan.isAllowed("edit")).toBe(false);
		expect(plan.isAllowed("read")).toBe(true);

		const tools = await createTools(session);
		expect(tools.map(tool => tool.name)).not.toContain("write");
		expect(tools.map(tool => tool.name)).not.toContain("edit");
		expect(session.toolRegistry?.has("write")).toBe(false);
		expect(session.toolRegistry?.has("edit")).toBe(false);
	});

	it("keeps disabled names out of explicit tool lists and the registry", async () => {
		const session = createTestSession(["write"], { enableLsp: false, skipPythonPreflight: true });
		const tools = await createTools(session, ["read", "write", "grep"]);
		expect(tools.map(tool => tool.name)).toEqual(["read", "grep"]);
		expect(session.toolRegistry?.has("write")).toBe(false);
		expect(session.toolRegistry?.has("read")).toBe(true);
	});

	it("changes nothing for sessions without the setting", async () => {
		const session = createTestSession([], { enableLsp: false, skipPythonPreflight: true });
		const tools = await createTools(session, ["read", "write"]);
		expect(tools.map(tool => tool.name)).toContain("write");
		expect(session.toolRegistry?.has("write")).toBe(true);
	});

	it("does not grant a device-only write transport for a disabled write", async () => {
		const session = createTestSession(["write"], {
			enableLsp: false,
			skipPythonPreflight: true,
			settings: Settings.isolated({ "tools.disabled": ["write"], "tools.xdev": true }),
		});
		const tools = await createTools(session, ["read"]);
		expect(tools.map(tool => tool.name)).not.toContain("write");
		expect(session.toolRegistry?.has("write")).toBe(false);
		expect(session.deviceOnlyWrite).toBeUndefined();
	});
});
