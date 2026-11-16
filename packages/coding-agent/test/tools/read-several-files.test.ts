import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let cwd: string;
let tool: ReadTool;

function text(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-several-"));
	await Bun.write(
		path.join(cwd, "one.txt"),
		`${Array.from({ length: 30 }, (_, i) => `one-line-${i + 1}.`).join("\n")}\n`,
	);
	await Bun.write(
		path.join(cwd, "two.txt"),
		`${Array.from({ length: 30 }, (_, i) => `two-line-${i + 1}.`).join("\n")}\n`,
	);
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
	tool = new ReadTool(session);
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

describe("read several files in one call", () => {
	it("returns each file's own range from a `;` list", async () => {
		const out = text(
			await tool.execute("probe", { path: "one.txt:3-5;two.txt:20-22" }),
		);
		expect(out).toContain("one-line-3.");
		expect(out).toContain("one-line-5.");
		expect(out).not.toContain("one-line-20.");
		expect(out).toContain("two-line-20.");
		expect(out).toContain("two-line-22.");
		expect(out).not.toContain("two-line-3.");
	});
});

describe("read description advertises `;` lists only when OMP_BATCH_TOOLS=1", () => {
	const withEnv = (value: string | undefined): string => {
		const before = process.env.OMP_BATCH_TOOLS;
		if (value === undefined) delete process.env.OMP_BATCH_TOOLS;
		else process.env.OMP_BATCH_TOOLS = value;
		try {
			return tool.description;
		} finally {
			if (before === undefined) delete process.env.OMP_BATCH_TOOLS;
			else process.env.OMP_BATCH_TOOLS = before;
		}
	};

	it("names the `;` list with per-file selectors when the switch is on", () => {
		const description = withEnv("1");
		expect(description).toContain("Several files in one call");
		expect(description).toContain("a.ts:1-40;b.ts:200-230");
	});

	it("leaves the default description untouched when the switch is off or unset", () => {
		const unset = withEnv(undefined);
		expect(unset).not.toContain("Several files in one call");
		expect(withEnv("0")).toBe(unset);
		expect(
			withEnv("1").replace(/\n?- Several files in one call[^\n]*/, ""),
		).toBe(unset);
	});
});
