/**
 * Where an idle omp session should read the current install from.
 *
 * Same switch as `capability` `resolveRemoteTarget`: empty, `0`, `false`, or
 * `OMP_REMOTE_ACTIVE=1` stays here. `1`, `true`, and `auto` name
 * `OMP_REMOTE_HOST` or the fleet host. Any other value is the host.
 */
export const OMP_REMOTE_ENV = "OMP_REMOTE";
export const OMP_REMOTE_ACTIVE_ENV = "OMP_REMOTE_ACTIVE";
export const OMP_REMOTE_HOST_ENV = "OMP_REMOTE_HOST";
export const OMP_REMOTE_SSH_BIN_ENV = "OMP_REMOTE_SSH_BIN";
export const DEFAULT_OMP_REMOTE_HOST = "backend.ai.lan.zachandaj.com";

/** Constant ssh binary. Never a path taken from the environment. */
export const SSH_BIN = "ssh";

/** Fixed remote command. The install symlink mise writes, resolved on that host. */
export const REMOTE_LATEST_OMP_COMMAND =
	"realpath ~/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-latest/omp";

/** Fixed remote exec. The far side is already the fleet host, so it must not hop again. */
export const REMOTE_OMP_EXEC =
	"export OMP_REMOTE_ACTIVE=1; exec ~/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-latest/omp";

const SSH_READ_TIMEOUT_MS = 3_000;

export interface OmpRemoteTarget {
	host: string;
}

export function resolveOmpRemoteTarget(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): OmpRemoteTarget | undefined {
	const raw = (env[OMP_REMOTE_ENV] ?? "").trim();
	if (raw === "" || raw === "0" || raw.toLowerCase() === "false" || env[OMP_REMOTE_ACTIVE_ENV] === "1") {
		return undefined;
	}
	const lower = raw.toLowerCase();
	const generic = raw === "1" || lower === "true" || lower === "auto";
	if (platform === "linux" && generic && env[OMP_REMOTE_SSH_BIN_ENV] === undefined) return undefined;
	const host = generic ? env[OMP_REMOTE_HOST_ENV]?.trim() || DEFAULT_OMP_REMOTE_HOST : raw;
	return host.length > 0 ? { host } : undefined;
}

/** Argv for reading the remote install. The executable is the literal `ssh`. */
export function sshReadLatestArgv(host: string): readonly string[] {
	return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", host, REMOTE_LATEST_OMP_COMMAND];
}

export function parseRemoteLatestOmp(exitCode: number, stdout: string): string | undefined {
	if (exitCode !== 0) return undefined;
	const line = stdout.trim().split("\n").pop()?.trim();
	if (!line || !line.startsWith("/")) return undefined;
	return line;
}

export interface SshReadResult {
	exitCode: number;
	stdout: string;
}

/**
 * `realpath` of the remote `build-latest/omp`. Undefined when ssh fails or the
 * symlink is missing — then do not reload.
 */
export function readRemoteLatestOmp(host: string, run: (argv: readonly string[]) => SshReadResult = runSshRead): string | undefined {
	const argv = sshReadLatestArgv(host);
	const result = run(argv);
	return parseRemoteLatestOmp(result.exitCode, result.stdout);
}

function runSshRead(argv: readonly string[]): SshReadResult {
	const host = argv[4] ?? "";
	const proc = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", host, REMOTE_LATEST_OMP_COMMAND], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: SSH_READ_TIMEOUT_MS,
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Relaunch argv that replaces this process with ssh. The far side execs its
 * `build-latest/omp` with `OMP_REMOTE_ACTIVE=1`, so it does not hop again.
 */
export function remoteRestartArgv(host: string, ompArgs: readonly string[]): string[] {
	const args = ompArgs.length > 0 ? ` ${ompArgs.map(shQuote).join(" ")}` : "";
	return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, `${REMOTE_OMP_EXEC}${args}`];
}
