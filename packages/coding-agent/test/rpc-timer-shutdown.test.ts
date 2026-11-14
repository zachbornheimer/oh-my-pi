import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { ptree, removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC deferred shutdown", () => {
	test("a shutdown requested from a timer ends the process without any client frame", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-timer-shutdown-"));
		const fixture = path.join(import.meta.dir, "fixtures", "timer-shutdown-rpc-agent.ts");
		let agent: RpcAgentProcess | undefined;
		// The client holds stdin open and sends nothing: EOF would end the process by itself and prove nothing.
		const client = new RpcClient({
			spawn: agentArgs => {
				agent = ptree.spawn([process.execPath, fixture, ...agentArgs], {
					cwd: directory,
					env: { ...Bun.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
					stdin: "pipe",
				});
				return agent;
			},
		});
		try {
			await client.start();
			if (!agent) throw new Error("the client never spawned the fixture");
			// The bound only separates "never exits" from "exits"; a passing run returns as soon as the process ends.
			const outcome = await Promise.race([agent.exited, Bun.sleep(20_000).then(() => "still running" as const)]);
			expect(outcome).toBe(0);
		} finally {
			await client.stop();
			await removeWithRetries(directory);
		}
	}, 40_000);
});
