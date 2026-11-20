import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { spillUrl } from "@oh-my-pi/pi-utils";

function getTextOutput(result: AgentToolResult): string {
	const texts: string[] = [];
	for (const block of result.content) if (block.type === "text") texts.push(block.text);
	return texts.join("\n");
}

/**
 * A spill a pruned tool result still points at must answer a read: its bytes
 * while the file lives, and a notice naming the producing command once the
 * session holds none — never a bare "Local file not found".
 */
describe("read of a spill a pruned tool result points at", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-spill-reclaimed-"));
		manager = SessionManager.create(testDir, testDir);
	});

	afterEach(async () => {
		await manager.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function readSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => manager.getSessionFile(),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			getSessionId: () => manager.getSessionId(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
	}

	it("returns the bytes while the spill lives, then names the producing command once it is gone", async () => {
		// The session's first record materializes its file (and so its artifacts
		// root); a spill saved before that lands in the pre-materialization root.
		manager.appendMessage({ role: "user", content: "run the suite", timestamp: Date.now() } as never);

		const spillBody = Array.from({ length: 500 }, (_, index) => `spilled line ${index + 1}`).join("\n");
		const id = await manager.saveArtifact(spillBody);
		if (!id) throw new Error("Expected a spill id");

		// The transcript a prune leaves behind: the assistant call, its result
		// carrying the pointer, then the blanked (pruned) copy of that result.
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-bash-1", name: "bash", args: { command: "npm test" } }],
			timestamp: Date.now(),
		} as never);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-bash-1",
			toolName: "bash",
			content: [{ type: "text", text: `partial output…\nFull output: ${spillUrl(id)}` }],
			timestamp: Date.now(),
		} as never);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-bash-2",
			toolName: "bash",
			content: [{ type: "text", text: "[Output truncated - 900 tokens]" }],
			prunedAt: Date.now(),
			timestamp: Date.now(),
		} as never);

		const tool = new ReadTool(readSession());
		const head = getTextOutput(await tool.execute("call-read-1", { path: spillUrl(id) }));
		expect(head).toContain("spilled line 1");

		const spillPath = await manager.getArtifactPath(id);
		if (!spillPath) throw new Error("Expected the spill on disk");
		await fs.rm(spillPath);

		const bare = getTextOutput(await tool.execute("call-read-bare", { path: spillUrl(id) }));
		expect(bare).toContain(`local://${id}.log is gone or empty`);

		const reclaimed = getTextOutput(await tool.execute("call-read-2", { path: `${spillUrl(id)}:1-50` }));
		expect(reclaimed).toContain(`local://${id}.log is gone or empty`);
		expect(reclaimed).toContain("bash: npm test");
	});

	it("keeps a kept result's spill readable after the session branches onto a new file", async () => {
		manager.appendMessage({ role: "user", content: "run the suite", timestamp: Date.now() } as never);
		const spillBody = Array.from({ length: 200 }, (_, index) => `kept line ${index + 1}`).join("\n");
		const id = await manager.saveArtifact(spillBody);
		if (!id) throw new Error("Expected a spill id");
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-bash-1", name: "bash", args: { command: "npm test" } }],
			timestamp: Date.now(),
		} as never);
		const leafId = manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-bash-1",
			toolName: "bash",
			content: [{ type: "text", text: `[shaken ~900 tokens - recover: ${spillUrl(id)}]` }],
			prunedAt: Date.now(),
			timestamp: Date.now(),
		} as never);

		const before = manager.getSessionFile();
		// Default options: a branch keeps the pointer, so it must keep the bytes too.
		manager.createBranchedSession(leafId);
		expect(manager.getSessionFile()).not.toBe(before);
		await manager.flush();

		const tool = new ReadTool(readSession());
		const text = getTextOutput(await tool.execute("call-read-branched", { path: `${spillUrl(id)}:1-50` }));
		expect(text).toContain("kept line 1");
		expect(text).not.toContain("is gone or empty");
	});
});
