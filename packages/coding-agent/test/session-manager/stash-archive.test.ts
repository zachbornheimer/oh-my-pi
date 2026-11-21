import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { restoredRecord, STASH_ARCHIVE_FILE, stashedRecord } from "@oh-my-pi/pi-coding-agent/session/stash-archive";
import { TempDir } from "@oh-my-pi/pi-utils";

const at = new Date("2026-11-20T12:00:00.000Z");
const none = { images: 0, texts: 0 };

function newSession(dir: string): SessionManager {
	const session = SessionManager.create(dir, dir);
	session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	return session;
}

function sessionFileOf(session: SessionManager): string {
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Expected session file");
	return sessionFile;
}

describe("SessionManager stash archive", () => {
	it("keeps a stashed draft readable by the next run of the session", async () => {
		using tempDir = TempDir.createSync("@pi-stash-archive-leftover-");
		const first = newSession(tempDir.path());
		await first.appendStashRecord(stashedRecord({ id: "a", expandedText: "unfinished", attachments: none }, at));

		const resumed = await SessionManager.open(sessionFileOf(first), tempDir.path());
		expect((await resumed.readLeftoverDrafts()).map(d => d.text)).toEqual(["unfinished"]);
	});

	it("writes the session file so a resume can find the archive", async () => {
		using tempDir = TempDir.createSync("@pi-stash-archive-materialize-");
		const session = newSession(tempDir.path());
		expect(await Bun.file(sessionFileOf(session)).exists()).toBe(false);
		await session.appendStashRecord(stashedRecord({ id: "a", expandedText: "one", attachments: none }, at));
		expect(await Bun.file(sessionFileOf(session)).exists()).toBe(true);
	});

	it("stops reporting a draft once its restore is archived", async () => {
		using tempDir = TempDir.createSync("@pi-stash-archive-restored-");
		const session = newSession(tempDir.path());
		await session.appendStashRecord(stashedRecord({ id: "a", expandedText: "one", attachments: none }, at));
		await session.appendStashRecord(restoredRecord("a", at));
		expect(await session.readLeftoverDrafts()).toEqual([]);
	});

	it("keeps every record when appends overlap", async () => {
		using tempDir = TempDir.createSync("@pi-stash-archive-overlap-");
		const session = newSession(tempDir.path());
		const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
		await Promise.all(
			ids.map(id => session.appendStashRecord(stashedRecord({ id, expandedText: id, attachments: none }, at))),
		);
		expect((await session.readLeftoverDrafts()).map(d => d.id).sort()).toEqual([...ids].sort());
	});

	it("lives in the artifacts directory so it goes with the session", async () => {
		using tempDir = TempDir.createSync("@pi-stash-archive-location-");
		const session = newSession(tempDir.path());
		await session.appendStashRecord(stashedRecord({ id: "a", expandedText: "one", attachments: none }, at));

		const artifactsDir = session.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected artifacts directory");
		const archivePath = path.join(artifactsDir, STASH_ARCHIVE_FILE);
		expect(await Bun.file(archivePath).exists()).toBe(true);

		await session.dropSession(sessionFileOf(session));
		expect(await Bun.file(archivePath).exists()).toBe(false);
	});

	it("has nothing to report when no draft was ever stashed", async () => {
		using tempDir = TempDir.createSync("@pi-stash-archive-none-");
		expect(await newSession(tempDir.path()).readLeftoverDrafts()).toEqual([]);
	});
});
