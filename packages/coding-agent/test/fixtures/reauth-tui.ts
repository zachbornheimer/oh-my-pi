// Run with `mise run proof:reauth-tui`. All state lives under a throwaway directory.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "omp-reauth-terminal-"));
// Dynamic imports intentionally test the module-loading boundary: static imports
// would capture real HOME/config directories before isolation is established.
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
delete process.env.OMP_AUTH_BROKER_URL;
delete process.env.OMP_AUTH_BROKER_TOKEN;
const { AuthStorage, SqliteAuthCredentialStore, registerOAuthProvider, unregisterOAuthProviders } =
	await import("@oh-my-pi/pi-ai");
const { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker");
const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
const { InteractiveMode } = await import("@oh-my-pi/pi-coding-agent/modes/interactive-mode");
const { Composer } = await import("@oh-my-pi/pi-tui/prompt/composer");
const { Text } = await import("@oh-my-pi/pi-tui");
const { initTheme } = await import("@oh-my-pi/pi-tui/theme");
const { VirtualTerminal } = await import("../../../tui/test/virtual-terminal");
const { SelectorController } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller");

await mkdir(join(root, "agent"), { recursive: true });
const store = await SqliteAuthCredentialStore.open(join(root, "broker.db"));
const brokerStorage = new AuthStorage(store);
await brokerStorage.credentials.reload();
const server = startAuthBroker({
	storage: brokerStorage,
	bind: "127.0.0.1:0",
	bearerTokens: ["throwaway"],
	disableRefresher: true,
});
const oauth = (email: string) => ({
	type: "oauth" as const,
	access: `fixture-${email}`,
	refresh: "fixture-not-a-token",
	expires: Date.now() + 3600000,
	email,
});
registerOAuthProvider({
	id: "reauth-fixture",
	name: "Recovery fixture",
	sourceId: "reauth-terminal",
	login: async () => oauth("alice@example.test"),
});
for (const email of ["alice@example.test", "bob@example.test", "healthy@example.test"])
	await store.saveOAuth("reauth-fixture", oauth(email));
for (const row of store.listAuthCredentials()) {
	if (row.credential.type === "oauth" && row.credential.email !== "healthy@example.test")
		await store.deleteAuthCredential(row.id, "oauth refresh failed: invalid_grant");
}
await brokerStorage.credentials.reload();
const client = new AuthBrokerClient({ url: server.url, token: "throwaway" });
const snapshot = await client.fetchSnapshot();
if (snapshot.status !== 200) throw new Error("expected initial broker snapshot");
const remote = new RemoteAuthCredentialStore({ client, initialSnapshot: snapshot.snapshot });
const storage = new AuthStorage(remote);
await storage.credentials.reload();
await Settings.init({ inMemory: true, cwd: root });
const registry = new ModelRegistry(storage, join(root, "models.yml"));
const { session } = await createAgentSession({
	cwd: root,
	agentDir: join(root, "agent"),
	authStorage: storage,
	modelRegistry: registry,
	settings: Settings.isolated(),
	sessionManager: SessionManager.inMemory(root),
	disableExtensionDiscovery: true,
	extensions: [],
	skills: [],
	rules: [],
	contextFiles: [],
	promptTemplates: [],
	workspaceTree: { rootPath: root, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
	toolNames: ["read"],
	preloadedCustomToolPaths: [],
	skipPythonPreflight: true,
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});
await initTheme(false);
const term = new VirtualTerminal(140, 32);
const mode = new InteractiveMode(
	session,
	"reauth-proof",
	() => {},
	undefined,
	undefined,
	undefined,
	new Composer({ terminal: term }),
);
const evidence: string[] = [];
const screen = () =>
	term
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.join("\n");
try {
	await mode.init({ suppressWelcomeIntro: true });
	void mode.getUserInput();
	await term.waitForRender(() => screen().includes("alice@example.test") && screen().includes("bob@example.test"));
	evidence.push(`STARTUP\n${screen()}`);
	// Drive real terminal overflow + resize, not only component.render().
	for (let i = 0; i < 60; i++) mode.chatContainer.addChild(new Text(`ordinary transcript row ${i}`, 0, 0));
	mode.ui.requestRender();
	await term.waitForRender(() => screen().includes("ordinary transcript row 59"));
	term.resize(120, 28);
	await term.waitForRender(() => screen().includes("alice@example.test") && screen().includes("bob@example.test"));
	evidence.push(`REDRAW_AND_RESIZE\n${screen()}`);
	if ((await storage.keys.get("reauth-fixture", "proof-fallback")) !== "fixture-healthy@example.test")
		throw new Error("healthy fallback unavailable");
	// The exact controller used by /login invokes broker-backed OAuth login.
	await new SelectorController(mode).showOAuthSelector("login", "reauth-fixture");
	await term.waitForRender(
		() =>
			!mode.credentialNoticeContainer.render(120).join("\n").includes("alice@example.test") &&
			screen().includes("bob@example.test"),
	);
	evidence.push(`AFTER_LOGIN_ALICE\n${screen()}`);
	if (mode.credentialNoticeContainer.render(120).join("\n").includes("alice@example.test"))
		throw new Error("restored account remains pinned");
	if (!mode.credentialNoticeContainer.render(120).join("\n").includes("bob@example.test"))
		throw new Error("unrestored account disappeared");
	console.log(
		"PASS: startup → transcript overflow/terminal resize → healthy fallback → /login controller/broker upload → account-specific clear",
	);
	const evidencePath = process.env.REAUTH_PROOF_OUTPUT;
	if (evidencePath) {
		await writeFile(evidencePath, evidence.join("\n\n"));
		console.log(`Terminal evidence: ${evidencePath}`);
	} else console.log(evidence.join("\n\n"));
} finally {
	mode.stop();
	await session.dispose();
	storage.close();
	await server.close();
	brokerStorage.close();
	unregisterOAuthProviders("reauth-terminal");
	await rm(root, { recursive: true, force: true });
}
