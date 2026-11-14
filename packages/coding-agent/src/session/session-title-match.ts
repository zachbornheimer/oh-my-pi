import { normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import {
	findSessionContinuation,
	listAllSessions,
	listSessions,
	type ResumeTarget,
	type SessionInfo,
} from "./session-listing";
import { FileSessionStorage } from "./session-storage";

/** How a query fits a title; a higher kind always outranks a lower one. */
enum TitleMatchKind {
	AllWords = 1,
	Substring = 2,
	Prefix = 3,
	Exact = 4,
}

export interface SessionTitleMatch {
	session: SessionInfo;
	kind: TitleMatchKind;
	/** The session was started in the launch directory. */
	sameDirectory: boolean;
	/** Share of the title the query spells out, 0..1. */
	coverage: number;
}

function normalizeTitle(value: string | undefined): string {
	const firstLine = value?.split(/\r?\n/, 1)[0] ?? "";
	return firstLine.replace(/\s+/g, " ").trim().toLowerCase();
}

function matchKind(title: string, query: string, words: readonly string[]): TitleMatchKind | undefined {
	if (title === query) return TitleMatchKind.Exact;
	if (title.startsWith(query)) return TitleMatchKind.Prefix;
	if (title.includes(query)) return TitleMatchKind.Substring;
	if (words.length > 1 && words.every(word => title.includes(word))) return TitleMatchKind.AllWords;
	return undefined;
}

function compareMatches(a: SessionTitleMatch, b: SessionTitleMatch): number {
	return (
		b.kind - a.kind ||
		Number(b.sameDirectory) - Number(a.sameDirectory) ||
		b.coverage - a.coverage ||
		b.session.modified.getTime() - a.session.modified.getTime()
	);
}

/**
 * Sessions whose title fits `query`, best first.
 *
 * A title matches when it equals the query, starts with it, contains it, or
 * contains every word of it (case and whitespace ignored). A closer kind of
 * match always wins. Within a kind, a session started in `cwd` leads, then
 * the title the query covers most, then the most recently modified. Sessions
 * without a title never match: a first prompt is not a name.
 */
export function rankSessionsByTitle(query: string, sessions: readonly SessionInfo[], cwd: string): SessionTitleMatch[] {
	const normalizedQuery = normalizeTitle(query);
	if (!normalizedQuery) return [];
	const words = normalizedQuery.split(" ");
	const launchDirectory = normalizePathForComparison(cwd);
	const matches: SessionTitleMatch[] = [];
	for (const session of sessions) {
		const title = normalizeTitle(session.title);
		if (!title) continue;
		const kind = matchKind(title, normalizedQuery, words);
		if (kind === undefined) continue;
		matches.push({
			session,
			kind,
			sameDirectory: session.cwd !== "" && normalizePathForComparison(session.cwd) === launchDirectory,
			coverage: normalizedQuery.length / title.length,
		});
	}
	return matches.sort(compareMatches);
}

/**
 * The session a `--resume` key opens when it is not an id: the best title match
 * ({@link rankSessionsByTitle}) among `sessionDir`'s sessions, or among every
 * project's sessions when no directory was given, followed to the copy of its
 * conversation to resume. `undefined` when no title fits.
 */
export async function resolveResumeTargetByTitle(
	query: string,
	cwd: string,
	sessionDir?: string,
): Promise<ResumeTarget | undefined> {
	const storage = new FileSessionStorage();
	const sessions = sessionDir ? await listSessions(sessionDir, storage) : await listAllSessions(storage);
	const best = rankSessionsByTitle(query, sessions, cwd)[0];
	if (!best) return undefined;
	const continuation = await findSessionContinuation(best.session.path, storage);
	return { session: continuation?.session ?? best.session, continuation };
}
