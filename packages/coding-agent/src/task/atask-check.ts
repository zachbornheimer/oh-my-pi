import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Server } from "bun";
import { assertOwnerPrivateDir } from "../utils/owner-private-dir";

export const ATASK_CHECK_SELECTOR = "__omp_worker_atask_check";
export const ATASK_CHECK_TIMEOUT_MS = 25_000;
const CHECK_ROUTE = "/check";
const CHECK_FAILURE = 1;
const CHECK_SUCCESS = 0;

export interface AtaskChecks {
	proof: () => Promise<boolean>;
	regression: () => Promise<boolean>;
}

export type AtaskCheckKind = keyof AtaskChecks;

export interface AtaskCheckBridge {
	check(kind: AtaskCheckKind): Promise<boolean>;
	close(): void;
}

/** A stable, owner-private endpoint lets stored checks find freshly registered closures after restart. */
export async function registerAtaskChecks(
	socketPath: string,
	checkKey: string,
	checks: AtaskChecks,
	signal?: AbortSignal,
): Promise<AtaskCheckBridge> {
	const directory = path.dirname(socketPath);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	assertOwnerPrivateDir(directory, "Atask check directory");
	const check = async (kind: AtaskCheckKind): Promise<boolean> => {
		const deadline = AbortSignal.timeout(ATASK_CHECK_TIMEOUT_MS);
		const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
		abort.throwIfAborted();
		const { promise, reject } = Promise.withResolvers<never>();
		const onAbort = () => reject(new Error(`Atask ${kind} check unavailable or timed out for ${checkKey}`));
		abort.addEventListener("abort", onAbort, { once: true });
		try {
			const passed = await Promise.race([checks[kind](), promise]);
			return passed === true;
		} finally {
			abort.removeEventListener("abort", onAbort);
		}
	};
	const server: Server<undefined> = Bun.serve({
		unix: socketPath,
		async fetch(request) {
			const url = new URL(request.url);
			const kind = url.searchParams.get("kind");
			if (
				url.pathname !== CHECK_ROUTE ||
				request.headers.get("authorization") !== `Bearer ${checkKey}` ||
				(kind !== "proof" && kind !== "regression")
			) {
				return new Response("Atask check unavailable", { status: 403 });
			}
			try {
				return Response.json({ passed: await check(kind) });
			} catch (error) {
				return new Response(String(error), { status: 503 });
			}
		},
	});
	await fs.chmod(socketPath, 0o600);
	return {
		check,
		close: () => {
			server.stop(true);
		},
	};
}

export async function requestAtaskCheck(socketPath: string, checkKey: string, kind: AtaskCheckKind): Promise<boolean> {
	const response = await fetch(`http://localhost${CHECK_ROUTE}?kind=${kind}`, {
		unix: socketPath,
		headers: { authorization: `Bearer ${checkKey}` },
		signal: AbortSignal.timeout(ATASK_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Atask ${kind} check unavailable: ${await response.text()}`);
	const result: unknown = await response.json();
	return typeof result === "object" && result !== null && "passed" in result && result.passed === true;
}

export async function runAtaskCheckRunner(args: string[]): Promise<number> {
	const [socketPath, checkKey, kind] = args;
	if (!socketPath || !checkKey || (kind !== "proof" && kind !== "regression") || args.length !== 3) {
		process.stderr.write("Atask check requires a registered socket, key, and proof or regression selector\n");
		return CHECK_FAILURE;
	}
	try {
		return (await requestAtaskCheck(socketPath, checkKey, kind)) ? CHECK_SUCCESS : CHECK_FAILURE;
	} catch (error) {
		process.stderr.write(`Atask ${kind} check unavailable: ${String(error)}\n`);
		return CHECK_FAILURE;
	}
}

if (import.meta.main) process.exitCode = await runAtaskCheckRunner(process.argv.slice(2));
