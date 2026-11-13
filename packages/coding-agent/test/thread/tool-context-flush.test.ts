import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { SessionManager } from "../../src/session/session-manager";
import { SqlSessionStorage } from "../../src/session/sql-session-storage";
import { toolContextCodec } from "../../src/thread/services/tool-context";
import { SQL } from "bun";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("tool context across a thread link", () => {
	it("flush() on the receiver's session view makes the sender's pending writes durable", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = path.resolve("/sessions/proj");
		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "pending" }],
			usage,
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = {
			sessionManager: manager,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as CustomToolContext;
		const received = toolContextCodec.decode(toolContextCodec.encode(ctx)) as CustomToolContext;

		await received.sessionManager.flush();

		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			manager.getSessionFile(),
		])) as Array<{ content: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toContain("pending");

		await manager.close();
		await client.end();
	});
});
