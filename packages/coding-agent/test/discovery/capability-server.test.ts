import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { mcpCapability, type MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import {
	CAPABILITY_SERVER_NAME,
	CAPABILITY_WAIT_TOOL_NAME,
} from "@oh-my-pi/pi-coding-agent/discovery/capability-server";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("built-in capability server lookup removed", () => {
	test("does not register a capability-native stdio MCP provider", async () => {
		expect(mcpCapability.providers.map(p => p.id)).not.toContain("capability-native");
		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: os.tmpdir(),
			providers: ["capability-native"],
		});
		expect(result.items.filter(s => s.name === CAPABILITY_SERVER_NAME)).toHaveLength(0);
	});
});

describe("capability server tool-name contract", () => {
	test("the snapshot publishes the wait under the name omp matches", () => {
		const fixture = path.join(import.meta.dir, "..", "fixtures", "capability-tools-list.jsonl");
		const names: string[] = [];
		for (const line of fs.readFileSync(fixture, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("//")) continue;
			const parsed = JSON.parse(trimmed) as { result?: { tools?: Array<{ name?: unknown }> } };
			for (const tool of parsed.result?.tools ?? []) {
				if (typeof tool.name === "string") names.push(tool.name);
			}
		}
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain(CAPABILITY_WAIT_TOOL_NAME);
		expect(names).not.toContain("wait");
	});
});
