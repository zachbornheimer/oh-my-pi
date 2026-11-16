import { ptree } from "@oh-my-pi/pi-utils";

/** Env var naming the broker's `jobowner.sh`. Unset: detached bash calls run under omp's own daemon broker. */
export const JOB_OWNER_ENV = "OMP_JOBOWNER";
/** Env var naming the session broker's unix socket; the job owner sends `TOOL <session> <call>` there on exit. */
export const JOB_OWNER_BROKER_SOCK_ENV = "OMP_BROKER_SOCK";
/** Env var overriding the job owner's `JOBS_ROOT`; unset keeps the owner's own default. */
export const JOB_OWNER_JOBS_ROOT_ENV = "OMP_JOBS_ROOT";

/** A broker-side job owner: a program that runs a command so it outlives this process and wakes the session on exit. */
export interface BrokerJobOwner {
	script: string;
	brokerSocket?: string;
	jobsRoot?: string;
}

export interface BrokerJobSpawn {
	/** The parked session the exit wakes. */
	sessionId: string;
	/** The idempotency key: the same call spawned twice is the same job. */
	toolCallId: string;
	command: string;
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}

/** The configured job owner, or undefined when this session does not hand jobs to a broker. */
export function brokerJobOwner(env: Record<string, string | undefined>): BrokerJobOwner | undefined {
	const script = env[JOB_OWNER_ENV];
	if (!script) return undefined;
	const brokerSocket = env[JOB_OWNER_BROKER_SOCK_ENV];
	const jobsRoot = env[JOB_OWNER_JOBS_ROOT_ENV];
	return {
		script,
		...(brokerSocket ? { brokerSocket } : {}),
		...(jobsRoot ? { jobsRoot } : {}),
	};
}

/**
 * Start a command under the job owner and return its job directory. The command is one argv word and never
 * passes through a shell here, so a command string cannot add arguments to the owner.
 */
export async function spawnBrokerJob(owner: BrokerJobOwner, job: BrokerJobSpawn): Promise<{ dir: string }> {
	const result = await ptree.exec([owner.script, "spawn", job.sessionId, job.toolCallId, job.command], {
		cwd: job.cwd,
		env: {
			...Bun.env,
			...job.env,
			...(owner.brokerSocket ? { BROKER_SOCK: owner.brokerSocket } : {}),
			...(owner.jobsRoot ? { JOBS_ROOT: owner.jobsRoot } : {}),
		},
		allowNonZero: true,
		signal: job.signal,
	});
	if (result.exitCode !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
		throw new Error(`job owner refused the job: ${reason}`);
	}
	const dir = result.stdout.trim().split("\n").at(-1) ?? "";
	if (!dir) throw new Error("job owner started the job but printed no job directory");
	return { dir };
}
