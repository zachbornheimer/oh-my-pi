/**
 * The stash archive is the draft's undo file: one JSON line per stash event,
 * appended and never rewritten, so a draft the user shelved and never brought
 * back is still on disk after a restart. It sits beside the session's other
 * artifacts and travels with them.
 */

export const STASH_ARCHIVE_FILE = "stash-archive.jsonl";

export enum StashEvent {
	Stashed = "stashed",
	Restored = "restored",
}

export interface StashArchiveRecord {
	readonly event: StashEvent;
	readonly id: string;
	readonly at: string;
	/** Present on `Stashed` only: the text with every paste expanded. */
	readonly text?: string;
	readonly attachments?: { readonly images: number; readonly texts: number };
}

export interface StashedFacts {
	readonly id: string;
	readonly expandedText: string;
	readonly attachments: { readonly images: number; readonly texts: number };
}

export function stashedRecord(draft: StashedFacts, at: Date): StashArchiveRecord {
	return {
		event: StashEvent.Stashed,
		id: draft.id,
		at: at.toISOString(),
		text: draft.expandedText,
		attachments: draft.attachments,
	};
}

export function restoredRecord(id: string, at: Date): StashArchiveRecord {
	return { event: StashEvent.Restored, id, at: at.toISOString() };
}

export function encodeRecord(record: StashArchiveRecord): string {
	return `${JSON.stringify(record)}\n`;
}

function parseRecord(line: string): StashArchiveRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { event, id, at, text, attachments } = value as Record<string, unknown>;
	if (typeof id !== "string" || typeof at !== "string") return undefined;
	if (event === StashEvent.Restored) return { event, id, at };
	if (event !== StashEvent.Stashed || typeof text !== "string") return undefined;
	const counts = attachments as { images?: unknown; texts?: unknown } | undefined;
	return {
		event,
		id,
		at,
		text,
		attachments: {
			images: typeof counts?.images === "number" ? counts.images : 0,
			texts: typeof counts?.texts === "number" ? counts.texts : 0,
		},
	};
}

/** A draft that was shelved and never brought back, oldest first. */
export interface LeftoverDraft {
	readonly id: string;
	readonly at: string;
	readonly text: string;
}

/** Stashed records with no matching `Restored` record. Unreadable lines are skipped. */
export function leftoverDrafts(content: string): LeftoverDraft[] {
	const open = new Map<string, LeftoverDraft>();
	for (const line of content.split("\n")) {
		if (!line) continue;
		const record = parseRecord(line);
		if (!record) continue;
		if (record.event === StashEvent.Restored) open.delete(record.id);
		else if (record.text !== undefined) open.set(record.id, { id: record.id, at: record.at, text: record.text });
	}
	return [...open.values()];
}
