import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgReadSummarizeEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	cfgReadSummarizeEnabled.set(settings, false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as ToolSession;
}

/** The message a read of `target` fails with, or the text it returned when it did not fail. */
async function readOutcome(tool: ReadTool, target: string): Promise<string> {
	try {
		const result = await tool.execute("read-wrong-path", { path: target });
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("read of a path that does not exist", () => {
	let dir: string;
	let tool: ReadTool;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-missing-recovery-"));
		await fs.mkdir(path.join(dir, "src", "billing"), { recursive: true });
		await fs.writeFile(path.join(dir, "src", "billing", "invoice-totals.ts"), "export const total = 1;\n");
		await fs.writeFile(path.join(dir, "src", "main.ts"), "export const main = 1;\n");
		tool = new ReadTool(createSession(dir));
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	it("reads the one workspace file whose path ends the same way and says it resolved the path", async () => {
		const outcome = await readOutcome(tool, "billing/invoice-totals.ts");
		expect(outcome).toContain("resolved to 'src/billing/invoice-totals.ts' via suffix match");
		expect(outcome).toContain("export const total = 1;");
	});

	it("names the same name in its real case", async () => {
		const outcome = await readOutcome(tool, "SRC/main.ts");
		expect(outcome).toContain("Did you mean");
		expect(outcome).toContain("src");
	});

	it("lists what the nearest existing directory holds when nothing resembles the path", async () => {
		const outcome = await readOutcome(tool, "src/nothing/here.ts");
		expect(outcome).toContain("not found");
		expect(outcome).toMatch(/`src` exists and holds: .*main\.ts/);
	});

	it("keeps the plain not-found failure for a URL, which has no workspace to search", async () => {
		const outcome = await readOutcome(tool, "local://missing-note.md");
		expect(outcome).not.toContain("Did you mean");
		expect(outcome).not.toContain("exists and holds");
	});
});
