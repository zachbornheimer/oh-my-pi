/** Editor state a draft needs to come back whole: text plus everything its chips expand to. */
export interface DraftState {
	readonly text: string;
	readonly pastes: ReadonlyMap<number, string>;
	readonly atoms: ReadonlyMap<string, string>;
	readonly pasteCounter: number;
	/** Host-owned state (images, text attachments) re-applied before the text loads. */
	readonly restore?: () => void;
}

/** A draft shelved by the user, with the facts the archive records about it. */
export interface ShelvedDraft extends DraftState {
	readonly id: string;
	/** Wire text with every paste expanded, so a saved copy is readable without the editor. */
	readonly expandedText: string;
	readonly attachments: { readonly images: number; readonly texts: number };
}

export const DRAFT_STASH_LIMIT = 20;

/** Last-in, first-out shelf of drafts. The oldest falls off when it is full. */
export class DraftStash {
	readonly #drafts: ShelvedDraft[] = [];

	get size(): number {
		return this.#drafts.length;
	}

	push(draft: ShelvedDraft): void {
		this.#drafts.push(draft);
		if (this.#drafts.length > DRAFT_STASH_LIMIT) this.#drafts.shift();
	}

	pop(): ShelvedDraft | undefined {
		return this.#drafts.pop();
	}
}

export enum StashRestore {
	Restore = "restore",
	Keep = "keep",
}

export interface StashRestoreFacts {
	readonly submittedText: string;
	readonly composerText: string;
	readonly composerHasAttachments: boolean;
	readonly shelved: number;
}

/**
 * Whether a finished send brings the newest shelved draft back. It does only
 * after a real message left an untouched, empty composer: a refused send puts
 * its text back, and anything typed since is a newer draft that must not be
 * overwritten.
 */
export function decideStashRestore(facts: StashRestoreFacts): StashRestore {
	if (facts.shelved === 0) return StashRestore.Keep;
	if (facts.submittedText.trim() === "") return StashRestore.Keep;
	if (facts.composerText.trim() !== "" || facts.composerHasAttachments) return StashRestore.Keep;
	return StashRestore.Restore;
}
