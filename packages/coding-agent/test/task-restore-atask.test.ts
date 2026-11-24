import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { readAtaskTaskState, type RunAtaskTaskOptions } from "../src/task/atask";
import { readAtaskTaskRestore, recordAtaskTaskRestore, runRestoredAtaskTask } from "../src/task/atask-restore";
import * as executor from "../src/task/executor";
import { restoreSession } from "../src/task/restore";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const TEST_TIMEOUT_MS = 60_000;
const DISPOSE_TIMEOUT_MS = 1_000;
const EXECUTABLE_MODE = 0o700;
const WORKER_ID = "InterruptedNative";
const ENV_KEYS = [
	"ATASK_BIN",
	"ATASK_DB",
	"ATASK_DB_URL",
	"OMP_ATASK_STATE_DIR",
	"ATASK_RESTORE_BOARD",
	"ATASK_RESTORE_REJECT",
] as const;
const CLI_FIXTURE = `
const file = process.env.ATASK_RESTORE_BOARD;
let board;
try { board = await Bun.file(file).json(); } catch { board = { calls: [], tasks: {} }; }
const args = process.argv.slice(2).filter(arg => arg !== '--json');
const project = args.indexOf('--project');
if (project !== -1) args.splice(project, 2);
board.calls.push(args);
let result;
if (args[0] === 'project') result = { id: 'restore-project' };
if (args[0] === 'add') {
 const value = flag => args[args.indexOf(flag) + 1];
 const id = 'restore-task-' + (Object.keys(board.tasks).length + 1);
 const task = { id, status: 'ready', proof: {preset:'run',subject:value('--proof').slice(5)}, regression:{preset:'run',subject:value('--regression').slice(5)} };
 board.tasks[id] = task;
 result = { task };
}
if (args[0] === 'show') result = board.tasks[args[1]];
if (args[0] === 'claim' && args[1] !== 'renew') {
 const task = board.tasks[args[1]];
 task.status = 'claimed';
 result = { task, token: 'restore-claim', workspace: process.cwd() };
}
if (args[0] === 'claim' && args[1] === 'renew') result = { renewed: true };
if (args[0] === 'verify') {
 const task = Object.values(board.tasks).find(task => task.status === 'claimed');
 let passed = process.env.ATASK_RESTORE_REJECT !== '1';
 for (const spec of [task.proof, task.regression]) {
  if (!passed) break;
  const child = Bun.spawn(['sh','-c',spec.subject], {stdout:'pipe',stderr:'pipe'});
  const [, , code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  passed = code === 0;
 }
 if (passed) task.status = 'complete';
 result = { task_id: task.id, passed, completed: passed, status: task.status };
}
await Bun.write(file, JSON.stringify(board));
console.log(JSON.stringify(result === undefined ? {ok:false,error:{message:'restore fixture command failed'}} : {ok:true,result}));
if (result === undefined) process.exitCode = 1;
`;

interface RestoreBoard {
	calls: string[][];
	tasks: Record<string, { status: string }>;
}

let directory: string;
let boardFile: string;
let savedEnvironment: Map<string, string | undefined>;
let manager: AsyncJobManager | undefined;

beforeEach(async () => {
	savedEnvironment = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atask-restore-"));
	boardFile = path.join(directory, "board.json");
	const binary = path.join(directory, "atask-restore-fixture");
	await Bun.write(binary, `#!${process.execPath}\n${CLI_FIXTURE}`);
	await fs.chmod(binary, EXECUTABLE_MODE);
	process.env.ATASK_BIN = binary;
	process.env.ATASK_DB = path.join(directory, "isolated.db");
	process.env.OMP_ATASK_STATE_DIR = directory;
	process.env.ATASK_RESTORE_BOARD = boardFile;
	delete process.env.ATASK_DB_URL;
	delete process.env.ATASK_RESTORE_REJECT;
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await manager?.dispose({ timeoutMs: DISPOSE_TIMEOUT_MS });
	manager = undefined;
	AgentRegistry.resetGlobalForTests();
	for (const key of ENV_KEYS) {
		const value = savedEnvironment.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(directory, { recursive: true, force: true });
});

function lifecycleOptions(sessionId: string): RunAtaskTaskOptions {
	return {
		sessionId,
		key: `${sessionId}:repair`,
		name: "Restore invariant",
		task: "Write evidence.txt",
		cwd: directory,
		nativeId: WORKER_ID,
		proof: "run: test -f evidence.txt",
		regression: "run: test -d .",
	};
}

/** A separate owner exits inside its worker, leaving the real lifecycle state and lock on disk. */
async function interruptOwner(options: RunAtaskTaskOptions, liveChecks = false): Promise<void> {
	const lifecycleModule = path.resolve(import.meta.dir, "../src/task/atask.ts");
	const restoreModule = path.resolve(import.meta.dir, "../src/task/atask-restore.ts");
	const script = path.join(directory, "interrupted-owner.ts");
	await Bun.write(
		script,
		`
import { runAtaskTask } from ${JSON.stringify(lifecycleModule)};
import { recordAtaskTaskRestore } from ${JSON.stringify(restoreModule)};
const options = ${JSON.stringify(options)};
if (${liveChecks}) { delete options.proof; delete options.regression; options.checks = {proof: () => false, regression: () => true}; }
await recordAtaskTaskRestore(options);
await runAtaskTask(options, async () => { process.exit(0); });
throw new Error('interrupted owner never reached its worker');
`,
	);
	const owner = Bun.spawn([process.execPath, script], {
		cwd: directory,
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(owner.stdout).text(),
		new Response(owner.stderr).text(),
		owner.exited,
	]);
	if (exitCode !== 0) throw new Error(`Interrupted owner failed for ${options.nativeId}: ${stdout}\n${stderr}`);
	expect(await readAtaskTaskState(options)).toMatchObject({ phase: "running", nativeId: WORKER_ID });
}

async function interruptedSession(): Promise<{ session: AgentSession; options: RunAtaskTaskOptions }> {
	const main = SessionManager.create(directory, path.join(directory, "sessions"));
	main.appendMessage({ role: "user", content: "repair invariant", timestamp: Date.now() });
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Interrupted native fixture requires a persisted parent session");
	const options = lifecycleOptions(main.getSessionId());
	await main.close();
	const child = await SessionManager.open(
		path.join(mainFile.slice(0, -6), `${WORKER_ID}.jsonl`),
		undefined,
		undefined,
		{
			initialCwd: directory,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		},
	);
	child.appendSessionInit({
		systemPrompt: ["native restore fixture"],
		task: options.task,
		tools: ["read"],
		agent: "task",
	});
	child.appendMessage({ role: "user", content: options.task, timestamp: Date.now() });
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "interrupted-read", name: "read", arguments: { path: "evidence.txt" } }],
		api: "mock",
		provider: "mock",
		model: "restore-fixture",
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	await child.close();
	manager = new AsyncJobManager({});
	const session = {
		sessionManager: { getSessionFile: () => mainFile, getSessionId: () => options.sessionId },
		asyncJobManager: manager,
		settings: Settings.isolated(),
		restoreInterruptedTurn: async () => false,
		recheckNativeTaskHooks: async () => {},
	} as unknown as AgentSession;
	return { session, options };
}

function successfulWorker(): SingleResult {
	return {
		index: 0,
		id: WORKER_ID,
		agent: WORKER_ID,
		agentSource: "user",
		task: "Write evidence.txt",
		exitCode: 0,
		output: "worker exited successfully",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("restored native task authority", () => {
	test(
		"replays one interrupted worker and preserves its existing authoritative task without duplication",
		async () => {
			const { session, options } = await interruptedSession();
			await interruptOwner(options);
			const persisted = await readAtaskTaskState(options);
			const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async () => {
				await Bun.write(path.join(directory, "evidence.txt"), "verified evidence");
				return successfulWorker();
			});
			expect((await restoreSession(session)).subagents).toEqual([WORKER_ID]);
			expect((await restoreSession(session)).subagents).toEqual([]);
			await manager!.getJob(WORKER_ID)!.promise;
			expect(manager!.getJob(WORKER_ID)!.status).toBe("completed");
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(await readAtaskTaskState(options)).toMatchObject({ taskId: persisted!.taskId, phase: "complete" });
			const board: RestoreBoard = await Bun.file(boardFile).json();
			expect(board.calls.filter(call => call[0] === "add")).toHaveLength(1);
			expect(board.calls.filter(call => call[0] === "claim" && call[1] !== "renew")).toHaveLength(1);
			expect(board.calls.filter(call => call[0] === "verify")).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"successful restored worker exit cannot override authoritative verify false",
		async () => {
			const { session, options } = await interruptedSession();
			await interruptOwner(options);
			process.env.ATASK_RESTORE_REJECT = "1";
			const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(successfulWorker());
			await restoreSession(session);
			await manager!.getJob(WORKER_ID)!.promise;
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(manager!.getJob(WORKER_ID)!.status).toBe("failed");
			expect(await readAtaskTaskState(options)).toMatchObject({ phase: "failed" });
			const board: RestoreBoard = await Bun.file(boardFile).json();
			expect(Object.values(board.tasks).every(task => task.status !== "complete")).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a fresh parent holds live-check recovery until its stop hook re-registers callbacks",
		async () => {
			const { session, options } = await interruptedSession();
			await interruptOwner(options, true);
			const association = await readAtaskTaskRestore(options);
			expect(association).toMatchObject({ liveChecks: true, nativeId: WORKER_ID });
			let ready = false;
			const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async () => {
				ready = true;
				return successfulWorker();
			});
			const register = vi.fn(async () => {
				expect(manager!.getJob(WORKER_ID)).toBeDefined();
				expect(followUp).not.toHaveBeenCalled();
				await recordAtaskTaskRestore({
					...options,
					proof: undefined,
					regression: undefined,
					checks: { proof: async () => ready, regression: async () => true },
				});
			});
			session.recheckNativeTaskHooks = register;
			await restoreSession(session);
			await manager!.getJob(WORKER_ID)!.promise;
			expect(register).toHaveBeenCalledTimes(1);
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(manager!.getJob(WORKER_ID)!.status).toBe("completed");
			expect(await readAtaskTaskState(options)).toMatchObject({ phase: "complete" });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"missing callback registration remains held and aborts without starting a worker",
		async () => {
			const options = lifecycleOptions("unregistered-parent");
			await interruptOwner(options, true);
			const controller = new AbortController();
			const blocked = Promise.withResolvers<void>();
			const worker = vi.fn(async () => successfulWorker());
			const resumed = runRestoredAtaskTask(
				{
					sessionId: options.sessionId,
					nativeId: WORKER_ID,
					signal: controller.signal,
					onVerification: state => {
						if (state.status === "blocked") blocked.resolve();
					},
				},
				worker,
			);
			await blocked.promise;
			expect(worker).not.toHaveBeenCalled();
			const reason = new Error("Parent stopped before live checks re-registered");
			controller.abort(reason);
			await expect(resumed).rejects.toThrow(reason.message);
			expect(worker).not.toHaveBeenCalled();
		},
		TEST_TIMEOUT_MS,
	);

	test("missing durable authority fails closed rather than running an unverified worker", async () => {
		const worker = vi.fn(async () => successfulWorker());
		await expect(runRestoredAtaskTask({ sessionId: "missing-parent", nativeId: WORKER_ID }, worker)).rejects.toThrow(
			"verification association unavailable",
		);
		expect(worker).not.toHaveBeenCalled();
	});
});
