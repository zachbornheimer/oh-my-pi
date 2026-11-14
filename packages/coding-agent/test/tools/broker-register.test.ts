import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerParkedSession } from "../../src/tools/broker-register";

const SOCK = "OMP_BROKER_SOCK";
let dir: string | undefined;
let server: { stop(force?: boolean): void } | undefined;

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = undefined;
});

/** A broker stand-in speaking the real protocol: one request line in, one reply line out. */
async function listenBroker(reply: (line: string) => string | undefined): Promise<{ sock: string; lines: string[] }> {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-register-"));
	const sock = path.join(dir, "b.sock");
	const lines: string[] = [];
	server = Bun.listen({
		unix: sock,
		socket: {
			data(connection, chunk) {
				for (const line of chunk.toString().split("\n").filter(Boolean)) {
					lines.push(line);
					const out = reply(line);
					if (out !== undefined) connection.write(`${out}\n`);
				}
			},
		},
	});
	return { sock, lines };
}

describe("registerParkedSession", () => {
	test("sends REGISTER for the session and reports registered on OK", async () => {
		const broker = await listenBroker(line => `OK ${line.split(" ")[1]} parked`);
		const result = await registerParkedSession({ [SOCK]: broker.sock }, "01a1d78c-822a-7364-a18e-5e78203cc3f7");
		expect(result).toBe("registered");
		expect(broker.lines).toEqual(["REGISTER 01a1d78c-822a-7364-a18e-5e78203cc3f7"]);
	});

	test("does nothing when no broker socket is configured", async () => {
		expect(await registerParkedSession({}, "01a1d78c-822a-7364-a18e-5e78203cc3f7")).toBe("unconfigured");
	});

	test("fails without throwing when the broker is gone", async () => {
		const result = await registerParkedSession({ [SOCK]: "/tmp/no-such-broker.sock" }, "abc");
		expect(result).toBe("failed");
	});

	test("fails within the timeout when the broker never replies", async () => {
		const broker = await listenBroker(() => undefined);
		const started = Date.now();
		const result = await registerParkedSession({ [SOCK]: broker.sock }, "abc", 200);
		expect(result).toBe("failed");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("refuses an id the line protocol cannot carry, without contacting the broker", async () => {
		const broker = await listenBroker(line => `OK ${line.split(" ")[1]} parked`);
		expect(await registerParkedSession({ [SOCK]: broker.sock }, "a b\nWAKE x y")).toBe("failed");
		expect(broker.lines).toEqual([]);
	});

	test("treats an ERR reply as a failed registration", async () => {
		const broker = await listenBroker(line => `ERR ${line.split(" ")[1]} nope`);
		expect(await registerParkedSession({ [SOCK]: broker.sock }, "abc")).toBe("failed");
	});
});
