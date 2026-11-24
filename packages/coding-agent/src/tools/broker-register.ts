import type { Socket } from "bun";
import { logger } from "@oh-my-pi/pi-utils";
import { JOB_OWNER_BROKER_SOCK_ENV } from "./job-owner";

/** How long a session waits for the broker to acknowledge before it exits anyway. */
const REGISTER_TIMEOUT_MS = 2_000;

/** The broker's id grammar: ASCII, 1 to 255 bytes, no whitespace (one request per line). */
const BROKER_SESSION_ID = /^[\x21-\x7e]{1,255}$/;

export type BrokerRegistration = "registered" | "unconfigured" | "failed";

/**
 * Tell the session broker that this session is about to exit and is now a stored row, so a finished detached
 * job can wake it. `unconfigured` when no broker socket is set. A failure never blocks the exit: the session
 * is already on disk, and the broker also delivers any done job nobody claimed when it next starts.
 */
export async function registerParkedSession(
	env: Record<string, string | undefined>,
	sessionId: string,
	timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<BrokerRegistration> {
	const socketPath = env[JOB_OWNER_BROKER_SOCK_ENV];
	if (!socketPath) return "unconfigured";
	if (!BROKER_SESSION_ID.test(sessionId)) {
		logger.warn("Session broker registration skipped: the session id is not valid in the broker protocol", {
			sessionId,
		});
		return "failed";
	}

	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), timeoutMs);
	let reply = "";
	let socket: Socket | undefined;
	try {
		socket = await Bun.connect({
			unix: socketPath,
			socket: {
				open(connection) {
					connection.write(`REGISTER ${sessionId}\n`);
				},
				data(_connection, chunk) {
					reply += chunk.toString();
					const end = reply.indexOf("\n");
					if (end >= 0) resolve(reply.slice(0, end).startsWith(`OK ${sessionId} `));
				},
				error() {
					resolve(false);
				},
				close() {
					resolve(false);
				},
			},
		});
	} catch (error) {
		logger.warn("Session broker registration could not connect", { socketPath, error: String(error) });
		resolve(false);
	}
	const acknowledged = await promise;
	clearTimeout(timer);
	socket?.end();
	if (!acknowledged) logger.warn("Session broker did not acknowledge registration", { socketPath, sessionId });
	return acknowledged ? "registered" : "failed";
}
