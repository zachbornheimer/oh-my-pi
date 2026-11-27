import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import {
	AtaskPendingCompletionError,
	runAtaskTask,
	type AtaskTaskLifecycleState,
	type RunAtaskTaskOptions,
} from "../src/task/atask";
import { registerAtaskChecks, requestAtaskCheck, runAtaskCheckRunner } from "../src/task/atask-check";

const TIMEOUT_MS = 60_000;
const ENV_KEYS = [
	"ATASK_BIN",
	"ATASK_DB",
	"ATASK_DB_URL",
	"ATASK_PROJECT",
	"ATASK_SESSION",
	"OMP_ATASK_STATE_DIR",
	"ATASK_FIXTURE",
	"ATASK_FAIL_COMPLETE",
] as const;
const originalEnvironment = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
const realAtask = process.env.ATASK_BIN || $which("atask");
let directory: string;
let fixture: string;
let binary: string;

// Exercise the real CLI subprocess/envelope boundary without touching a user's board.
const CLI_FIXTURE = `
const file = process.env.ATASK_FIXTURE;
let board;
try { board = await Bun.file(file).json(); } catch { board = { calls: [], tasks: {} }; }
const args = process.argv.slice(2).filter(arg => arg !== '--json');
const p = args.indexOf('--project');
if (p !== -1) args.splice(p, 2);
board.calls.push({ args, session: process.env.ATASK_SESSION, home: process.env.HOME });
const command = args[0];
let result;
if (command === 'project') result = { id: 'proj-fixture' };
if (command === 'add') {
 const flag = name => args[args.indexOf(name) + 1];
 const outcome = flag('--outcome');
 if (outcome.length > 4000) { console.log(JSON.stringify({ok:false,error:{message:'outcome must be at most 4000 characters'}})); process.exitCode=1; process.exit(); }
 const id = 'at-fixture-' + (Object.keys(board.tasks).length + 1);
 const task = { id, status: 'ready', outcome, proof: {preset:'run',subject:flag('--proof').slice(5)}, regression:{preset:'run',subject:flag('--regression').slice(5)} };
 board.tasks[id] = task;
 result = { task };
}
if (command === 'show') result = board.tasks[args[1]];
if (command === 'claim' && args[1] !== 'renew') {
 const task = board.tasks[args[1]];
 task.status = 'claimed';
 result = { task, token: 'sess-fixture-child', workspace: process.cwd() };
}
if (command === 'claim' && args[1] === 'renew') result = { renewed: true };
if (command === 'verify') {
 const task = Object.values(board.tasks).find(task => task.status === 'claimed');
 let passed = process.env.ATASK_FAIL_COMPLETE !== '1';
 if (passed) {
  for (const spec of [task.proof, task.regression]) {
   const child = Bun.spawn(['sh', '-c', spec.subject], { stdout:'pipe', stderr:'pipe' });
   const [, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
   if (code !== 0) { passed = false; break; }
  }
 }
 if (passed) task.status = 'complete';
 result = { task_id:task.id, passed, completed:passed, status:task.status };
}
await Bun.write(file, JSON.stringify(board));
if (command === 'claim' && args[1] === 'renew' && board.failRenew) { console.log(JSON.stringify({ok:false,error:{message:'claim ownership lost'}})); process.exitCode=1; }
else if (result === undefined) { console.log(JSON.stringify({ok:false,error:{message:'missing fixture task'}})); process.exitCode=1; }
else console.log(JSON.stringify({ok:true,result}));
`;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atask-test-"));
	fixture = path.join(directory, "board.json");
	binary = path.join(directory, "atask-fixture");
	await Bun.write(binary, `#!${process.execPath}\n${CLI_FIXTURE}`);
	await fs.chmod(binary, 0o700);
	process.env.ATASK_BIN = binary;
	process.env.ATASK_FIXTURE = fixture;
	process.env.OMP_ATASK_STATE_DIR = directory;
	process.env.ATASK_DB = path.join(directory, "isolated.db");
	delete process.env.ATASK_DB_URL;
	delete process.env.ATASK_FAIL_COMPLETE;
	process.env.ATASK_SESSION = "sess-parent-must-not-leak";
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = originalEnvironment.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(directory, { recursive: true, force: true });
});

function options(overrides: Partial<RunAtaskTaskOptions> = {}): RunAtaskTaskOptions {
	return {
		sessionId: "test-session",
		key: crypto.randomUUID(),
		name: "Produce evidence",
		task: "Write the requested evidence",
		cwd: directory,
		nativeId: "native-test",
		...overrides,
	};
}

interface Board {
	calls: { args: string[]; session?: string; home?: string }[];
	tasks: Record<string, { status: string }>;
}

async function board(): Promise<Board> {
	return Bun.file(fixture).json();
}

async function persistedStatePath(): Promise<string> {
	const stateDirectory = path.join(directory, "native-atask");
	const files = await fs.readdir(stateDirectory);
	return path.join(
		stateDirectory,
		files.find(file => file.endsWith(".json"))!,
	);
}

/** Emulate an external durable adapter completing the filed task after the live check bridge died. */
async function completeBoardTask(id: string): Promise<void> {
	const current = await board();
	current.calls = [];
	current.tasks[id].status = "complete";
	await Bun.write(fixture, JSON.stringify(current));
}

describe("authoritative atask native lifecycle", () => {
	test("requires explicit checks instead of treating worker exit as proof", async () => {
		await expect(runAtaskTask(options(), async () => "worker")).rejects.toThrow("requires explicit proof");
		expect(await Bun.file(fixture).exists()).toBe(false);
	});

	test("short circuits proof and does not file already satisfied work", async () => {
		const observed: string[] = [];
		const checks = {
			proof: async () => {
				observed.push("proof");
				return true;
			},
			regression: async () => {
				observed.push("regression");
				return true;
			},
		};
		const result = await runAtaskTask(options({ checks }), async () => {
			throw new Error("unexpected worker");
		});
		expect(result).toBeUndefined();
		expect(observed).toEqual(["proof", "regression"]);
		expect(await Bun.file(fixture).exists()).toBe(false);
	});

	test("runs live closures through stored named runner and keeps parent session private", async () => {
		let ready = false;
		const observed: string[] = [];
		const input = options({
			checks: {
				proof: async () => {
					observed.push("proof");
					return ready;
				},
				regression: async () => {
					observed.push("regression");
					return ready;
				},
			},
		});
		const result = await runAtaskTask(input, async (assignment, workspace, taskId) => {
			expect(assignment).toContain(taskId);
			expect(await fs.realpath(workspace)).toBe(await fs.realpath(directory));
			expect(observed).toEqual(["proof"]);
			ready = true;
			return "native output";
		});
		expect(result).toBe("native output");
		expect(observed).toEqual(["proof", "proof", "regression"]);
		const state = await board();
		expect(Object.values(state.tasks)[0].status).toBe("complete");
		for (const call of state.calls) {
			expect(call.session).not.toBe("sess-parent-must-not-leak");
			expect(call.home).toBe(process.env.HOME);
		}
		expect(process.env.ATASK_SESSION).toBe("sess-parent-must-not-leak");
		const states = await fs.readdir(path.join(directory, "native-atask"));
		const persisted = await Bun.file(
			path.join(
				directory,
				"native-atask",
				states.find(file => file.endsWith(".json"))!,
			),
		).json();
		expect(persisted.taskId).toBe("at-fixture-1");
		expect(persisted.nativeId).toBe(input.nativeId);
		expect(persisted.phase).toBe("complete");
	});

	test("rejects authoritative completion failure after a successful native worker", async () => {
		process.env.ATASK_FAIL_COMPLETE = "1";
		const states: AtaskTaskLifecycleState[] = [];
		await expect(
			runAtaskTask(
				options({
					proof: "run: test -f evidence",
					regression: "run: test -s evidence",
					onVerification: state => states.push(state),
				}),
				async () => "successful exit",
			),
		).rejects.toThrow("completion failed");
		expect(Object.values((await board()).tasks)[0].status).not.toBe("complete");
		expect(states.some(state => state.backend === "local")).toBe(false);
	});

	test("deduplicates concurrent callers and preserves the native result", async () => {
		let workers = 0;
		const { promise, resolve } = Promise.withResolvers<void>();
		const input = options({ proof: "run: test -f evidence", regression: "run: test -s evidence" });
		const body = async () => {
			workers++;
			await promise;
			await Bun.write(path.join(directory, "evidence"), "ready");
			return "result";
		};
		const first = runAtaskTask(input, body);
		const second = runAtaskTask(input, body);
		expect(first).toBe(second);
		resolve();
		expect(await first).toBe("result");
		expect(workers).toBe(1);
		expect(Object.keys((await board()).tasks)).toHaveLength(1);
	});

	test("worker failure never calls completion and closures must re-register", async () => {
		const input = options({ checks: { proof: async () => false, regression: async () => false } });
		await expect(
			runAtaskTask(input, async () => {
				throw new Error("worker blocked");
			}),
		).rejects.toThrow("worker blocked");
		expect((await board()).calls.some(call => call.args[0] === "verify")).toBe(false);
		await expect(
			runAtaskTask({ ...input, checks: undefined, taskId: "at-fixture-1" }, async () => "no"),
		).rejects.toThrow("checks changed");
	});

	test("files a bounded outcome for a very long assignment and still hands the worker the whole text", async () => {
		const long = `Rewrite ops.ts.\n${"finding detail ".repeat(2000)}\nEND-OF-ASSIGNMENT`;
		expect(long.length).toBeGreaterThan(20_000);
		const result = await runAtaskTask(
			options({ task: long, proof: "run: test -f evidence", regression: "run: test -s evidence" }),
			async assignment => {
				// The worker still gets the full caller instructions, not the truncated outcome.
				expect(assignment).toContain("END-OF-ASSIGNMENT");
				await Bun.write(path.join(directory, "evidence"), "ready");
				return "long result";
			},
		);
		expect(result).toBe("long result");
		const added = (await board()).calls.find(call => call.args[0] === "add");
		const outcome = added?.args[added.args.indexOf("--outcome") + 1] ?? "";
		expect(outcome.length).toBeGreaterThan(0);
		expect(outcome.length).toBeLessThanOrEqual(4000);
		expect(outcome.startsWith("Rewrite ops.ts.")).toBe(true);
	});

	test("attaches an existing objective without replacing its checks", async () => {
		await Bun.write(
			fixture,
			JSON.stringify({
				calls: [],
				tasks: {
					"at-existing": {
						id: "at-existing",
						outcome: "Authoritative stored outcome",
						status: "ready",
						proof: { preset: "run", subject: "test -f evidence" },
						regression: { preset: "run", subject: "test -s evidence" },
					},
				},
			}),
		);
		const result = await runAtaskTask(
			options({ taskId: "at-existing", task: "Supplemental caller guidance" }),
			async assignment => {
				expect(assignment).toContain("Authoritative stored outcome");
				expect(assignment).toContain("test -f evidence");
				expect(assignment).toContain("test -s evidence");
				expect(assignment).toContain("Supplemental caller guidance");
				await Bun.write(path.join(directory, "evidence"), "existing objective evidence");
				return "attached result";
			},
		);
		expect(result).toBe("attached result");
		const state = await board();
		expect(state.calls.some(call => call.args[0] === "add" || call.args[0] === "update")).toBe(false);
		expect(state.tasks["at-existing"].status).toBe("complete");
	});

	test(
		"losing the claim aborts the running worker and preserves the ownership blocker",
		async () => {
			await Bun.write(fixture, JSON.stringify({ calls: [], tasks: {}, failRenew: true }));
			const originalInterval = globalThis.setInterval;
			const interval = spyOn(globalThis, "setInterval").mockImplementation(((
				handler: (...args: unknown[]) => void,
				_delay?: number,
				...args: unknown[]
			) => originalInterval(handler, 10, ...args)) as typeof setInterval);
			let workerAborted = false;
			try {
				await expect(
					runAtaskTask(
						options({ proof: "run: test -f evidence", regression: "run: test -s evidence" }),
						async (_assignment, _workspace, _taskId, workerSignal) => {
							const completion = Promise.withResolvers<string>();
							workerSignal.addEventListener(
								"abort",
								() => {
									workerAborted = true;
									completion.reject(new Error("native worker aborted"));
								},
								{ once: true },
							);
							return completion.promise;
						},
					),
				).rejects.toThrow("claim ownership lost");
				expect(workerAborted).toBe(true);
				expect((await board()).calls.some(call => call.args[0] === "verify")).toBe(false);
			} finally {
				interval.mockRestore();
			}
		},
		TIMEOUT_MS,
	);

	test("renews a completed invariant as a new durable generation", async () => {
		let ready = false;
		const input = options({ checks: { proof: async () => ready, regression: async () => ready } });
		const work = async () => {
			ready = true;
			return "evidence";
		};
		await runAtaskTask(input, work);
		ready = false;
		await runAtaskTask(input, work);
		expect(Object.keys((await board()).tasks)).toHaveLength(2);
	});

	test("requires explicit recovery and re-registers a restarted native owner", async () => {
		let ready = false;
		const input = options({ checks: { proof: async () => ready, regression: async () => ready } });
		await expect(
			runAtaskTask(input, async () => {
				throw new Error("interrupted native job");
			}),
		).rejects.toThrow("interrupted native job");
		const stateDirectory = path.join(directory, "native-atask");
		const files = await fs.readdir(stateDirectory);
		const statePath = path.join(
			stateDirectory,
			files.find(file => file.endsWith(".json"))!,
		);
		const state = await Bun.file(statePath).json();
		state.phase = "running";
		await Bun.write(statePath, JSON.stringify(state));
		let workers = 0;
		const body = async () => {
			workers++;
			ready = true;
			return "recovered";
		};
		await expect(runAtaskTask(input, body)).rejects.toThrow("attach that job");
		expect(workers).toBe(0);
		expect(await runAtaskTask({ ...input, nativeId: "recovered-native", recoverStaleOwner: true }, body)).toBe(
			"recovered",
		);
		expect(workers).toBe(1);
		expect(Object.keys((await board()).tasks)).toHaveLength(1);
	});

	test("bundled CommonJS check runner preserves proof and regression exit codes", async () => {
		const root = await fs.mkdtemp("/tmp/omp-atask-bundle-test-");
		const socket = path.join(root, "check.sock");
		const bridge = await registerAtaskChecks(socket, "bundle-key", {
			proof: async () => true,
			regression: async () => false,
		});
		try {
			const entrypoint = path.join(root, "entry.cjs");
			const outfile = path.join(root, "runner.cjs");
			const source = path.resolve(import.meta.dir, "../src/task/atask-check.ts");
			await fs.writeFile(entrypoint, `module.exports = require(${JSON.stringify(source)});`);
			const built = await Bun.build({ entrypoints: [entrypoint], format: "cjs", target: "bun" });
			expect(built.success).toBe(true);
			await Bun.write(outfile, built.outputs[0]);
			const bundled = await import(outfile);
			expect(await bundled.runAtaskCheckRunner([socket, "bundle-key", "proof"])).toBe(0);
			expect(await bundled.runAtaskCheckRunner([socket, "bundle-key", "regression"])).toBe(1);
		} finally {
			bridge.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("closed endpoints fail and re-registration uses the same named endpoint", async () => {
		const socketDirectory = await fs.mkdtemp("/tmp/omp-atask-check-test-");
		const socket = path.join(socketDirectory, "check.sock");
		try {
			const first = await registerAtaskChecks(socket, "live-key", {
				proof: async () => true,
				regression: async () => false,
			});
			expect(await requestAtaskCheck(socket, "live-key", "proof")).toBe(true);
			expect(await requestAtaskCheck(socket, "live-key", "regression")).toBe(false);
			first.close();
			expect(await runAtaskCheckRunner([socket, "live-key", "proof"])).toBe(1);
			await fs.rm(socket, { force: true });
			const second = await registerAtaskChecks(socket, "live-key", {
				proof: async () => false,
				regression: async () => true,
			});
			try {
				expect(await requestAtaskCheck(socket, "live-key", "proof")).toBe(false);
			} finally {
				second.close();
			}
		} finally {
			await fs.rm(socketDirectory, { recursive: true, force: true });
		}
	});

	test("aborted callbacks remain unavailable", async () => {
		const socketDirectory = await fs.mkdtemp("/tmp/omp-atask-check-abort-");
		const controller = new AbortController();
		const pending = Promise.withResolvers<boolean>();
		const bridge = await registerAtaskChecks(
			path.join(socketDirectory, "check.sock"),
			"abort-key",
			{ proof: () => pending.promise, regression: async () => false },
			controller.signal,
		);
		try {
			const checking = bridge.check("proof");
			controller.abort();
			await expect(checking).rejects.toThrow("unavailable or timed out");
		} finally {
			bridge.close();
			await fs.rm(socketDirectory, { recursive: true, force: true });
		}
	});

	test("missing atask verifies real commands locally and reports provenance", async () => {
		process.env.ATASK_BIN = path.join(directory, "missing-atask");
		const states: AtaskTaskLifecycleState[] = [];
		const result = await runAtaskTask(
			options({
				proof: "run: test -f evidence",
				regression: "run: test -s evidence",
				onVerification: state => states.push(state),
			}),
			async (assignment, workspace, taskId) => {
				expect(assignment).toContain("local proof and regression");
				expect(taskId.startsWith("local-")).toBe(true);
				await Bun.write(path.join(workspace, "evidence"), "locally verified evidence");
				return "local result";
			},
		);
		expect(result).toBe("local result");
		expect(states.at(-1)?.backend).toBe("local");
		expect(states.at(-1)?.status).toBe("verified");
		expect(await Bun.file(fixture).exists()).toBe(false);
	});

	test("unsupported old CLI capability uses local checks", async () => {
		await Bun.write(
			binary,
			`#!${process.execPath}\nconsole.log(JSON.stringify({ok:false,error:{message:'unknown command project'}})); process.exitCode=1;`,
		);
		const states: AtaskTaskLifecycleState[] = [];
		const result = await runAtaskTask(
			options({
				proof: "run: test -f evidence",
				regression: "run: test -s evidence",
				onVerification: state => states.push(state),
			}),
			async () => {
				await Bun.write(path.join(directory, "evidence"), "old binary fallback");
				return "verified locally";
			},
		);
		expect(result).toBe("verified locally");
		expect(states.at(-1)?.backend).toBe("local");
	});

	test("local closure short circuit and concurrent execution preserve verification", async () => {
		process.env.ATASK_BIN = path.join(directory, "missing-atask");
		let ready = false;
		let regressions = 0;
		let workers = 0;
		const states: AtaskTaskLifecycleState[] = [];
		const input = options({
			checks: {
				proof: async () => ready,
				regression: async () => {
					regressions++;
					return ready;
				},
			},
			onVerification: state => states.push(state),
		});
		const body = async () => {
			workers++;
			ready = true;
			return "local closure result";
		};
		const first = runAtaskTask(input, body);
		const second = runAtaskTask(input, body);
		expect(first).toBe(second);
		expect(await first).toBe("local closure result");
		expect(workers).toBe(1);
		expect(regressions).toBe(1);
		expect(await runAtaskTask(input, body)).toBeUndefined();
		expect(workers).toBe(1);
		expect(states.at(-1)?.status).toBe("verified");
		expect(states.at(-1)?.backend).toBe("local");
	});

	test("missing atask does not accept successful workers without proof and regression", async () => {
		process.env.ATASK_BIN = path.join(directory, "missing-atask");
		await expect(
			runAtaskTask(
				options({ proof: "run: test -f never-written", regression: "run: test -f also-missing" }),
				async () => "successful worker",
			),
		).rejects.toThrow("proof or regression failed");
	});

	test("local regression failure blocks even when proof passes", async () => {
		process.env.ATASK_BIN = path.join(directory, "missing-atask");
		await Bun.write(path.join(directory, "evidence"), "proof evidence");
		await expect(
			runAtaskTask(
				options({ proof: "run: test -s evidence", regression: "run: test -f regression-marker" }),
				async () => "worker",
			),
		).rejects.toThrow("proof or regression failed");
	});

	test("unsupported local presets fail actionably instead of passing", async () => {
		process.env.ATASK_BIN = path.join(directory, "missing-atask");
		await expect(
			runAtaskTask(options({ proof: "go_test: ./...", regression: "run: test -f evidence" }), async () => "never"),
		).rejects.toThrow("does not support check");
	});

	test("existing atask objective stays blocked after local verification", async () => {
		process.env.ATASK_BIN = path.join(directory, "missing-atask");
		const states: AtaskTaskLifecycleState[] = [];
		await expect(
			runAtaskTask(
				options({
					taskId: "at-existing",
					proof: "run: test -f evidence",
					regression: "run: test -s evidence",
					onVerification: state => states.push(state),
				}),
				async () => {
					await Bun.write(path.join(directory, "evidence"), "local only");
					return "worker";
				},
			),
		).rejects.toBeInstanceOf(AtaskPendingCompletionError);
		expect(states.at(-1)?.status).toBe("blocked");
		expect(states.at(-1)?.backend).toBe("local");
		expect(states.at(-1)?.taskId).toBe("at-existing");
	});

	test("atask storage failures never fall back", async () => {
		await Bun.write(
			binary,
			`#!${process.execPath}\nconsole.log(JSON.stringify({ok:false,error:{message:'database connection unavailable'}})); process.exitCode=1;`,
		);
		let workers = 0;
		const states: AtaskTaskLifecycleState[] = [];
		await expect(
			runAtaskTask(
				options({
					proof: "run: test -f evidence",
					regression: "run: test -s evidence",
					onVerification: state => states.push(state),
				}),
				async () => {
					workers++;
					return "no";
				},
			),
		).rejects.toThrow("database connection unavailable");
		expect(workers).toBe(0);
		expect(states.some(state => state.backend === "local")).toBe(false);
	});

	test("migrates a completed live-check task to its durable declaration only when current closures pass", async () => {
		const key = crypto.randomUUID();
		const live = { proof: async () => false, regression: async () => false };
		await expect(
			runAtaskTask(options({ key, checks: live }), async () => {
				throw new Error("worker blocked");
			}),
		).rejects.toThrow("worker blocked");
		const statePath = await persistedStatePath();
		expect(await Bun.file(statePath).json()).toMatchObject({
			taskId: "at-fixture-1",
			phase: "failed",
			liveChecks: true,
		});
		await completeBoardTask("at-fixture-1");

		const durable = "run: test -f evidence";
		const observed: string[] = [];
		const reconcileChecks = {
			proof: async () => {
				observed.push("proof");
				return true;
			},
			regression: async () => {
				observed.push("regression");
				return true;
			},
		};
		expect(
			await runAtaskTask(options({ key, proof: durable, regression: durable, reconcileChecks }), async () => {
				throw new Error("unexpected worker");
			}),
		).toBeUndefined();
		expect(observed).toEqual(["proof", "regression"]);
		const migrated = await Bun.file(statePath).json();
		expect(migrated).toMatchObject({
			taskId: "at-fixture-1",
			phase: "complete",
			liveChecks: false,
			proof: durable,
			regression: durable,
		});
		const calls = (await board()).calls;
		expect(calls.some(call => call.args[0] === "add")).toBe(false);
		expect(calls.some(call => call.args[0] === "claim")).toBe(false);
		expect(calls.some(call => call.args[0] === "verify")).toBe(false);

		// A repeated durable dispatch of the same completed task settles again without a new generation.
		expect(
			await runAtaskTask(options({ key, proof: durable, regression: durable, reconcileChecks }), async () => {
				throw new Error("unexpected worker");
			}),
		).toBeUndefined();
		const repeated = await board();
		expect(Object.keys(repeated.tasks)).toHaveLength(1);
		expect(repeated.calls.some(call => call.args[0] === "add")).toBe(false);
	});

	test("a completed task whose current closure fails renews under the durable declaration", async () => {
		const key = crypto.randomUUID();
		const live = { proof: async () => false, regression: async () => false };
		await expect(
			runAtaskTask(options({ key, checks: live }), async () => {
				throw new Error("worker blocked");
			}),
		).rejects.toThrow("worker blocked");
		await completeBoardTask("at-fixture-1");
		const durable = "run: test -f evidence";
		const result = await runAtaskTask(
			options({
				key,
				proof: durable,
				regression: durable,
				reconcileChecks: {
					proof: async () => false,
					regression: async () => false,
				},
			}),
			async () => {
				await Bun.write(path.join(directory, "evidence"), "renewed under the durable declaration");
				return "renewed";
			},
		);
		expect(result).toBe("renewed");
		const state = await board();
		expect(Object.keys(state.tasks)).toHaveLength(2);
		expect(state.calls.some(call => call.args[0] === "add")).toBe(true);
		expect(state.calls.some(call => call.args[0] === "verify")).toBe(true);
		const persisted = await Bun.file(await persistedStatePath()).json();
		expect(persisted).toMatchObject({ phase: "complete", liveChecks: false, proof: durable, regression: durable });
	});

	test("a completed task without current closures never adopts a changed declaration", async () => {
		const key = crypto.randomUUID();
		const live = { proof: async () => false, regression: async () => false };
		await expect(
			runAtaskTask(options({ key, checks: live }), async () => {
				throw new Error("worker blocked");
			}),
		).rejects.toThrow("worker blocked");
		await completeBoardTask("at-fixture-1");
		const durable = "run: test -f evidence";
		await expect(
			runAtaskTask(options({ key, proof: durable, regression: durable }), async () => "no"),
		).rejects.toThrow("checks changed");
	});

	test("a pending task with a changed declaration still refuses to weaken stored checks", async () => {
		const key = crypto.randomUUID();
		const live = { proof: async () => false, regression: async () => false };
		await expect(
			runAtaskTask(options({ key, checks: live }), async () => {
				throw new Error("worker blocked");
			}),
		).rejects.toThrow("worker blocked");
		const durable = "run: test -f evidence";
		await expect(
			runAtaskTask(
				options({
					key,
					proof: durable,
					regression: durable,
					reconcileChecks: { proof: async () => true, regression: async () => true },
				}),
				async () => "no",
			),
		).rejects.toThrow("checks changed");
	});

	test.skipIf(!realAtask)(
		"completes an isolated real rootless atask board",
		async () => {
			if (!realAtask) throw new Error("Real atask binary unavailable");
			process.env.ATASK_BIN = realAtask;
			delete process.env.ATASK_FIXTURE;
			const input = options({ proof: "run: test -f evidence", regression: "run: test -s evidence" });
			const result = await runAtaskTask(input, async (_assignment, workspace) => {
				await Bun.write(path.join(workspace, "evidence"), "real rootless evidence");
				return "real result";
			});
			expect(result).toBe("real result");
			expect(await Bun.file(process.env.ATASK_DB!).exists()).toBe(true);
		},
		TIMEOUT_MS,
	);
});
