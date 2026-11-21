import { describe, expect, it } from "bun:test";
import {
	encodeRecord,
	leftoverDrafts,
	restoredRecord,
	type StashArchiveRecord,
	stashedRecord,
} from "@oh-my-pi/pi-coding-agent/session/stash-archive";

const at = new Date("2026-11-20T12:00:00.000Z");
const counts = { images: 1, texts: 0 };

function archive(...records: StashArchiveRecord[]): string {
	return records.map(encodeRecord).join("");
}

describe("stash archive", () => {
	it("reports a stashed draft that was never restored", () => {
		const content = archive(stashedRecord({ id: "a", expandedText: "keep", attachments: counts }, at));
		expect(leftoverDrafts(content)).toEqual([{ id: "a", at: at.toISOString(), text: "keep" }]);
	});

	it("drops a draft once its restore is recorded", () => {
		const content = archive(
			stashedRecord({ id: "a", expandedText: "one", attachments: counts }, at),
			stashedRecord({ id: "b", expandedText: "two", attachments: counts }, at),
			restoredRecord("a", at),
		);
		expect(leftoverDrafts(content).map(d => d.id)).toEqual(["b"]);
	});

	it("keeps drafts oldest first", () => {
		const content = archive(
			stashedRecord({ id: "a", expandedText: "one", attachments: counts }, at),
			stashedRecord({ id: "b", expandedText: "two", attachments: counts }, at),
		);
		expect(leftoverDrafts(content).map(d => d.id)).toEqual(["a", "b"]);
	});

	it("keeps a multiline draft in one record", () => {
		const content = archive(stashedRecord({ id: "a", expandedText: "x\ny\n", attachments: counts }, at));
		expect(content.trimEnd().split("\n")).toHaveLength(1);
		expect(leftoverDrafts(content)[0]?.text).toBe("x\ny\n");
	});

	it("skips a torn or foreign line instead of losing the rest", () => {
		const content = `${archive(stashedRecord({ id: "a", expandedText: "one", attachments: counts }, at))}{"event":"stas\nnot json\n`;
		expect(leftoverDrafts(content).map(d => d.id)).toEqual(["a"]);
	});

	it("reads an empty archive as no leftovers", () => {
		expect(leftoverDrafts("")).toEqual([]);
	});
});
