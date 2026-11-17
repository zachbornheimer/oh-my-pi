import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { JOB_OWNER_BROKER_SOCK_ENV, JOB_OWNER_ENV, JOB_OWNER_JOBS_ROOT_ENV } from "../../src/tools/job-owner";

function toolSession(cwd: string, sessionId: string | undefined): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => sessionId,
		getSessionFile: () => null,
		settings: Settings.isolated({
			"launch.enabled": true,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: "/bin/sh",
		}),
	} as unknown as ToolSession;
}

const OWNER_ENV = [JOB_OWNER_ENV, JOB_OWNER_BROKER_SOCK_ENV, JOB_OWNER_JOBS_ROOT_ENV] as const;

describe("bash detached call under a broker job owner", () => {
	let directory: string;
	let record: string;
	const saved = new Map<string, string | undefined>();

	/** An owner that records exactly what it was given, so the test sees the contract, not the owner's internals. */
	async function installOwner(body: string): Promise<string> {
		const script = path.join(directory, "owner.sh");
		await Bun.write(script, `#!/bin/sh\n${body}\n`);
		await fs.chmod(script, 0o755);
		process.env[JOB_OWNER_ENV] = script;
		return script;
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-job-owner-"));
		record = path.join(directory, "record");
		for (const key of OWNER_ENV) saved.set(key, process.env[key]);
	});

	afterEach(async () => {
		for (const key of OWNER_ENV) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await removeWithRetries(directory);
	});

	it("hands the command to the owner as one argument, with the session, call and environment", async () => {
		await installOwner(
			[
				`printf '%s\\n' "$@" > '${record}'`,
				`pwd >> '${record}'`,
				`printf '%s|%s|%s\\n' "$BROKER_SOCK" "$JOBS_ROOT" "$PI_TOOL_CALL_ID" >> '${record}'`,
				`echo '${directory}/jobs/sess-1/call-1'`,
			].join("\n"),
		);
		process.env[JOB_OWNER_BROKER_SOCK_ENV] = "/run/broker.sock";
		process.env[JOB_OWNER_JOBS_ROOT_ENV] = `${directory}/jobs`;
		// A command that would run something else if it ever reached a shell between omp and the owner.
		const command = `echo "a b"; touch ${directory}/pwned $(id)`;

		const result = await new BashTool(toolSession(directory, "sess-1")).execute("call-1", {
			command,
			name: "nightly",
			detached: true,
		});

		const real = await fs.realpath(directory);
		expect((await Bun.file(record).text()).split("\n")).toEqual([
			"spawn",
			"sess-1",
			"call-1",
			command,
			real,
			`/run/broker.sock|${directory}/jobs|call-1`,
			"",
		]);
		expect(await Bun.file(path.join(directory, "pwned")).exists()).toBe(false);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain(`${directory}/jobs/sess-1/call-1`);
		expect(text).toContain("wakes this session");
	});

	it("surfaces the owner's refusal instead of reporting a job that never started", async () => {
		await installOwner(`echo "session id and tool call id must match the safe pattern" >&2\nexit 64`);
		await expect(
			new BashTool(toolSession(directory, "sess-1")).execute("bad/call", {
				command: "sleep 1",
				name: "nightly",
				detached: true,
			}),
		).rejects.toThrow("job owner refused the job: session id and tool call id must match the safe pattern");
	});

	it("refuses to start a job it could not wake when the session has no id", async () => {
		await installOwner(`echo ${directory}/jobs/x`);
		await expect(
			new BashTool(toolSession(directory, undefined)).execute("call-1", {
				command: "sleep 1",
				name: "nightly",
				detached: true,
			}),
		).rejects.toThrow("needs a session id");
		expect(await Bun.file(record).exists()).toBe(false);
	});
});
