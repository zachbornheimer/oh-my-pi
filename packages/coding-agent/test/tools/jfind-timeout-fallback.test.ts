import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { FIND_TIMEOUT_MS, FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { __piNativesBuildVersion, type GrepOptions, type GrepResult } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import nativePackage from "../../../natives/package.json";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const addonVersion = __piNativesBuildVersion() ?? "unknown";
const integrationLabel = `real grep integration (addon ${addonVersion}, package ${nativePackage.version})`;

describe("find deadline literal fallback", () => {
	let dir: string;
	let deadline: AbortController;
	const literalGrep = vi.fn(async (_options: GrepOptions): Promise<GrepResult> => ({
		matches: [{ path: "target.ts", lineNumber: 1, line: "export const needle = 'token.refresh()';" }],
		totalMatches: 1,
		filesWithMatches: 1,
		filesSearched: 2,
	}));

	function findTool(realGrep = false): FindTool {
		return new FindTool({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "find.enabled": "on" }),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		}, realGrep ? undefined : literalGrep);
	}

	beforeEach(async () => {
		literalGrep.mockClear();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfind-timeout-fallback-"));
		await fs.mkdir(path.join(dir, "scope"));
		await Bun.write(path.join(dir, "scope", "target.ts"), "export const needle = 'token.refresh()';\n");
		await Bun.write(path.join(dir, "scope", "decoy.ts"), "export const needle = 'tokenXrefresh()';\n");
		await Bun.write(path.join(dir, "outside.ts"), "export const needle = 'token.refresh()';\n");
		deadline = new AbortController();
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
			ms === FIND_TIMEOUT_MS ? deadline.signal : realTimeout(ms),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(dir);
	});

	function expireDeadline(): void {
		vi.spyOn(ChainJudge.prototype, "judge").mockImplementation(async () => {
			deadline.abort();
			throw new Error("request aborted");
		});
	}

	async function expectLiteralHits(tool: FindTool): Promise<void> {
		const result = await tool.execute("x", {
			query: "token refresh",
			grep_keywords: ["token.refresh()"],
			path: "scope",
		});
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
		expect(result.isError).not.toBe(true);
		expect(text).toContain("find timed out; showing literal matches for: token.refresh()");
		expect(text).toContain("scope/target.ts:1");
		expect(text).toContain("token.refresh()");
		expect(text).not.toContain("decoy.ts");
		expect(text).not.toContain("outside.ts");
	}

	it("returns injected keyword hits and a note on deadline", async () => {
		expireDeadline();
		await expectLiteralHits(findTool());
		expect(literalGrep).toHaveBeenCalledTimes(1);
		expect(literalGrep.mock.calls[0]?.[0].path).toBe(path.join(dir, "scope"));
		expect(literalGrep.mock.calls[0]?.[0].pattern).toBe("token\\.refresh\\(\\)");
	});

	it.skipIf(addonVersion !== nativePackage.version)(integrationLabel, async () => {
		expireDeadline();
		await expectLiteralHits(findTool(true));
	});

	it("returns the timeout cause and grep/glob guidance without keywords", async () => {
		expireDeadline();
		const result = await findTool().execute("x", { query: "token refresh", grep_keywords: [] });
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
		expect(result.isError).not.toBe(true);
		expect(text).toContain("find timed out");
		expect(text).toContain("grep/glob");
		expect(literalGrep).not.toHaveBeenCalled();
	});

	it("returns literal hits when the caller aborts the model step", async () => {
		const caller = new AbortController();
		vi.spyOn(ChainJudge.prototype, "judge").mockImplementation(async () => {
			caller.abort();
			throw new Error("request aborted");
		});
		const result = await findTool().execute("x", {
			query: "token refresh",
			grep_keywords: ["token.refresh()"],
			path: "scope",
		}, caller.signal);
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
		expect(result.isError).not.toBe(true);
		expect(text).toContain("find aborted; showing literal matches for: token.refresh()");
		expect(text).toContain("scope/target.ts:1");
		expect(literalGrep).toHaveBeenCalledTimes(1);
	});

	it("returns abort guidance without keywords even when the deadline expires too", async () => {
		const caller = new AbortController();
		vi.spyOn(ChainJudge.prototype, "judge").mockImplementation(async () => {
			caller.abort();
			deadline.abort();
			throw new Error("request aborted");
		});
		const result = await findTool().execute("x", {
			query: "token refresh",
			grep_keywords: [],
		}, caller.signal);
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
		expect(result.isError).not.toBe(true);
		expect(text).toContain("find aborted");
		expect(text).toContain("grep/glob");
		expect(literalGrep).not.toHaveBeenCalled();
	});
});
