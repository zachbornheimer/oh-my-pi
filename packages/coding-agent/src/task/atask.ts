import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { $which, isEexist, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import taskPrompt from "../prompts/system/atask-task.md" with { type: "text" };
import { writeFileAtomically } from "../utils/atomic-file";
import { runForgeCli } from "../utils/forge-cli";
import { assertOwnerPrivateDir } from "../utils/owner-private-dir";
import { ATASK_CHECK_SELECTOR, type AtaskCheckBridge, type AtaskChecks, registerAtaskChecks } from "./atask-check";

const CLI_TIMEOUT_MS = 960_000;
const RENEW_INTERVAL_MS = 30_000;
const STATE_VERSION = 1;
const FIRST_GENERATION = 1;
const DIGEST_LENGTH = 32;
const inflight = new Map<string, Promise<unknown>>();
/** The atask board refuses an outcome longer than this; the stored outcome is a summary, the worker gets the whole text. */
const ATASK_OUTCOME_MAX_CHARS = 4000;
const OUTCOME_TRUNCATION_MARK = " [full assignment in the worker instructions]";

/**
 * The bounded outcome filed on the board for a task whose assignment may be arbitrarily long: the leading
 * text up to the limit, marked when cut. The full assignment still reaches the worker as its supplemental
 * instructions, so nothing the worker needs is lost.
 */
export function boundedAtaskOutcome(assignment: string): string {
	if (assignment.length <= ATASK_OUTCOME_MAX_CHARS) return assignment;
	const budget = ATASK_OUTCOME_MAX_CHARS - OUTCOME_TRUNCATION_MARK.length;
	// Cut on a line boundary when one is near the end of the budget, and never split a surrogate pair.
	let cut = assignment.lastIndexOf("\n", budget);
	if (cut < budget / 2) cut = budget;
	const code = assignment.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
	return assignment.slice(0, cut).trimEnd() + OUTCOME_TRUNCATION_MARK;
}

export interface AtaskTaskLifecycleState {
	backend: "atask" | "local";
	status: "running" | "verified" | "blocked";
	taskId?: string;
	localTaskId?: string;
	reason?: string;
}

export class AtaskPendingCompletionError extends Error {
	constructor(
		readonly taskId: string,
		readonly localTaskId: string,
		reason: string,
	) {
		super(`Task ${taskId} is locally verified but atask completion is pending: ${reason}`);
		this.name = "AtaskPendingCompletionError";
	}
}

class AtaskCapabilityUnavailableError extends Error {}

const LOCAL_CHECK_TIMEOUT_MS = 25_000;

export interface RunAtaskTaskOptions {
	sessionId: string;
	key: string;
	name: string;
	task: string;
	cwd: string;
	nativeId: string;
	checks?: AtaskChecks;
	proof?: string;
	regression?: string;
	taskId?: string;
	signal?: AbortSignal;
	onVerification?: (state: AtaskTaskLifecycleState) => void;
	/** Only after the native runtime has determined the old job cannot be attached. */
	recoverStaleOwner?: boolean;
}

interface TaskView {
	id: string;
	status: string;
	outcome?: string;
	title?: string;
	proof?: { preset: string; subject: string };
	regression?: { preset: string; subject: string };
}

interface Claim {
	task: TaskView;
	token: string;
	workspace?: string;
}

interface TaskState {
	version: number;
	sessionId: string;
	key: string;
	generation: number;
	taskId?: string;
	nativeId: string;
	project?: string;
	token?: string;
	workspace?: string;
	proof?: string;
	regression?: string;
	backend?: "atask" | "local";
	localTaskId?: string;
	fallbackReason?: string;
	locallyVerified?: boolean;
	liveChecks: boolean;
	phase: "planned" | "running" | "failed" | "complete";
}

interface Owner {
	pid: number;
	nativeId: string;
	taskId?: string;
}

export class AtaskTaskAttachedError extends Error {
	constructor(
		readonly taskId: string | undefined,
		readonly nativeId: string,
	) {
		super(
			`Atask task ${taskId ?? "being planned"} is attached to native job ${nativeId}; attach that job instead of spawning another worker`,
		);
		this.name = "AtaskTaskAttachedError";
	}
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, DIGEST_LENGTH);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readState(file: string): Promise<TaskState | undefined> {
	try {
		const state = (await Bun.file(file).json()) as TaskState;
		if (state.version !== STATE_VERSION || !state.sessionId || !state.key || !state.nativeId) {
			throw new Error(`Invalid atask native state in ${file}`);
		}
		return state;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function acquire(lock: string, options: RunAtaskTaskOptions, state: TaskState | undefined): Promise<void> {
	try {
		await fs.mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (!isEexist(error)) throw error;
		let owner: Owner;
		try {
			owner = (await Bun.file(path.join(lock, "owner.json")).json()) as Owner;
		} catch {
			throw new Error(`Atask owner registration is unavailable for ${options.key}; do not spawn a duplicate worker`);
		}
		if (!options.recoverStaleOwner || alive(owner.pid)) {
			throw new AtaskTaskAttachedError(state?.taskId ?? owner.taskId, owner.nativeId);
		}
		const recoveryLock = `${lock}.recovery`;
		try {
			await fs.mkdir(recoveryLock, { mode: 0o700 });
		} catch (error) {
			if (isEexist(error)) throw new AtaskTaskAttachedError(state?.taskId, owner.nativeId);
			throw error;
		}
		try {
			const current = (await Bun.file(path.join(lock, "owner.json")).json()) as Owner;
			if (current.pid !== owner.pid || alive(current.pid))
				throw new AtaskTaskAttachedError(state?.taskId, current.nativeId);
			const abandoned = `${lock}.abandoned-${crypto.randomUUID()}`;
			await fs.rename(lock, abandoned);
			await fs.mkdir(lock, { mode: 0o700 });
			await writeFileAtomically(
				path.join(lock, "owner.json"),
				JSON.stringify({ pid: process.pid, nativeId: options.nativeId, taskId: state?.taskId } satisfies Owner),
			);
			await fs.rm(abandoned, { recursive: true });
		} finally {
			await fs.rm(recoveryLock, { recursive: true, force: true });
		}
	}
	await writeFileAtomically(
		path.join(lock, "owner.json"),
		JSON.stringify({
			pid: process.pid,
			nativeId: options.nativeId,
			taskId: state?.taskId,
		} satisfies Owner),
	);
}

export interface AtaskTaskAttachment {
	backend?: "atask" | "local";
	localTaskId?: string;
	phase: "planned" | "running" | "failed" | "complete";
	taskId?: string;
	nativeId: string;
}

export async function readAtaskTaskState(
	options: Pick<RunAtaskTaskOptions, "sessionId" | "key">,
): Promise<AtaskTaskAttachment | undefined> {
	const identity = digest(
		JSON.stringify([process.env.ATASK_DB_URL, process.env.ATASK_DB, options.sessionId, options.key]),
	);
	const directory = path.join(process.env.OMP_ATASK_STATE_DIR || getAgentDir(), "native-atask");
	const state = await readState(path.join(directory, `${identity}.json`));
	return state
		? {
				phase: state.phase,
				taskId: state.taskId,
				nativeId: state.nativeId,
				backend: state.backend,
				localTaskId: state.localTaskId,
			}
		: undefined;
}

/** Duplicate stops share this execution. Durable owners must be attached or explicitly recovered. */
export function runAtaskTask<T>(
	options: RunAtaskTaskOptions,
	body: (assignment: string, workspace: string, taskId: string, workerSignal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	const identity = digest(
		JSON.stringify([process.env.ATASK_DB_URL, process.env.ATASK_DB, options.sessionId, options.key]),
	);
	const pending = inflight.get(identity);
	if (pending) return pending as Promise<T | undefined>;
	const execution = execute(options, identity, body);
	inflight.set(identity, execution);
	const settled = () => {
		inflight.delete(identity);
	};
	void execution.then(settled, settled);
	return execution;
}

async function execute<T>(
	options: RunAtaskTaskOptions,
	identity: string,
	body: (assignment: string, workspace: string, taskId: string, workerSignal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	for (const field of ["sessionId", "key", "name", "task", "cwd", "nativeId"] as const) {
		if (!options[field]?.trim()) throw new Error(`Atask task requires a non-empty ${field}`);
	}
	options.signal?.throwIfAborted();
	if (!options.taskId && !options.checks && (!options.proof?.trim() || !options.regression?.trim())) {
		throw new Error(
			`Atask task ${options.name} requires explicit proof and regression commands, live checks, or an existing atask id`,
		);
	}
	const configuredBinary = process.env.ATASK_BIN || "atask";
	const binary = $which(configuredBinary);
	const directory = path.join(process.env.OMP_ATASK_STATE_DIR || getAgentDir(), "native-atask");
	const lifecycle = new AbortController();
	const workerSignal = options.signal ? AbortSignal.any([options.signal, lifecycle.signal]) : lifecycle.signal;
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	assertOwnerPrivateDir(directory, "Atask state directory");
	const statePath = path.join(directory, `${identity}.json`);
	let state = await readState(statePath);
	const lock = path.join(directory, `${identity}.lock`);
	await acquire(lock, options, state);
	let bridge: AtaskCheckBridge | undefined;
	let renewTimer: NodeJS.Timeout | undefined;
	let renewPending: Promise<void> | undefined;
	let renewError: unknown;
	let workerStarted = false;
	const save = async () => {
		await writeFileAtomically(statePath, JSON.stringify(state));
	};
	const local = async (reason: string): Promise<T | undefined> => {
		if (!options.checks && (!options.proof || !options.regression)) {
			options.onVerification?.({
				backend: "local",
				status: "blocked",
				taskId: state?.taskId ?? options.taskId,
				reason: `${reason}; explicit proof and regression checks must be supplied locally`,
			});
			throw new Error(
				`Atask unavailable for ${options.name}: ${reason}; local verification requires explicit proof and regression checks`,
			);
		}
		const commands = options.checks
			? undefined
			: [options.proof!, options.regression!].map(spec => {
					const match = /^run:\s+([\s\S]+)$/.exec(spec);
					if (!match)
						throw new Error(
							`Local task verification does not support check ${JSON.stringify(spec)}; use an explicit run: command or restore a compatible atask`,
						);
					if (/(?:^|\s)(?:expect|size)=\S+(?:\s|$)/.test(match[1]))
						throw new Error(
							`Local task verification cannot interpret atask check options in ${JSON.stringify(spec)}; supply a shell command with its own assertions or restore compatible atask`,
						);
					return match[1];
				});
		const runCommand = async (command: string): Promise<boolean> => {
			const shell = $which("sh");
			if (!shell) throw new Error(`Local task check cannot run in ${options.cwd}: sh is unavailable`);
			const checked = await runForgeCli(
				{
					bin: shell,
					displayName: "local task check",
					installMessage: "Local task checks require sh",
					env: { ...process.env, ATASK_SESSION: undefined },
					timeoutMs: LOCAL_CHECK_TIMEOUT_MS,
				},
				options.cwd,
				["-c", command],
				options.signal,
				false,
			);
			return checked.exitCode === 0;
		};
		const proof = options.checks ? () => bridge!.check("proof") : () => runCommand(commands![0]);
		const regression = options.checks ? () => bridge!.check("regression") : () => runCommand(commands![1]);
		const satisfiedLocally = (await proof()) && (await regression());
		if (!satisfiedLocally && state?.backend === "local" && state.phase === "complete") {
			state.generation += FIRST_GENERATION;
			state.localTaskId = undefined;
		}
		state ??= {
			version: STATE_VERSION,
			sessionId: options.sessionId,
			key: options.key,
			generation: FIRST_GENERATION,
			taskId: options.taskId,
			nativeId: options.nativeId,
			proof: options.proof,
			regression: options.regression,
			liveChecks: !!options.checks,
			phase: "planned",
		};
		state.backend = "local";
		state.localTaskId ??= `local-${identity}-${state.generation}`;
		state.fallbackReason = reason;
		state.nativeId = options.nativeId;
		state.phase = "running";
		state.locallyVerified = false;
		await save();
		options.onVerification?.({
			backend: "local",
			status: "running",
			taskId: state.taskId,
			localTaskId: state.localTaskId,
			reason,
		});
		let result: T | undefined;
		if (!satisfiedLocally) {
			const assignment = prompt.render(taskPrompt, {
				task: options.task,
				taskId: state.taskId ?? state.localTaskId,
				workspace: options.cwd,
				local: true,
			});
			result = await body(assignment, options.cwd, state.taskId ?? state.localTaskId, workerSignal);
			options.signal?.throwIfAborted();
			if (!((await proof()) && (await regression())))
				throw new Error(
					`Local task ${state.localTaskId} proof or regression failed; a successful worker exit is not verification`,
				);
		}
		state.locallyVerified = true;
		state.phase = state.taskId ? "failed" : "complete";
		await save();
		if (state.taskId) {
			options.onVerification?.({
				backend: "local",
				status: "blocked",
				taskId: state.taskId,
				localTaskId: state.localTaskId,
				reason: `Locally verified; authoritative atask completion pending: ${reason}`,
			});
			throw new AtaskPendingCompletionError(state.taskId, state.localTaskId, reason);
		}
		options.onVerification?.({ backend: "local", status: "verified", localTaskId: state.localTaskId, reason });
		return result;
	};
	const cli = async <R>(args: string[], token?: string): Promise<R> => {
		if (!binary) throw new AtaskCapabilityUnavailableError(`Atask executable ${configuredBinary} is unavailable`);
		const result = await runForgeCli(
			{
				bin: binary,
				displayName: "atask",
				installMessage: `Cannot find atask executable ${binary}`,
				env: { ...process.env, ATASK_SESSION: token, ATASK_PROJECT: undefined, ATASK_OUTPUT: "json" },
				timeoutMs: CLI_TIMEOUT_MS,
			},
			options.cwd,
			["--json", ...(state?.project ? ["--project", state.project] : []), ...args],
			options.signal,
			true,
		);
		let envelope: { ok?: boolean; result?: R; error?: { message?: string } };
		try {
			envelope = JSON.parse(result.stdout);
		} catch {
			const failure = `${result.stderr}\n${result.stdout}`;
			if (
				["project", "add", "show", "claim"].includes(args[0]) &&
				/^(?:error:\s*)?(?:unknown (?:command|flag)|flag provided but not defined|unsupported (?:command|capability))/im.test(
					failure,
				)
			)
				throw new AtaskCapabilityUnavailableError(failure.trim());
			throw new Error(`Atask ${args[0]} returned invalid JSON: ${result.stderr || result.stdout}`);
		}
		if (result.exitCode !== 0 || envelope.ok !== true || envelope.result === undefined) {
			if (
				["project", "add", "show", "claim"].includes(args[0]) &&
				envelope.error?.message &&
				/^(?:unknown (?:command|flag)|flag provided but not defined|unsupported (?:command|capability))/i.test(
					envelope.error.message,
				)
			)
				throw new AtaskCapabilityUnavailableError(envelope.error.message);
			throw new Error(
				`Atask ${args[0]} failed for ${state?.taskId ?? options.key}: ${envelope.error?.message || result.stderr || result.stdout}`,
			);
		}
		return envelope.result;
	};
	try {
		// The lock may have been acquired after another process published its task id.
		state = await readState(statePath);
		if (state && (state.sessionId !== options.sessionId || state.key !== options.key)) {
			throw new Error(`Atask state identity mismatch for ${options.key}`);
		}
		if (state?.phase === "running" && !options.recoverStaleOwner) {
			throw new AtaskTaskAttachedError(state.taskId, state.nativeId);
		}
		if (state && options.taskId && state.taskId !== options.taskId) {
			throw new Error(`Atask task ${options.taskId} does not match persisted task ${state.taskId}`);
		}
		if (
			state &&
			(state.liveChecks !== !!options.checks ||
				state.proof !== options.proof ||
				state.regression !== options.regression)
		) {
			throw new Error(
				`Atask checks changed for ${options.key}; use a new invariant key rather than weakening stored checks`,
			);
		}
		if (state?.liveChecks && !options.checks)
			throw new Error(`Re-register live proof and regression checks for ${state.taskId}`);
		const checks = options.checks;
		// Parent closures stay in memory; only the named runner command is durable.
		const socketDirectory = path.join(
			process.platform === "win32" ? os.tmpdir() : "/tmp",
			`omp-atask-${process.getuid?.() ?? "user"}`,
		);
		const socketPath = path.join(socketDirectory, `${identity}.sock`);
		if (checks) {
			// Owning the task lock proves no registered live owner can still serve this endpoint.
			await fs.mkdir(socketDirectory, { recursive: true, mode: 0o700 });
			assertOwnerPrivateDir(socketDirectory, "Atask check directory");
			await fs.rm(socketPath, { force: true });
			bridge = await registerAtaskChecks(socketPath, identity, checks, options.signal);
		}
		const satisfied = bridge ? (await bridge.check("proof")) && (await bridge.check("regression")) : false;
		if (!state && !options.taskId && satisfied && binary) {
			options.onVerification?.({
				backend: "atask",
				status: "verified",
				reason: "Live proof and regression already pass; no objective filed",
			});
			return undefined;
		}
		if (state?.phase === "complete" && state.backend !== "local") {
			if (options.taskId) {
				throw new Error(
					`Atask task ${options.taskId} is already complete; use a new invariant key for renewed work`,
				);
			}
			if (satisfied) {
				options.onVerification?.({
					backend: state.backend ?? "atask",
					status: "verified",
					taskId: state.taskId,
					localTaskId: state.localTaskId,
					reason: state.fallbackReason,
				});
				return undefined;
			}
			state = {
				...state,
				generation: state.generation + FIRST_GENERATION,
				taskId: undefined,
				localTaskId: undefined,
				locallyVerified: false,
				token: undefined,
				workspace: undefined,
				phase: "planned",
			};
		}
		state ??= {
			version: STATE_VERSION,
			sessionId: options.sessionId,
			key: options.key,
			generation: FIRST_GENERATION,
			nativeId: options.nativeId,
			taskId: options.taskId,
			proof: options.proof,
			regression: options.regression,
			liveChecks: !!options.checks,
			phase: "planned",
		};
		state.nativeId = options.nativeId;
		await save();
		if (!binary || (state.backend === "local" && !state.taskId))
			return await local(state.fallbackReason ?? `Atask executable ${configuredBinary} is unavailable`);
		if (!state.taskId) {
			const projectName = `omp-native-${digest(path.resolve(options.cwd))}`;
			const project = await cli<{ id: string }>(["project", "add", projectName]);
			if (!project.id) throw new Error(`Atask project registration returned no id for ${options.cwd}`);
			state.project = project.id;
			await save();
			const host = workerHostEntry();
			const runner =
				process.env.PI_COMPILED === "true"
					? [process.execPath, ATASK_CHECK_SELECTOR]
					: host
						? [process.execPath, host, ATASK_CHECK_SELECTOR]
						: [process.execPath, path.join(import.meta.dir, "atask-check.ts")];
			const spec = (kind: "proof" | "regression") =>
				`run: ${[...runner, socketPath, identity, kind].map(quote).join(" ")}`;
			const added = await cli<{ task: TaskView }>([
				"add",
				options.name,
				"--key",
				`omp-${identity}-${state.generation}`,
				"--outcome",
				boundedAtaskOutcome(options.task),
				"--proof",
				options.checks ? spec("proof") : options.proof!,
				"--regression",
				options.checks ? spec("regression") : options.regression!,
			]);
			if (!added.task?.id) throw new Error(`Atask add returned no task id for ${options.key}`);
			state.taskId = added.task.id;
			await save();
		}
		const taskId = state.taskId;
		const task = await cli<TaskView>(["show", taskId]);
		if (task.id !== taskId) throw new Error(`Atask show returned the wrong task for ${taskId}`);
		if (task.status === "complete") {
			state.phase = "complete";
			await save();
			if (options.taskId)
				throw new Error(
					`Atask task ${taskId} is already complete; use a new invariant key rather than trusting stale completion`,
				);
			throw new Error(
				`Atask task ${taskId} is complete but the invariant failed; invoke again to renew its generation`,
			);
		}
		if (!task.proof || !task.regression)
			throw new Error(`Atask task ${taskId} needs stored proof and regression checks`);
		if (!state.token) {
			const claim = await cli<Claim>(["claim", taskId]);
			if (claim.task?.id !== taskId || !claim.token || !claim.workspace)
				throw new Error(`Atask claim returned an invalid assignment for ${taskId}`);
			state.token = claim.token;
			state.workspace = claim.workspace;
		} else {
			try {
				await cli(["claim", "renew"], state.token);
			} catch (error) {
				if (!options.recoverStaleOwner) throw error;
				const claim = await cli<Claim>(["claim", taskId]);
				if (claim.task?.id !== taskId || !claim.token || !claim.workspace)
					throw new Error(`Atask recovery returned an invalid assignment for ${taskId}`);
				state.token = claim.token;
				state.workspace = claim.workspace;
			}
		}
		state.phase = "running";
		await save();
		const token = state.token;
		const workspace = state.workspace;
		if (!workspace) throw new Error(`Atask task ${taskId} has no durable workspace`);
		renewTimer = setInterval(() => {
			if (renewPending || renewError) return;
			renewPending = cli(["claim", "renew"], token)
				.then(
					() => {},
					error => {
						renewError = error;
						lifecycle.abort(error);
					},
				)
				.finally(() => {
					renewPending = undefined;
				});
		}, RENEW_INTERVAL_MS);
		renewTimer.unref();
		state.backend = "atask";
		options.onVerification?.({ backend: "atask", status: "running", taskId });
		const assignment = prompt.render(taskPrompt, {
			task: options.task,
			taskId,
			workspace,
			authoritativeOutcome: task.outcome ?? task.title,
			authoritativeProof: JSON.stringify(task.proof),
			authoritativeRegression: JSON.stringify(task.regression),
		});
		workerStarted = !satisfied;
		const result = satisfied ? undefined : await body(assignment, workspace, taskId, workerSignal);
		if (renewPending) await renewPending;
		if (renewError) throw renewError;
		options.signal?.throwIfAborted();
		const verified = await cli<{ task_id: string; passed: boolean; completed: boolean; status: string }>(
			["verify", "complete"],
			token,
		);
		if (
			verified.task_id !== taskId ||
			verified.passed !== true ||
			verified.completed !== true ||
			verified.status !== "complete"
		) {
			throw new Error(
				`Atask completion failed for ${taskId}: status ${verified.status}; worker exit is not completion`,
			);
		}
		const completed = await cli<TaskView>(["show", taskId]);
		if (completed.id !== taskId || completed.status !== "complete")
			throw new Error(`Atask did not confirm completed task ${taskId}`);
		state.phase = "complete";
		await save();
		options.onVerification?.({ backend: "atask", status: "verified", taskId });
		return result;
	} catch (caught) {
		const error = renewError ?? caught;
		if (error instanceof AtaskCapabilityUnavailableError && !workerStarted) {
			try {
				return await local(error.message);
			} catch (localError) {
				if (state && !state.locallyVerified) {
					state.phase = "failed";
					await save();
				}
				if (!(localError instanceof AtaskPendingCompletionError))
					options.onVerification?.({
						backend: "local",
						status: "blocked",
						taskId: state?.taskId,
						localTaskId: state?.localTaskId,
						reason: String(localError),
					});
				throw localError;
			}
		}
		if (state && state.phase !== "complete" && !(error instanceof AtaskTaskAttachedError)) {
			state.phase = "failed";
			await save();
		}
		if (!(error instanceof AtaskTaskAttachedError))
			options.onVerification?.({
				backend: state?.backend ?? "atask",
				status: "blocked",
				taskId: state?.taskId,
				localTaskId: state?.localTaskId,
				reason: String(error),
			});
		throw error;
	} finally {
		clearInterval(renewTimer);
		if (renewPending) await renewPending;
		bridge?.close();
		await fs.rm(lock, { recursive: true, force: true });
	}
}
