/**
 * MCP cancellation contract for in-flight calls (at-h3cq90).
 *
 * Upstream PR #16430 delivered the stdio half: after local abort/timeout one
 * fire-and-forget `notifications/cancelled` with the original request id. The
 * HTTP half is missing. Per the MCP spec (findings.md §2.2):
 *  - 2025-11-25 Streamable HTTP: a bare disconnect SHOULD NOT count as
 *    cancellation, so omp must also POST `notifications/cancelled`;
 *  - 2026-07-28: closing the response stream is the cancel (support PR #8167
 *    unmerged — omp negotiates 2025-11-25 today).
 *
 * Contract under test:
 *  - cancelling an in-flight HTTP request POSTs `notifications/cancelled`
 *    naming that request's id (fire-and-forget, not awaited);
 *  - only the cancelled request id is named — a concurrent request keeps its
 *    own id and is never cancelled;
 *  - `initialize` is never cancelled;
 *  - a late response to a cancelled request is ignored without dropping the
 *    transport (Claude Code regressed here, v2.1.105-119);
 *  - one call's cancellation never closes the shared connection.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import type { JsonRpcNotification, JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";

let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

interface CancelLog {
	posts: JsonRpcRequest[];
	cancels: { requestId: unknown; reason?: unknown }[];
}

function newLog(): CancelLog {
	return { posts: [], cancels: [] };
}

/**
 * Parse one MCP POST body: notifications land in `log.cancels` and get 202;
 * requests land in `log.posts` and reach `respond`.
 */
async function routeBody(
	log: CancelLog,
	req: Request,
	respond: (body: JsonRpcRequest) => Response | Promise<Response>,
): Promise<Response> {
	const body = (await req.json()) as JsonRpcRequest | JsonRpcNotification;
	if (!("id" in body)) {
		if (body.method === "notifications/cancelled") {
			const params = body.params as { requestId?: unknown; reason?: unknown } | undefined;
			log.cancels.push({ requestId: params?.requestId, reason: params?.reason });
		}
		return new Response(null, { status: 202 });
	}
	log.posts.push(body);
	return respond(body);
}

async function connected(url: string, timeout = 5_000): Promise<HttpTransport> {
	const transport = new HttpTransport({ type: "http", url, timeout });
	await transport.connect();
	return transport;
}

const initializeResult = (id: unknown) =>
	Response.json({
		jsonrpc: "2.0",
		id,
		result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" } },
	});

describe("MCP Streamable HTTP cancellation", () => {
	it("POSTs notifications/cancelled naming the cancelled request id when a request is aborted", async () => {
		const log = newLog();
		const hanging = Promise.withResolvers<Response>();
		// The request hangs until the caller aborts; the fetch abort is what
		// must additionally produce the 2025-11-25 cancel notification.
		server = Bun.serve({
			port: 0,
			fetch: req =>
				routeBody(log, req, body => {
					if (body.method === "initialize") return initializeResult(body.id);
					return hanging.promise;
				}),
		});
		const transport = await connected(`http://127.0.0.1:${server.port}/mcp`);
		transport.setProtocolVersion("2025-11-25");
		const caller = new AbortController();

		const pending = transport.request("tools/call", { name: "slow" }, { signal: caller.signal });
		const seenDeadline = Date.now() + 2_000;
		while (log.posts.length === 0 && Date.now() < seenDeadline) await Bun.sleep(5);
		const sent = log.posts[0];
		caller.abort();

		await expect(pending).rejects.toThrow();
		// The cancel is fire-and-forget; give it a bounded window to arrive.
		const deadline = Date.now() + 2_000;
		while (log.cancels.length === 0 && Date.now() < deadline) await Bun.sleep(5);

		expect(log.cancels).toHaveLength(1);
		expect(log.cancels[0].requestId).toBe(sent.id);
		expect(log.cancels[0].reason).toBe("Request cancelled by the client");
		await transport.close();
	});

	it("cancels only the aborted request's id, never initialize or a concurrent call", async () => {
		const log = newLog();
		const hanging = new Map<string | number, PromiseWithResolvers<Response>>();
		server = Bun.serve({
			port: 0,
			fetch: req =>
				routeBody(log, req, body => {
					if (body.method === "initialize") return initializeResult(body.id);
					const resolvers = Promise.withResolvers<Response>();
					hanging.set(body.id, resolvers);
					return resolvers.promise;
				}),
		});
		const transport = await connected(`http://127.0.0.1:${server.port}/mcp`);
		transport.setProtocolVersion("2025-11-25");
		const caller = new AbortController();

		// Two concurrent calls; only the first is aborted.
		const first = transport.request("tools/call", { name: "a" }, { signal: caller.signal });
		const second = transport.request("tools/call", { name: "b" });
		const requestDeadline = Date.now() + 2_000;
		while (hanging.size < 2 && Date.now() < requestDeadline) await Bun.sleep(5);
		expect(hanging.size).toBe(2);
		const firstBody = log.posts.find(p => p.params && (p.params as { name?: string }).name === "a");
		const secondBody = log.posts.find(p => p.params && (p.params as { name?: string }).name === "b");

		caller.abort();
		await expect(first).rejects.toThrow();

		const cancelDeadline = Date.now() + 2_000;
		while (log.cancels.length === 0 && Date.now() < cancelDeadline) await Bun.sleep(5);
		expect(log.cancels).toHaveLength(1);
		expect(log.cancels[0].requestId).toBe(firstBody?.id);
		// The surviving request keeps its own id, and `initialize` never appears.
		expect(log.cancels.map(c => c.requestId)).not.toContain(secondBody?.id);
		const initBody = log.posts.find(p => p.method === "initialize");
		expect(log.cancels.map(c => c.requestId)).not.toContain(initBody?.id);

		// The shared connection is still usable: the second request settles normally.
		hanging.get(secondBody!.id)?.resolve(Response.json({ jsonrpc: "2.0", id: secondBody!.id, result: { ok: true } }));
		await expect(second).resolves.toEqual({ ok: true });

		await transport.close();
	});

	it("tolerates a late response to a cancelled request without dropping the transport", async () => {
		const log = newLog();
		const responses = new Map<string | number, PromiseWithResolvers<Response>>();
		server = Bun.serve({
			port: 0,
			fetch: req =>
				routeBody(log, req, body => {
					if (body.method === "initialize") return initializeResult(body.id);
					const resolvers = Promise.withResolvers<Response>();
					responses.set(body.id, resolvers);
					return resolvers.promise;
				}),
		});
		const transport = await connected(`http://127.0.0.1:${server.port}/mcp`);
		transport.setProtocolVersion("2025-11-25");
		const caller = new AbortController();

		const first = transport.request("tools/call", { name: "a" }, { signal: caller.signal });
		const requestDeadline = Date.now() + 2_000;
		while (log.posts.length === 0 && Date.now() < requestDeadline) await Bun.sleep(5);
		const firstId = log.posts[0].id;
		caller.abort();
		await expect(first).rejects.toThrow();

		// The server answers late, after the cancel. The transport must ignore
		// it rather than tearing down the shared connection.
		responses.get(firstId)?.resolve(Response.json({ jsonrpc: "2.0", id: firstId, result: { stale: true } }));

		// A subsequent request on the same transport still works.
		const second = transport.request("tools/call", { name: "b" });
		const secondDeadline = Date.now() + 2_000;
		while (log.posts.length < 2 && Date.now() < secondDeadline) await Bun.sleep(5);
		const secondId = log.posts[1].id;
		responses.get(secondId)?.resolve(Response.json({ jsonrpc: "2.0", id: secondId, result: { ok: true } }));
		await expect(second).resolves.toEqual({ ok: true });
		expect(transport.connected).toBe(true);

		await transport.close();
	});
});
