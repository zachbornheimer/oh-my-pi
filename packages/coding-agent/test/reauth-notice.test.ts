import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	registerOAuthProvider,
	unregisterOAuthProviders,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { CredentialDisabledNotices } from "@oh-my-pi/pi-coding-agent/session/credential-disabled-notice";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const oauth = (email: string, orgId = "org-a"): OAuthCredential => ({
	type: "oauth",
	access: `fake-${email}`,
	refresh: "fixture-only",
	expires: Date.now() + 3600000,
	email,
	orgId,
});
const cause = "oauth refresh failed: invalid_grant";
beforeAll(() => initTheme(false));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "omp-reauth-proof-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const store = await SqliteAuthCredentialStore.open(join(dir, "broker.db"));
	const brokerStorage = new AuthStorage(store);
	cleanups.push(() => brokerStorage.close());
	await brokerStorage.credentials.reload();
	const server = startAuthBroker({
		storage: brokerStorage,
		bind: "127.0.0.1:0",
		bearerTokens: ["fixture"],
		disableRefresher: true,
	});
	cleanups.push(() => server.close());
	await store.saveOAuth("anthropic", oauth("alice@example.test"));
	await store.saveOAuth("anthropic", oauth("bob@example.test"));
	await store.saveOAuth("anthropic", oauth("healthy@example.test"));
	for (const email of ["alice@example.test", "bob@example.test"]) {
		const row = store
			.listAuthCredentials()
			.find(row => row.credential.type === "oauth" && row.credential.email === email)!;
		await store.deleteAuthCredential(row.id, cause);
	}
	await brokerStorage.credentials.reload();
	const client = new AuthBrokerClient({ url: server.url, token: "fixture" });
	const snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) throw new Error("expected initial broker snapshot");
	const remote = new RemoteAuthCredentialStore({ client, initialSnapshot: snapshot.snapshot, streamSnapshots: false });
	const storage = new AuthStorage(remote);
	cleanups.push(() => storage.close());
	await storage.credentials.reload();
	const ctx = createInteractiveModeContext();
	const controller = new EventController(ctx);
	const dispatched: Promise<void>[] = [];
	const published: Array<{ key: string; message: string }> = [];
	const notices = new CredentialDisabledNotices(storage.credentials, (key, message) => {
		published.push({ key, message });
		dispatched.push(
			controller.dispatchSessionEvent({
				type: "notice",
				level: "warning",
				source: "auth",
				persistentKey: key,
				message,
			}),
		);
	});
	cleanups.push(() => notices.close());
	const settle = async () => {
		await notices.reconcile();
		await Promise.all(dispatched);
	};
	const render = () => ctx.credentialNoticeContainer.render(120).join("\n");
	return { store, storage, brokerStorage, remote, ctx, controller, notices, settle, render, published };
}

describe("persistent account recovery notice", () => {
	it("reconciles startup failures into retained TUI rows, deduplicates, and clears only the account restored through broker login", async () => {
		const f = await fixture();
		await f.settle();
		expect(f.render()).toContain("alice@example.test");
		expect(f.render()).toContain("bob@example.test");
		expect(f.render()).toContain("/login");
		expect(f.render()).not.toContain("invalid_grant");
		await f.controller.handleEvent({ type: "notice", level: "info", message: "ordinary status" });
		await f.controller.handleEvent({ type: "agent_start" });
		f.ctx.statusContainer.clear();
		expect(f.render()).toContain("alice@example.test");
		expect(f.render()).toContain("bob@example.test");
		await f.settle();
		expect(f.published).toHaveLength(2);
		// The healthy sibling remains selectable; the notice never disables it.
		expect(await f.storage.keys.get("anthropic", "fixture-session")).toBe("fake-healthy@example.test");
		registerOAuthProvider({
			id: "reauth-fixture",
			name: "Recovery fixture",
			sourceId: "reauth-proof",
			storeCredentialsAs: "anthropic",
			login: async () => oauth("alice@example.test"),
		});
		cleanups.push(() => unregisterOAuthProviders("reauth-proof"));
		await f.storage.oauth.login("reauth-fixture", { onAuth() {}, onPrompt: async () => "" });
		await f.settle();
		expect(f.render()).not.toContain("alice@example.test");
		expect(f.render()).toContain("bob@example.test");
		expect(f.storage.credentials.list("anthropic")).toHaveLength(2);
	});

	it("surfaces a disable missed while offline when an authoritative reconnect snapshot arrives", async () => {
		const f = await fixture();
		await f.settle();
		const row = f.store.listAuthCredentials("anthropic")[0]!;
		await f.store.deleteAuthCredential(row.id, cause);
		await f.brokerStorage.credentials.reload();
		await f.remote.refreshSnapshot();
		await f.settle();
		expect(f.render()).toContain("healthy@example.test");
	});

	it("reconciles a reconnect even when active credentials have not changed", async () => {
		const f = await fixture();
		await f.settle();
		await f.store.saveOAuth("anthropic", oauth("offline@example.test"));
		const row = f.store
			.listAuthCredentials()
			.find(row => row.credential.type === "oauth" && row.credential.email === "offline@example.test")!;
		await f.store.deleteAuthCredential(row.id, cause);
		await f.brokerStorage.credentials.reload();
		const changed = Promise.withResolvers<void>();
		const unsubscribe = f.storage.credentials.onGeneration(() => changed.resolve());
		try {
			await f.remote.refreshSnapshot();
			await changed.promise;
			await f.settle();
			expect(f.render()).toContain("offline@example.test");
		} finally {
			unsubscribe();
		}
	});

	it("does not resurrect recovered, manual logout, replacement, identity-less, or wrong-organization rows", async () => {
		const f = await fixture();
		for (const [email, reason] of [
			["manual@example.test", "deleted by user"],
			["replaced@example.test", "replaced by newer credential"],
		]) {
			await f.store.saveOAuth("anthropic", oauth(email));
			const row = f.store
				.listAuthCredentials()
				.find(row => row.credential.type === "oauth" && row.credential.email === email)!;
			await f.store.deleteAuthCredential(row.id, reason);
		}
		await f.store.saveOAuth("anthropic", oauth("alice@example.test", "org-b"));
		await f.store.saveOAuth("anthropic", oauth("bob@example.test"));
		await f.brokerStorage.credentials.reload();
		await f.remote.refreshSnapshot();
		await f.settle();
		expect(f.render()).not.toContain("manual@example.test");
		expect(f.render()).not.toContain("replaced@example.test");
		expect(f.render()).not.toContain("bob@example.test");
		expect(f.render()).toContain("alice@example.test");
	});

	it("hides tombstones outside the broker account pool used for active credentials", async () => {
		const f = await fixture();
		const restricted = new RemoteAuthCredentialStore({
			client: f.remote.client,
			initialSnapshot: f.remote.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set(["email:alice@example.test|org:org-a"])]]),
		});
		cleanups.push(() => restricted.close());
		expect((await restricted.listDisabledCredentials()).map(row => row.email)).toEqual(["alice@example.test"]);
	});

	it("ignores an older reconciliation after a newer disable and retains it until restoration", async () => {
		const f = await fixture();
		await f.settle();
		const delayed = Promise.withResolvers<Awaited<ReturnType<typeof f.storage.credentials.listDisabled>>>();
		const read = vi.spyOn(f.storage.credentials, "listDisabled").mockImplementationOnce(() => delayed.promise);
		const pending = f.notices.reconcile();
		f.notices.disabled({ provider: "anthropic", email: "new@example.test", disabledCause: cause });
		delayed.resolve([]);
		await pending;
		await f.settle();
		expect(f.render()).toContain("new@example.test");
		read.mockRestore();
	});

	it("retains an existing notice when tombstone retrieval fails and never publishes after disposal", async () => {
		const f = await fixture();
		await f.settle();
		const previous = f.render();
		const failure = vi.spyOn(f.storage.credentials, "listDisabled").mockRejectedValue(new Error("broker offline"));
		await f.settle();
		expect(f.render()).toBe(previous);
		f.notices.close();
		failure.mockRestore();
		await f.settle();
		expect(f.published).toHaveLength(2);
	});
});
