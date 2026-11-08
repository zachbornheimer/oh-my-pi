import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import {
	diffAriaSnapshot,
	parseAriaRefSelector,
	postProcessAriaSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("parseAriaRefSelector", () => {
	it("accepts the explicit aria-ref prefixes and returns the bare id", () => {
		expect(parseAriaRefSelector("aria-ref=e5")).toBe("e5");
		expect(parseAriaRefSelector("aria-ref/e12")).toBe("e12");
		expect(parseAriaRefSelector("ariaref/e0")).toBe("e0");
		expect(parseAriaRefSelector("  aria-ref=e7  ")).toBe("e7");
	});

	it("accepts bare eN/@eN ids copied straight from snapshot YAML", () => {
		// Agents copy `e501` out of `[ref=e501]` output; treating it as a CSS tag
		// selector guaranteed a zero-match timeout instead of a ref resolution.
		expect(parseAriaRefSelector("e5")).toBe("e5");
		expect(parseAriaRefSelector("@e5")).toBe("e5");
		expect(parseAriaRefSelector(" e501 ")).toBe("e501");
	});

	it("rejects css and other selectors", () => {
		expect(parseAriaRefSelector("button#go")).toBeNull();
		expect(parseAriaRefSelector("text/Submit")).toBeNull();
		expect(parseAriaRefSelector("aria-ref=button")).toBeNull(); // not an eN id
		expect(parseAriaRefSelector("aria-ref=")).toBeNull();
		expect(parseAriaRefSelector("e5x")).toBeNull(); // eN must be the whole selector
		expect(parseAriaRefSelector("section e5")).toBeNull(); // descendant CSS, not a ref
	});

	it("rejects non-string selectors (handle/Promise) with a recovery-naming ToolError", () => {
		// Regression: tab.click(await tab.id(n)) / tab.click(tab.id(n)) used to reach
		// `selector.trim()` and throw the opaque minified `A.trim is not a function`.
		const handle = {
			click: async () => {},
			asElement() {
				return this;
			},
		};
		expect(() => parseAriaRefSelector(handle as never)).toThrow(/must be a string; got an ElementHandle/);
		expect(() => parseAriaRefSelector(handle as never)).toThrow(/\(await tab\.id\(n\)\)\.click\(\)/);
		const promise = Promise.resolve(handle);
		expect(() => parseAriaRefSelector(promise as never)).toThrow(/got a Promise \(missing await\?\)/);
		promise.catch(() => {});
	});
});

describe("buildAriaSnapshotScript", () => {
	describe("snapshot post-processing", () => {
		const snapshot = [
			"- document [ref=e1]:",
			'  - main "Account" [ref=e2]:',
			'    - paragraph "Static copy" [ref=e3]',
			"    - generic [ref=e4]:",
			'      - button "Save" [ref=e5]',
			'    - link "Help" [ref=e6]',
			"    - generic [ref=e7]:",
			'      - paragraph "Details" [ref=e8]',
		].join("\n");

		it("keeps interactive nodes and their ancestor path while dropping static siblings", () => {
			const filtered = postProcessAriaSnapshot(snapshot, { interactive: true });
			expect(filtered).toContain('main "Account" [ref=e2]');
			expect(filtered).toContain('button "Save" [ref=e5]');
			expect(filtered).toContain('link "Help" [ref=e6]');
			expect(filtered).not.toContain("Static copy");
		});

		it("removes empty structural wrappers without removing their contents", () => {
			const compact = postProcessAriaSnapshot(snapshot, { compact: true });
			expect(compact).toContain("generic [ref=e4]");
			expect(compact).not.toContain("generic [ref=e7]");
			expect(compact).toContain('paragraph "Details" [ref=e8]');
		});

		it("appends resolved hrefs to links", () => {
			const decorated = postProcessAriaSnapshot(snapshot, { urls: true }, { e6: "https://example.com/help" });
			expect(decorated).toContain('link "Help" [ref=e6] [href="https://example.com/help"]');
		});
	});

	describe("snapshot diffing", () => {
		it("returns stable unchanged revisions and a smaller line delta", () => {
			const baselines = new Map<string, { url: string; revision: number; snapshot: string }>();
			const initial = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
			const changed = initial.replace("line 15", "changed");
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/a", initial)).toMatchObject({
				status: "full",
				revision: 1,
			});
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/a", initial)).toEqual({
				status: "unchanged",
				revision: 1,
			});
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/a", changed)).toMatchObject({
				status: "delta",
				revision: 2,
				baseRevision: 1,
			});
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/b", changed)).toMatchObject({
				status: "full",
				revision: 3,
			});
		});
	});
});

describe("tab.id() and tab.ref() cross-delegation in browser preludes", () => {
	it("delegates ARIA ref strings in tab.id() and integers in tab.ref() in JS prelude.js", async () => {
		const calls: unknown[] = [];
		const jsSource = fs.readFileSync(new URL("../../src/tools/browser/prelude.js", import.meta.url), "utf8");
		const context = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				calls.push(parameters);
				return { text: "", details: { value: "ok" } };
			},
		});
		runInContext(jsSource, context);
		const tab = runInContext('browser.tab("main")', context);

		expect(String(tab.id("e265"))).toBe('<element tab.ref("e265") on main>');
		expect(String(tab.id("  aria-ref=e265  "))).toBe('<element tab.ref("aria-ref=e265") on main>');
		expect(String(tab.ref(265))).toBe("<element tab.id(265) on main>");

		await tab.id("e265").click();
		await tab.id("aria-ref=e265").click();
		await tab.ref(265).click();

		expect(calls).toEqual([
			{
				action: "call",
				name: "main",
				chain: [
					{ method: "ref", args: ["e265"] },
					{ method: "click", args: [] },
				],
			},
			{
				action: "call",
				name: "main",
				chain: [
					{ method: "ref", args: ["aria-ref=e265"] },
					{ method: "click", args: [] },
				],
			},
			{
				action: "call",
				name: "main",
				chain: [
					{ method: "id", args: [265] },
					{ method: "click", args: [] },
				],
			},
		]);

		expect(() => runInContext('browser.tab("main").id("foo")', context)).toThrow(
			"tab.id() expects an integer element id (e.g. tab.id(265)) or an ARIA ref string (e.g. tab.ref('e265'))",
		);
		expect(() => runInContext('browser.tab("main").ref("   ")', context)).toThrow(
			"tab.ref() expects a non-empty reference id (e.g. tab.ref('e265'))",
		);
	});

	it("delegates ARIA ref strings in tab.id() and integers in tab.ref() in Python prelude.py", () => {
		const pyPath = new URL("../../src/tools/browser/prelude.py", import.meta.url).pathname;
		const script = [
			"import asyncio, pathlib, json",
			"calls = []",
			"async def _omp_prelude(name, options):",
			"    calls.append(options)",
			"    return {'text': '', 'details': {'value': 'ok'}}",
			`ns = {'_omp_prelude': _omp_prelude}`,
			`exec(pathlib.Path(${JSON.stringify(pyPath)}).read_text(), ns)`,
			"browser = ns['browser']",
			"tab = browser.tab('main')",
			"assert repr(tab.id('e265')) == \"<browser.Element tab='main' ref='e265'>\", repr(tab.id('e265'))",
			"assert repr(tab.id('  aria-ref=e265  ')) == \"<browser.Element tab='main' ref='aria-ref=e265'>\", repr(tab.id('  aria-ref=e265  '))",
			"assert repr(tab.ref(265)) == \"<browser.Element tab='main' id=265>\", repr(tab.ref(265))",
			"asyncio.run(tab.id('e265').click())",
			"asyncio.run(tab.id('aria-ref=e265').click())",
			"asyncio.run(tab.ref(265).click())",
			"try:",
			"    tab.id('foo')",
			"    raise AssertionError('Expected TypeError')",
			"except TypeError as exc:",
			"    msg = str(exc)",
			"    assert 'tab.id(265)' in msg and \"tab.ref('e265')\" in msg, msg",
			"try:",
			"    tab.ref('   ')",
			"    raise AssertionError('Expected TypeError')",
			"except TypeError as exc:",
			"    assert \"tab.ref('e265')\" in str(exc), str(exc)",
			"print(json.dumps(calls))",
		].join("\n");
		const proc = Bun.spawnSync(["python3", "-c", script], { stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0) {
			throw new Error(new TextDecoder().decode(proc.stderr));
		}
		const calls = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
		expect(calls).toEqual([
			{
				action: "call",
				name: "main",
				chain: [
					{ method: "ref", args: ["e265"] },
					{ method: "click", args: [] },
				],
			},
			{
				action: "call",
				name: "main",
				chain: [
					{ method: "ref", args: ["aria-ref=e265"] },
					{ method: "click", args: [] },
				],
			},
			{
				action: "call",
				name: "main",
				chain: [
					{ method: "id", args: [265] },
					{ method: "click", args: [] },
				],
			},
		]);
	});
});
