import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { writeFileAtomically } from "../utils/atomic-file";
import { assertOwnerPrivateDir } from "../utils/owner-private-dir";
import { runAtaskTask, type RunAtaskTaskOptions } from "./atask";

const RESTORE_VERSION = 1;
const DIGEST_LENGTH = 32;
const DIRECTORY_MODE = 0o700;
const RESTORE_DIRECTORY = "native-atask-restore";
const REQUIRED_FIELDS = ["sessionId", "key", "name", "task", "cwd", "nativeId"] as const;
const OPTIONAL_FIELDS = ["proof", "regression", "taskId"] as const;

type RestoreIdentity = Pick<RunAtaskTaskOptions, "sessionId" | "nativeId">;

export interface AtaskTaskRestore extends RestoreIdentity {
	version: number;
	key: string;
	name: string;
	task: string;
	cwd: string;
	proof?: string;
	regression?: string;
	taskId?: string;
	liveChecks: boolean;
}

interface RegistrationWaiter {
	resolve: (options: RunAtaskTaskOptions) => void;
}

const registrations = new Map<string, RunAtaskTaskOptions>();
const waiters = new Map<string, Set<RegistrationWaiter>>();

async function restoreFile(identity: RestoreIdentity): Promise<string> {
	const directory = path.join(process.env.OMP_ATASK_STATE_DIR || getAgentDir(), RESTORE_DIRECTORY);
	await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
	assertOwnerPrivateDir(directory, "Atask restore directory");
	const digest = createHash("sha256")
		.update(JSON.stringify([process.env.ATASK_DB_URL, process.env.ATASK_DB, identity.sessionId, identity.nativeId]))
		.digest("hex")
		.slice(0, DIGEST_LENGTH);
	return path.join(directory, `${digest}.json`);
}

function validateRestore(value: unknown, identity: RestoreIdentity, file: string): AtaskTaskRestore {
	if (typeof value !== "object" || value === null) throw new Error(`Invalid atask restore association in ${file}`);
	const fields = value as Record<string, unknown>;
	if (
		fields.version !== RESTORE_VERSION ||
		typeof fields.liveChecks !== "boolean" ||
		REQUIRED_FIELDS.some(field => typeof fields[field] !== "string" || !(fields[field] as string).trim()) ||
		OPTIONAL_FIELDS.some(field => fields[field] !== undefined && typeof fields[field] !== "string") ||
		fields.sessionId !== identity.sessionId ||
		fields.nativeId !== identity.nativeId
	) {
		throw new Error(`Invalid atask restore association for ${identity.nativeId} in ${file}`);
	}
	return fields as unknown as AtaskTaskRestore;
}

export async function readAtaskTaskRestore(identity: RestoreIdentity): Promise<AtaskTaskRestore | undefined> {
	const file = await restoreFile(identity);
	try {
		return validateRestore(await Bun.file(file).json(), identity, file);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Persist the worker's authority before starting it; closures remain in the parent process. */
export async function recordAtaskTaskRestore(options: RunAtaskTaskOptions): Promise<void> {
	const file = await restoreFile(options);
	const association: AtaskTaskRestore = {
		version: RESTORE_VERSION,
		sessionId: options.sessionId,
		key: options.key,
		name: options.name,
		task: options.task,
		cwd: options.cwd,
		nativeId: options.nativeId,
		proof: options.proof,
		regression: options.regression,
		taskId: options.taskId,
		liveChecks: options.checks !== undefined,
	};
	validateRestore(association, options, file);
	const previous = await readAtaskTaskRestore(options);
	if (
		previous &&
		(previous.key !== association.key ||
			previous.proof !== association.proof ||
			previous.regression !== association.regression ||
			previous.liveChecks !== association.liveChecks)
	) {
		throw new Error(`Atask restore checks changed for ${options.nativeId}; restore its original invariant instead`);
	}
	await writeFileAtomically(file, JSON.stringify(association));
	registrations.set(file, options);
	for (const waiter of waiters.get(file) ?? []) waiter.resolve(options);
}

async function awaitRegistration(file: string, signal?: AbortSignal): Promise<RunAtaskTaskOptions> {
	signal?.throwIfAborted();
	const registered = registrations.get(file);
	if (registered) return registered;
	const pending = Promise.withResolvers<RunAtaskTaskOptions>();
	const waiter: RegistrationWaiter = { resolve: pending.resolve };
	let listeners = waiters.get(file);
	if (!listeners) waiters.set(file, (listeners = new Set()));
	listeners.add(waiter);
	const aborted = () => pending.reject(signal?.reason);
	signal?.addEventListener("abort", aborted, { once: true });
	try {
		return await pending.promise;
	} finally {
		signal?.removeEventListener("abort", aborted);
		listeners.delete(waiter);
		if (listeners.size === 0) waiters.delete(file);
	}
}

/** Resume only the existing worker, under the same proof and regression authority as spawn. */
export async function runRestoredAtaskTask<T>(
	identity: RestoreIdentity & Pick<RunAtaskTaskOptions, "signal" | "onVerification">,
	body: (assignment: string, workspace: string, taskId: string, workerSignal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	const association = await readAtaskTaskRestore(identity);
	if (!association)
		throw new Error(
			`Atask verification association unavailable for restored worker ${identity.nativeId}; worker exit cannot establish completion`,
		);
	const file = await restoreFile(identity);
	let registered = registrations.get(file);
	if (association.liveChecks && !registered?.checks) {
		identity.onVerification?.({
			backend: "atask",
			status: "blocked",
			taskId: association.taskId,
			reason: `Re-register live proof and regression checks for restored worker ${identity.nativeId}`,
		});
		registered = await awaitRegistration(file, identity.signal);
	}
	return runAtaskTask(
		{
			...association,
			checks: registered?.checks,
			signal: identity.signal,
			onVerification: identity.onVerification ?? registered?.onVerification,
			recoverStaleOwner: true,
		},
		body,
	);
}
