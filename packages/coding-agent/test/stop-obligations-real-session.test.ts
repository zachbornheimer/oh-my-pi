/**
 * Real pipeline: createAgentSession loads two independent inline extensions, each a `session_stop` hook, and
 * a stubborn writer (a mock model that never does the required work) keeps ending its turn. Nothing here is a
 * runner double: attribution, the registry, schema validation, tool_call hooks and persistence are production.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Type } from "@oh-my-pi/omptype/typebox";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface Harness {
	session: AgentSession;
	writerTurns: () => number;
}

describe("stop obligations through the real session pipeline", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		resetSettingsForTest();
	});

	async function start(extensions: ExtensionFactory[]): Promise<Harness> {
		const dir = TempDir.createSync("omp-stop-obligations-");
		cleanups.push(() => dir.removeSync());
		const registry = new ModelRegistry(createInMemoryAuthStorage());
		registry.authStorage.keys.setRuntime("openai", "test-key");
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: "off",
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		cleanups.push(() => session.dispose());
		// The writer is stubborn: it answers every turn with a refusal and never calls a tool.
		const provider = createMockModel({ handler: () => ({ content: ["I will not do that; my diff is six lines."] }) });
		session.agent.streamFn = provider.stream;
		return { session, writerTurns: () => provider.calls.length };
	}

	/** A hook that blocks until `fixed()` says the work is done, offering `action` once it is stuck. */
	function reviewHook(state: { fixed: boolean; actionRuns: string[]; rechecks: number }): ExtensionFactory {
		return pi => {
			pi.registerTool({
				name: "review_rewrite",
				label: "review rewrite",
				description: "Performs the required rewrite.",
				parameters: Type.Object({ target: Type.String() }, { additionalProperties: false }),
				execute: async (_id, params) => {
					state.actionRuns.push(params.target);
					state.fixed = true;
					return { content: [{ type: "text", text: "rewritten" }], details: {} };
				},
			});
			pi.on("session_stop", () => {
				state.rechecks++;
				if (state.fixed) return undefined;
				return {
					decision: "block" as const,
					reason: "ops.ts must be rewritten.",
					obligation: {
						id: "design-review",
						progress: "ops-src-1",
						action: { tool: "review_rewrite", args: { target: "ops.ts" }, basis: "ops-src-1" },
					},
				};
			});
		};
	}

	/** A second, unrelated hook: text-only, no action. */
	function docsHook(state: { satisfied: boolean }): ExtensionFactory {
		return pi => {
			pi.on("session_stop", () =>
				state.satisfied ? undefined : { decision: "block" as const, reason: "CHANGELOG entry is missing." },
			);
		};
	}

	it("runs the hook's registered action when a stubborn writer ignores the block, and only the hook's recheck clears it", async () => {
		const state = { fixed: false, actionRuns: [] as string[], rechecks: 0 };
		const { session, writerTurns } = await start([reviewHook(state)]);

		await session.prompt("fix ops.ts");
		await session.waitForIdle();

		// The writer refused every time; the HOST ran the action, then the hook re-judged and cleared.
		expect(state.actionRuns).toEqual(["ops.ts"]);
		expect(writerTurns()).toBe(2);
		expect(session.stopObligations).toEqual([]);
	});

	it("a text-only hook with a stubborn writer ends paused, recorded as pending, never as success", async () => {
		const docs = { satisfied: false };
		const { session, writerTurns } = await start([docsHook(docs)]);

		await session.prompt("fix ops.ts");
		await session.waitForIdle();

		expect(writerTurns()).toBe(3);
		expect(session.stopObligations.map(record => [record.id, record.status])).toEqual([["block", "paused"]]);

		// Only an explicit user cancel (or the hook itself clearing) discharges it.
		expect(session.cancelStopObligations({ id: "block" })).toHaveLength(1);
		expect(session.stopObligations).toEqual([]);
	});

	it("two independent hooks share the mechanism: the action-capable one is repaired, the text-only one stays owed", async () => {
		const review = { fixed: false, actionRuns: [] as string[], rechecks: 0 };
		const docs = { satisfied: false };
		const { session } = await start([reviewHook(review), docsHook(docs)]);

		await session.prompt("fix ops.ts");
		await session.waitForIdle();

		expect(review.actionRuns).toEqual(["ops.ts"]);
		const owed = session.stopObligations.map(record => record.id);
		expect(owed).toContain("block");
		expect(owed).not.toContain("design-review");

		// The docs hook clearing is what clears its obligation; the review hook's success did not.
		docs.satisfied = true;
		await session.prompt("continue");
		await session.waitForIdle();
		expect(session.stopObligations).toEqual([]);
	});

	it("runs the action through the normal tool_call gate: a handler that blocks it keeps it from running, and the obligation pauses", async () => {
		const state = { fixed: false, actionRuns: [] as string[], rechecks: 0 };
		const gate: ExtensionFactory = pi => {
			pi.on("tool_call", event =>
				event.toolName === "review_rewrite" ? { block: true, reason: "not approved" } : undefined,
			);
		};
		const { session } = await start([reviewHook(state), gate]);
		await session.prompt("fix ops.ts");
		await session.waitForIdle();
		expect(state.actionRuns).toEqual([]);
		expect(session.stopObligations.map(record => [record.id, record.status])).toEqual([["design-review", "paused"]]);
	});

	it("rejects an action whose tool the issuing extension did not register, leaving the obligation paused", async () => {
		const victim = { fixed: false, actionRuns: [] as string[], rechecks: 0 };
		const hijacker: ExtensionFactory = pi => {
			pi.on("session_stop", () => ({
				decision: "block" as const,
				reason: "r",
				obligation: {
					id: "o",
					progress: "p",
					// Another extension's tool, not the hijacker's own: the host must refuse to run it.
					action: { tool: "review_rewrite", args: { target: "hijacked" }, basis: "p" },
				},
			}));
		};
		// The victim extension registers review_rewrite (and blocks nothing: it is already fixed).
		victim.fixed = true;
		const { session, writerTurns } = await start([reviewHook(victim), hijacker]);
		await session.prompt("go");
		await session.waitForIdle();
		expect(victim.actionRuns).toEqual([]);
		// Rejected at the second stop, not after waiting out the no-progress count.
		expect(writerTurns()).toBe(2);
		expect(session.stopObligations.map(record => record.status)).toEqual(["paused"]);
	});

	it("still evaluates the required stop checks when compaction blocks continuation, and never ends as success", async () => {
		// The run's context cannot be compacted, so no further model turn may start (the real 402k-token escape).
		const blockedCompaction = spyOn(SessionMaintenance.prototype, "checkCompaction").mockResolvedValue({
			continuationScheduled: false,
			automaticContinuationBlocked: true,
		});
		cleanups.push(() => blockedCompaction.mockRestore());
		let stopsHeard = 0;
		const hook: ExtensionFactory = pi => {
			pi.on("session_stop", () => {
				stopsHeard++;
				return { decision: "block" as const, reason: "ops.ts must be rewritten." };
			});
		};
		const { session, writerTurns } = await start([hook]);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		await session.prompt("fix ops.ts");
		await session.waitForIdle();

		// The hook was asked even though no turn can follow, its block is owed (print mode exits 4), and the writer ran once.
		expect(stopsHeard).toBe(1);
		expect(writerTurns()).toBe(1);
		expect(session.stopObligations.map(record => record.status)).toEqual(["pending"]);
		expect(notices.some(message => message.includes("not a success"))).toBe(true);
	});
});
