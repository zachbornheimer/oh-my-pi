import { describe, expect, it } from "bun:test";
import {
	DRAFT_STASH_LIMIT,
	DraftStash,
	decideStashRestore,
	type ShelvedDraft,
	StashRestore,
} from "@oh-my-pi/pi-tui/prompt/draft-stash";

function draft(id: string): ShelvedDraft {
	return {
		id,
		text: id,
		expandedText: id,
		pastes: new Map(),
		atoms: new Map(),
		pasteCounter: 0,
		attachments: { images: 0, texts: 0 },
	};
}

describe("DraftStash", () => {
	it("returns drafts newest first", () => {
		const stash = new DraftStash();
		stash.push(draft("a"));
		stash.push(draft("b"));
		expect(stash.pop()?.id).toBe("b");
		expect(stash.pop()?.id).toBe("a");
		expect(stash.pop()).toBeUndefined();
	});

	it("drops the oldest draft once the shelf is full", () => {
		const stash = new DraftStash();
		for (let i = 0; i <= DRAFT_STASH_LIMIT; i++) stash.push(draft(`d${i}`));
		expect(stash.size).toBe(DRAFT_STASH_LIMIT);
		const ids: string[] = [];
		for (let next = stash.pop(); next; next = stash.pop()) ids.push(next.id);
		expect(ids.at(-1)).toBe("d1");
	});
});

describe("decideStashRestore", () => {
	const settled = { submittedText: "hello", composerText: "", composerHasAttachments: false, shelved: 1 };

	it("restores after a real send into an untouched, empty composer", () => {
		expect(decideStashRestore(settled)).toBe(StashRestore.Restore);
	});

	it("keeps the shelf when nothing is shelved", () => {
		expect(decideStashRestore({ ...settled, shelved: 0 })).toBe(StashRestore.Keep);
	});

	it("keeps the shelf when a blank message went out", () => {
		expect(decideStashRestore({ ...settled, submittedText: "  " })).toBe(StashRestore.Keep);
	});

	it("never overwrites text typed since the send", () => {
		expect(decideStashRestore({ ...settled, composerText: "typing" })).toBe(StashRestore.Keep);
	});

	it("never overwrites attachments added since the send", () => {
		expect(decideStashRestore({ ...settled, composerHasAttachments: true })).toBe(StashRestore.Keep);
	});
});
