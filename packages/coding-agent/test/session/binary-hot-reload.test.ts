import * as utils from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveRestartEntryCmd, resolveWorkerSpawnCmd } from "../../src/subprocess/worker-client";
import {
	BinaryHotReloadWatcher,
	decideBinaryReload,
	executableWhichWouldLaunch,
	miseLatestOmpPath,
	readMiseLatestOmp,
} from "../../src/session/binary-hot-reload";
import {
	DEFAULT_OMP_REMOTE_HOST,
	REMOTE_LATEST_OMP_COMMAND,
	REMOTE_OMP_EXEC,
	remoteRestartArgv,
	resolveOmpRemoteTarget,
	sshReadLatestArgv,
	parseRemoteLatestOmp,
} from "../../src/session/omp-remote-target";

const running = "/installs/build-old/omp";
const newer = "/installs/build-new/omp";

describe("hot-reload-omp-binary", () => {
	it("relaunches when the shim path differs from the running binary", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("relaunch");
	});

	it("stays when the shim path matches the running binary", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: running,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("stays when the session is not in herdr or tmux", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: false,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("stays when hot reload is off, even inside herdr or tmux", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: false,
			}),
		).toBe("stay");
	});

	it("stays when the new path is not executable", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: false,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("does not treat a mise shim's realpath as the omp binary it would launch", () => {
		const shim = "/Users/me/.local/share/mise/shims/omp";
		const mise = "/opt/homebrew/bin/mise";
		expect(executableWhichWouldLaunch(shim, mise)).toBeUndefined();
		expect(executableWhichWouldLaunch("/usr/local/bin/omp", running)).toBe(running);
	});

	it("reads the mise build-latest symlink and does not reload when it is missing", () => {
		const home = "/Users/me";
		const install = "/Users/me/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-new/omp";
		const seen: string[] = [];
		expect(miseLatestOmpPath(home)).toBe(
			"/Users/me/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-latest/omp",
		);
		expect(
			readMiseLatestOmp(
				home,
				filePath => {
					seen.push(filePath);
					return install;
				},
				() => true,
			),
		).toBe(install);
		expect(seen).toEqual([miseLatestOmpPath(home)]);
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: install,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("relaunch");
		expect(
			readMiseLatestOmp(
				home,
				() => {
					throw new Error("missing");
				},
				() => true,
			),
		).toBeUndefined();
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: undefined,
				launchExecutable: false,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("relaunches when a mise shim's install path differs from the running binary", () => {
		const shim = "/Users/me/.local/share/mise/shims/omp";
		const mise = "/opt/homebrew/bin/mise";
		const install = "/Users/me/.local/share/mise/installs/oh-my-pi/build-new/omp";
		expect(executableWhichWouldLaunch(shim, mise, install)).toBe(install);
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: executableWhichWouldLaunch(shim, mise, install),
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("relaunch");
		expect(
			decideBinaryReload({
				runningPath: install,
				launchPath: executableWhichWouldLaunch(shim, mise, install),
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("defers a mid-turn change until the turn ends", async () => {
		let busy = true;
		let restarts = 0;
		const notices: string[] = [];
		const idle: Array<() => void> = [];
		const watcher = new BinaryHotReloadWatcher({
			observe: () => ({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
			isBusy: () => busy,
			onIdle: listener => {
				idle.push(listener);
				return () => {
					idle.splice(idle.indexOf(listener), 1);
				};
			},
			restart: async () => {
				restarts++;
			},
			notify: (_level, message) => {
				notices.push(message);
			},
			pollIntervalMs: 3_600_000,
		});
		await watcher.start();
		await watcher.poll();
		expect(restarts).toBe(0);
		expect(notices).toEqual(["a newer omp is on PATH; restart deferred until the current turn ends"]);

		busy = false;
		for (const listener of idle) listener();
		await watcher.poll();
		watcher.stop();

		expect(restarts).toBe(1);
	});

	it("restarts a compiled session onto the live binary and leaves workers on the running one", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);

		expect(resolveRestartEntryCmd(newer)).toEqual([newer]);
		expect(resolveWorkerSpawnCmd("__omp_worker")).toEqual({ cmd: [process.execPath, "__omp_worker"] });
	});

	it("does not point a bun dev restart at the installed binary", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);

		expect(resolveRestartEntryCmd(newer)[0]).toBe(process.execPath);
		expect(resolveRestartEntryCmd(newer)).not.toContain(newer);
	});

	it("stays local unless OMP_REMOTE names a host", () => {
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "" })).toBeUndefined();
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "0" })).toBeUndefined();
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "false" })).toBeUndefined();
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "1", OMP_REMOTE_ACTIVE: "1" })).toBeUndefined();
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "1" })?.host).toBe(DEFAULT_OMP_REMOTE_HOST);
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "true", OMP_REMOTE_HOST: "fleet.example" })?.host).toBe(
			"fleet.example",
		);
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "auto" })?.host).toBe(DEFAULT_OMP_REMOTE_HOST);
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "box.example" })?.host).toBe("box.example");
		expect(resolveOmpRemoteTarget({ OMP_REMOTE: "1" }, "linux")).toBeUndefined();
	});

	it("reads the remote build-latest over a constant ssh and hops there on restart", () => {
		const host = "backend.ai.lan.zachandaj.com";
		const remoteInstall = "/home/me/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-new/omp";
		const argv = sshReadLatestArgv(host);
		expect(argv[0]).toBe("ssh");
		expect(argv.at(-1)).toBe(REMOTE_LATEST_OMP_COMMAND);
		expect(parseRemoteLatestOmp(0, `${remoteInstall}\n`)).toBe(remoteInstall);
		expect(parseRemoteLatestOmp(1, "")).toBeUndefined();
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: remoteInstall,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("relaunch");
		const restart = remoteRestartArgv(host, ["--restore", "/tmp/session.jsonl"]);
		expect(restart[0]).toBe("ssh");
		expect(restart).not.toContain(process.execPath);
		expect(restart.at(-1)).toContain("OMP_REMOTE_ACTIVE=1");
		expect(restart.at(-1)).toContain(REMOTE_OMP_EXEC);
		expect(restart.at(-1)).toContain("'--restore'");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
