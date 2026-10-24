import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const EVIDENCE = '```evidence\n{"claim":"fixed","type":"test","ref":"x","scope":"y"}\n```';

function rows(text: string): string[] {
	return new Markdown(text, 0, 0, defaultMarkdownTheme)
		.render(80)
		.map(line => stripVTControlCharacters(line).trimEnd());
}

describe("Markdown machine fences", () => {
	it("draws nothing for a trailing evidence fence, not even its blank line", () => {
		expect(rows(`Done.\n\n${EVIDENCE}`)).toEqual(["Done."]);
		expect(rows(`Done.\n${EVIDENCE}`)).toEqual(["Done."]);
	});

	it("keeps one blank line between the text around a mid-message fence", () => {
		expect(rows(`Done.\n\n${EVIDENCE}\n\nAfter.`)).toEqual(["Done.", "", "After."]);
	});

	it("hides a fence still streaming in, and one inside a list item", () => {
		expect(rows('Done.\n\n```evidence\n{"claim":')).toEqual(["Done."]);
		expect(rows("- item\n\n  ```evidence\n  {}\n  ```\n- two")).toEqual(["- item", "- two"]);
	});

	it("hides a fence whose info string carries more than the language", () => {
		expect(rows("Done.\n\n```evidence json\n{}\n```")).toEqual(["Done."]);
	});

	it("still draws every other fence, and evidence text outside a fence", () => {
		expect(rows("Done.\n\n```json\n{}\n```")).toContain("```json");
		expect(rows("The evidence fence is hidden.")).toEqual(["The evidence fence is hidden."]);
	});

	it("stays hidden when a streaming render grows into the fence", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		const text = `Done.\n\n${EVIDENCE}`;
		for (let end = 1; end <= text.length; end++) {
			md.setText(text.slice(0, end));
			md.render(80);
		}
		md.transientRenderCache = false;
		md.setText(text);
		expect(md.render(80).map(line => stripVTControlCharacters(line).trimEnd())).toEqual(["Done."]);
	});

	it("leaves evidence out of the source a native terminal draws", () => {
		const cx = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
		const node = new Markdown(`Done.\n\n${EVIDENCE}\n\nAfter.`, 0, 0, defaultMarkdownTheme).describe(cx);
		if (node.k !== "md") throw new Error("Expected md node");
		expect(node.p?.text).toBe("Done.\n\nAfter.");
	});

	const BARE = '{"claim":"fixed","type":"command","ref":"bun test","scope":"tui"}';

	it("draws nothing for a bare one-line evidence payload, at the end or mid-message", () => {
		expect(rows(`Done.\n\n${BARE}`)).toEqual(["Done."]);
		expect(rows(`Done.\n\n${BARE}\n`)).toEqual(["Done."]);
		expect(rows(`Done.\n\n${BARE}\n\nAfter.`)).toEqual(["Done.", "", "After."]);
	});

	it("hides a bare payload still streaming in, and one inside a list item", () => {
		expect(rows('Done.\n\n{"claim":"wav')).toEqual(["Done."]);
		expect(rows(`- item\n\n  ${BARE}\n- two`)).toEqual(["- item", "- two"]);
	});

	it("stays hidden when a streaming render grows into a bare payload", () => {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		const text = `Done.\n\n${BARE}`;
		for (let end = 1; end <= text.length; end++) {
			md.setText(text.slice(0, end));
			md.render(80);
		}
		md.transientRenderCache = false;
		md.setText(text);
		expect(md.render(80).map(line => stripVTControlCharacters(line).trimEnd())).toEqual(["Done."]);
	});

	it("still draws other JSON lines and multi-line claim objects", () => {
		expect(rows('Done.\n\n{"a":1}')).toContain('{"a":1}');
		expect(rows('Done.\n\n{"claim":"x",\n"type":"test"}').join("\n")).toContain('{"claim":"x",');
	});

	it("leaves a bare payload out of the source a native terminal draws", () => {
		const cx = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
		const node = new Markdown(`Done.\n\n${BARE}\n\nAfter.`, 0, 0, defaultMarkdownTheme).describe(cx);
		if (node.k !== "md") throw new Error("Expected md node");
		expect(node.p?.text).toBe("Done.\n\nAfter.");
	});
});
