/**
 * Contract: retained account-recovery notices are host-owned UI state.
 *
 * A guest cannot run the host's `/login`, never sees the matching retained row on join, and would receive a retraction
 * for a warning it never displayed. Ordinary notices still mirror.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { type HostObservations, instrumentRelay, makeHostContext, type Snapshot, waitFor } from "./helpers/throttled-host";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		uninstallInMemoryRelay();
	}
});

it("keeps keyed account-recovery notices and their retractions off the guest wire", async () => {
	const relay = installInMemoryRelay();
	instrumentRelay(relay, { throttle: false });
	const snapshot: Snapshot = {
		header: { type: "session", id: "local-notice", timestamp: "2026-11-25T00:00:00Z", cwd: "/tmp" },
		entries: [],
	};
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	const listeners: AgentSessionEventListener[] = [];
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	ctx.session.subscribe = listener => {
		listeners.push(listener);
		return subscribe(listener);
	};
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => guest.close());
	const events: AgentSessionEvent[] = [];
	const welcomed = Promise.withResolvers<void>();
	guest.onFrame = (frame: CollabFrame) => {
		if (frame.t === "welcome") welcomed.resolve();
		if (frame.t === "event") events.push(frame.event as AgentSessionEvent);
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "watcher" });
	guest.connect();
	await welcomed.promise;
	await waitFor(() => seen.participantCounts.some(count => count > 0), "host never registered the guest");

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	emit({ type: "notice", level: "warning", message: "Account needs /login", source: "auth", persistentKey: "a" });
	emit({ type: "notice", level: "warning", message: "", source: "auth", persistentKey: "a" });
	emit({ type: "notice", level: "info", message: "ordinary host notice", source: "collab" });
	await waitFor(
		() => events.some(event => event.type === "notice" && event.message === "ordinary host notice"),
		"ordinary notice did not mirror",
	);
	expect(events.filter(event => event.type === "notice" && event.persistentKey !== undefined)).toEqual([]);
});
