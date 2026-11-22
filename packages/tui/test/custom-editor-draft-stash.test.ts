import { beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import type { ShelvedDraft } from "@oh-my-pi/pi-tui/prompt/draft-stash";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

beforeAll(async () => {
	await initTheme(false);
});

describe("CustomEditor draft stash", () => {
	it("shelves a draft, clears the composer, and brings the text back", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("half a thought");
		expect(editor.stashDraft()?.text).toBe("half a thought");
		expect(editor.getText()).toBe("");
		expect(editor.shelvedDraftCount).toBe(1);

		expect(editor.unstashDraft()?.text).toBe("half a thought");
		expect(editor.getText()).toBe("half a thought");
		expect(editor.shelvedDraftCount).toBe(0);
	});

	it("ignores a blank composer", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("   ");
		expect(editor.stashDraft()).toBeUndefined();
		expect(editor.shelvedDraftCount).toBe(0);
		expect(editor.unstashDraft()).toBeUndefined();
	});

	it("returns drafts newest first", () => {
		const editor = new CustomEditor(getEditorTheme());
		for (const text of ["first", "second"]) {
			editor.setText(text);
			editor.stashDraft();
		}
		editor.unstashDraft();
		expect(editor.getText()).toBe("second");
		editor.clearDraft();
		editor.unstashDraft();
		expect(editor.getText()).toBe("first");
	});

	it("keeps a pasted block, its chip, and its expansion across a stash", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.insertTextAttachment("line one\nline two");
		const wire = editor.getExpandedText();
		expect(wire).toContain("line one");

		const shelved = editor.stashDraft();
		expect(shelved?.expandedText).toBe(wire);
		expect(editor.pendingTexts).toEqual([]);

		editor.unstashDraft();
		expect(editor.getExpandedText()).toBe(wire);
		expect(editor.pendingTexts.map(t => t.content)).toEqual(["line one\nline two"]);
	});

	it("keeps image attachments across a stash", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("look [Image #1, 800x600]", [image]);
		expect(editor.stashDraft()?.attachments).toEqual({ images: 1, texts: 0 });
		expect(editor.pendingImages).toEqual([]);

		editor.unstashDraft();
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.getText()).toBe(`look ${chipLabel("image", 1)}`);
	});

	it("does not leak a stashed draft's attachments into the next draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("[Image #1]", [image]);
		editor.stashDraft();
		editor.setText("unrelated");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.hasPendingAttachments()).toBe(false);
	});

	it("reports each shelved and restored draft to the host", () => {
		const editor = new CustomEditor(getEditorTheme());
		const seen: string[] = [];
		editor.onDraftShelved = (d: ShelvedDraft) => seen.push(`shelved:${d.id}`);
		editor.onDraftUnshelved = (d: ShelvedDraft) => seen.push(`restored:${d.id}`);
		editor.setText("keep me");
		const id = editor.stashDraft()?.id;
		editor.unstashDraft();
		expect(seen).toEqual([`shelved:${id}`, `restored:${id}`]);
	});

	it("runs the stash handler on its chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		let presses = 0;
		editor.onStashDraft = () => {
			presses++;
		};
		editor.handleInput("\x1bs");
		expect(presses).toBe(1);
	});
});
