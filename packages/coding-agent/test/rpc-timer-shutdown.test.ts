import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function readExitCode(file: string, deadline: number): Promise<string | undefined> {
	while (Date.now() < deadline) {
		try {
			return await fs.readFile(file, "utf8");
		} catch {
			await Bun.sleep(50);
		}
	}
	return undefined;
}

describe("RPC deferred shutdown", () => {
	test("a shutdown requested from a timer ends the process without any client frame", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-timer-shutdown-"));
		// The client sends no frame and keeps stdin open: EOF would end the process by itself and prove nothing.
		const client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "timer-shutdown-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		try {
			await client.start();
			// The fixture writes its exit code when the process ends. The bound only separates "never exits" from
			// "exits"; a passing run returns as soon as the file appears.
			expect(await readExitCode(path.join(directory, "exit-code"), Date.now() + 20_000)).toBe("0");
		} finally {
			await client.stop();
			await removeWithRetries(directory);
		}
	}, 40_000);
});
