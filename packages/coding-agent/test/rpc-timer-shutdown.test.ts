import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("RPC deferred shutdown", () => {
	test("a shutdown requested from a timer ends the process without any client frame", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-timer-shutdown-"));
		// stdin stays open and silent: EOF would end the process by itself and prove nothing.
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "timer-shutdown-rpc-agent.ts")], {
			cwd: directory,
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			// The bound only separates "never exits" from "exits"; a passing run returns as soon as the process ends.
			const outcome = await Promise.race([child.exited, Bun.sleep(20_000).then(() => "still running" as const)]);
			expect(outcome).toBe(0);
		} finally {
			child.kill();
			await child.exited;
			await removeWithRetries(directory);
		}
	}, 40_000);
});
