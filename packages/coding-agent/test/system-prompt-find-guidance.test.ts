import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../src/system-prompt";

async function specialized(names: string[]): Promise<string> {
	const tools = new Map(names.map(name => [name, { name, label: name, description: name }] as const));
	const { systemPrompt } = await buildSystemPrompt({
		cwd: "/tmp",
		personality: "none",
		activeRepoContext: null,
		contextFiles: [],
		skills: [],
		tools: tools as never,
		toolNames: names,
	} as never);
	const text = systemPrompt.join("\n");
	const start = text.indexOf("# Specialized Tools");
	return text.slice(start, text.indexOf("\n#", start + 1));
}

describe("system prompt find guidance", () => {
	it("sends known names and literals to grep and glob, and keeps find for behavior-only searches", async () => {
		const section = await specialized(["find", "grep", "glob"]);
		expect(section).toContain("search it directly with `grep` (file names: `glob`)");
		expect(section).toContain("Use `find` only when you have no name or literal to start from");
		expect(section).not.toContain("FIRST");
	});

	it("names no tool that is not active when only find is available", async () => {
		const section = await specialized(["find"]);
		expect(section).toContain("search it directly.");
		expect(section).not.toContain("grep");
		expect(section).not.toContain("glob");
	});
});
