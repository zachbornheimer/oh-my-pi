import { logger } from "@oh-my-pi/pi-utils";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { decideStashRestore, StashRestore } from "@oh-my-pi/pi-tui/prompt/draft-stash";
import {
	type LeftoverDraft,
	restoredRecord,
	type StashArchiveRecord,
	stashedRecord,
} from "../../session/stash-archive";

/** The slice of the host the stash needs. */
export interface DraftStashHost {
	readonly editor: CustomEditor;
	appendStashRecord(record: StashArchiveRecord): Promise<void>;
	readLeftoverDrafts(): Promise<LeftoverDraft[]>;
	showStatus(message: string): void;
	updateEditorBorderColor(): void;
	requestRender(): void;
}

/**
 * Owns the composer's draft stash for the interactive session: the user's
 * stash gestures, the restore after a send, and the archive that keeps a
 * stashed draft on disk until it comes back.
 */
export class DraftStashController {
	readonly #host: DraftStashHost;

	constructor(host: DraftStashHost) {
		this.#host = host;
	}

	/** Bind the archive to the host's current editor. Call again whenever the editor is replaced. */
	attach(): void {
		const editor = this.#host.editor;
		editor.onDraftShelved = shelved => this.#archive(stashedRecord(shelved, new Date()));
		editor.onDraftUnshelved = shelved => this.#archive(restoredRecord(shelved.id, new Date()));
		editor.onStashDraft = () => this.toggle();
	}

	/**
	 * Shelve a non-empty composer. An empty composer or a blank draft is left alone.
	 * Returns whether a draft was shelved.
	 */
	stashComposer(): boolean {
		const shelved = this.#host.editor.stashDraft();
		if (!shelved) return false;
		this.#host.showStatus(`Draft stashed (${this.#host.editor.shelvedDraftCount})`);
		this.#refresh();
		return true;
	}

	/** The stash key: shelve a draft, or bring the newest one back when the composer is empty. */
	toggle(): void {
		const editor = this.#host.editor;
		if (editor.getText().trim() !== "") {
			this.stashComposer();
			return;
		}
		if (!editor.unstashDraft()) {
			this.#host.showStatus("Nothing stashed");
			return;
		}
		this.#host.showStatus(`Draft restored (${editor.shelvedDraftCount} left)`);
		this.#refresh();
	}

	/** After a message went out: bring the newest stash back when the composer stayed untouched. */
	restoreAfterSend(submittedText: string): void {
		const editor = this.#host.editor;
		const decision = decideStashRestore({
			submittedText,
			composerText: editor.getText(),
			composerHasAttachments: editor.hasPendingAttachments(),
			shelved: editor.shelvedDraftCount,
		});
		if (decision !== StashRestore.Restore) return;
		if (!editor.unstashDraft()) return;
		this.#host.showStatus(`Stashed draft restored (${editor.shelvedDraftCount} left)`);
		this.#refresh();
	}

	/** Shelve drafts an earlier run stashed and never restored; they stay in the archive until restored. */
	async recoverLeftovers(): Promise<void> {
		const leftovers = await this.#host.readLeftoverDrafts();
		if (leftovers.length === 0) return;
		for (const draft of leftovers) this.#host.editor.shelveRecovered(draft.id, draft.text);
		this.#host.showStatus(`${leftovers.length} stashed draft${leftovers.length === 1 ? "" : "s"} recovered`);
	}

	#archive(record: StashArchiveRecord): void {
		this.#host.appendStashRecord(record).catch(error => {
			logger.warn("Failed to archive stashed draft", { error: String(error) });
		});
	}

	#refresh(): void {
		this.#host.updateEditorBorderColor();
		this.#host.requestRender();
	}
}
