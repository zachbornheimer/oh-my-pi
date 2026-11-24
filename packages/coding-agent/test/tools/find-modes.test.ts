import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inferFindMode, resolveFindCall, scopeWithGlob } from "../../src/tools/jfind/modes";
import { missingPathMessage, missingPathRecovery } from "../../src/tools/path-utils";

describe("find mode resolution", () => {
	it("picks the engine the supplied arguments point at", () => {
		expect(resolveFindCall({ query: "where is retry handled" }).mode).toBe("semantic");
		expect(resolveFindCall({ pattern: "TODO", glob: "*.ts" }).mode).toBe("content");
		expect(resolveFindCall({ glob: "src/**/*.ts" }).mode).toBe("names");
		expect(resolveFindCall({ path: "src" }).mode).toBe("names");
	});

	it("infers a mode without throwing so approval can classify an invalid call", () => {
		expect(inferFindMode({ query: "x", pattern: "y" })).toBe("content");
		expect(inferFindMode({})).toBe("semantic");
	});

	it("runs an exact pattern when a judged query is mixed in, and says the query was not used", () => {
		const call = resolveFindCall({ query: "retry", pattern: "retry" });
		expect(call.mode).toBe("content");
		expect(call.notes).toHaveLength(1);
		expect(call.notes[0]).toContain("`query` was not used");
		expect(call.notes[0]).toContain("Drop `pattern`");
		expect(resolveFindCall({ query: "retry", glob: "*.ts" }).mode).toBe("semantic");
	});

	it("refuses only a call with nothing to search for, listing the three modes", () => {
		let message = "";
		try {
			resolveFindCall({});
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("`query`");
		expect(message).toContain("`pattern`");
		expect(message).toContain("`glob`");
		expect(() => resolveFindCall({ query: "  ", pattern: null as never })).toThrow(/needs something to search for/);
	});

	it("ignores arguments left at their defaults without comment", () => {
		// What a model echoes from the schema: every optional key at its omitted value.
		const echoed = { path: "sub", case: true, gitignore: true, hidden: false, limit: 50, skip: 0 };
		const call = resolveFindCall(echoed);
		expect(call.mode).toBe("names");
		expect(call.notes).toEqual([]);
		expect(resolveFindCall({ pattern: "x", limit: 200, skip: null, glob: undefined }).notes).toEqual([
			`\`limit\` does not apply to content mode and was not used (${"`pattern` (+ `glob`, `path`, `case`, `gitignore`, `skip`): exact regex over file contents"}).`,
		]);
	});

	it("reports a meaningful argument the chosen mode did not use", () => {
		const call = resolveFindCall({ pattern: "x", hidden: true });
		expect(call.mode).toBe("content");
		expect(call.notes[0]).toContain("`hidden` does not apply to content mode and was not used");
		expect(resolveFindCall({ glob: "*.ts", case: false }).notes[0]).toContain("`case` does not apply to names mode");
	});
});

describe("find scope joining", () => {
	it("applies each glob to each root", () => {
		expect(scopeWithGlob("src;lib/", "*.ts;*.tsx")).toBe("src/*.ts;src/*.tsx;lib/*.ts;lib/*.tsx");
	});

	it("uses the globs alone when no path is given", () => {
		expect(scopeWithGlob(undefined, "**/*.md")).toBe("**/*.md");
	});

	it("leaves the path untouched without a glob", () => {
		expect(scopeWithGlob("src;!**/*.test.ts", undefined)).toBe("src;!**/*.test.ts");
	});

	it("passes exclusions through instead of attaching a glob to them", () => {
		expect(scopeWithGlob("src;!**/*.test.ts", "*.ts")).toBe("src/*.ts;!**/*.test.ts");
	});

	it("refuses a glob on a path that is already a glob", () => {
		expect(() => scopeWithGlob("src/**/*.ts", "*.md")).toThrow(/already contains a glob/);
	});
});

describe("missing path recovery", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "find-missing-"));
		await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Config.ts"), "export {};\n");
		await fs.writeFile(path.join(cwd, "src", "deep", "unique-name.ts"), "export {};\n");
		await fs.writeFile(path.join(cwd, "README.md"), "# x\n");
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("names the unique file whose trailing path matches", async () => {
		const recovery = await missingPathRecovery("deep/unique-name.ts", cwd);
		expect(recovery).toContain("Did you mean");
		expect(recovery).toContain("unique-name.ts");
	});

	it("names the same file differing only by case", async () => {
		const recovery = await missingPathRecovery("src/config.ts", cwd);
		expect(recovery).toContain("Config.ts");
		expect(recovery).toContain("case-sensitive");
	});

	it("lists what the nearest existing directory holds when nothing resembles the path", async () => {
		const recovery = await missingPathRecovery("src/nothing/here.ts", cwd);
		expect(recovery).toContain("`src` exists and holds");
		expect(recovery).toContain("deep/");
		expect(recovery).toContain("Config.ts");
	});

	it("has nothing to add for URLs", async () => {
		expect(await missingPathRecovery("local://missing.md", cwd)).toBeUndefined();
		expect(await missingPathMessage("local://missing.md", cwd)).toBe("Path not found: local://missing.md");
	});

	it("keeps the plain message first so callers can still match on it", async () => {
		const message = await missingPathMessage("src/nothing/here.ts", cwd);
		expect(message.startsWith("Path not found: src/nothing/here.ts. ")).toBe(true);
	});
});
