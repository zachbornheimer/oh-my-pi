import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { rankSessionsByTitle } from "@oh-my-pi/pi-coding-agent/session/session-title-match";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function info(
	title: string | undefined,
	cwd: string,
	modifiedAt: number,
	id: string = title ?? "untitled",
): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd,
		title,
		created: new Date(modifiedAt),
		modified: new Date(modifiedAt),
		messageCount: 2,
		size: 100,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

function ranked(query: string, sessions: SessionInfo[], cwd = "/work/here"): string[] {
	return rankSessionsByTitle(query, sessions, cwd).map(match => match.session.id);
}

describe("rankSessionsByTitle", () => {
	it("prefers exact over prefix over substring, ignoring case and spacing", () => {
		const sessions = [
			info("Fix OPTIM: Resume later", "/other", 4, "substring-long"),
			info("Notes on OPTIM: Re", "/other", 3, "substring"),
			info("OPTIM: Resume picker", "/other", 2, "prefix"),
			info("optim:   re", "/other", 1, "exact"),
		];
		expect(ranked("OPTIM: Re", sessions)).toEqual(["exact", "prefix", "substring", "substring-long"]);
	});

	it("matches a title that holds every word of the query out of order", () => {
		expect(ranked("resume optim", [info("OPTIM: Resume picker", "/other", 1)])).toEqual(["OPTIM: Resume picker"]);
	});

	it("leads with the launch directory inside one kind of match", () => {
		const sessions = [
			info("OPTIM: Resume newer elsewhere", "/other", 9, "elsewhere"),
			info("OPTIM: Resume here", "/work/here", 1, "here"),
		];
		expect(ranked("OPTIM: Re", sessions)).toEqual(["here", "elsewhere"]);
	});

	it("keeps a closer kind of match ahead of a launch-directory one", () => {
		const sessions = [
			info("Notes on OPTIM: Re", "/work/here", 9, "substring-here"),
			info("OPTIM: Resume", "/other", 1, "prefix-elsewhere"),
		];
		expect(ranked("OPTIM: Re", sessions)).toEqual(["prefix-elsewhere", "substring-here"]);
	});

	it("breaks remaining ties by coverage, then recency", () => {
		const sessions = [
			info("OPTIM: Resume with a very long tail of words", "/other", 9, "long"),
			info("OPTIM: Resume", "/other", 1, "short"),
			info("OPTIM: Restart", "/other", 5, "restart"),
		];
		expect(ranked("OPTIM: Re", sessions)).toEqual(["short", "restart", "long"]);
	});

	it("never matches untitled sessions or an empty query", () => {
		expect(ranked("hello", [info(undefined, "/work/here", 1)])).toEqual([]);
		expect(ranked("   ", [info("anything", "/work/here", 1)])).toEqual([]);
	});
});

describe("createSessionManager --resume <title>", () => {
	let tempDir: string;
	let sessionDir: string;
	const stubSettings = { get: () => undefined } as unknown as Settings;

	function resumeArgs(resume: string): Args {
		return {
			resume,
			sessionDir,
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
			unrecognizedFlags: [],
			invalidFlagValues: [],
		};
	}

	function writeTitledSession(id: string, title: string): string {
		const file = path.join(sessionDir, `2025-01-01T00-00-00-000Z_${id}.jsonl`);
		fs.writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id,
					title,
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		return file;
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `resume-title-${Snowflake.next()}`);
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	it("opens the session whose title best fits the text", async () => {
		writeTitledSession("alpha1234", "OPTIM: Resume picker");
		const wanted = writeTitledSession("beta56789", "OPTIM: Re");
		const manager = await createSessionManager(resumeArgs("OPTIM: Re"), tempDir, stubSettings);
		expect(manager?.getSessionFile()).toBe(wanted);
	});

	it("fails with the usual not-found error when no title fits and the launch cannot show a picker", async () => {
		writeTitledSession("alpha1234", "Unrelated");
		await expect(createSessionManager(resumeArgs("OPTIM: Re"), tempDir, stubSettings)).rejects.toBeInstanceOf(
			SessionResolutionError,
		);
	});

	it("hands the text to the picker when no title fits and the launch can show one", async () => {
		writeTitledSession("alpha1234", "Unrelated");
		const args = resumeArgs("OPTIM: Re");
		const manager = await createSessionManager(args, tempDir, stubSettings, undefined, { fallbackToPicker: true });
		expect(manager).toBeUndefined();
		expect(args.resume).toBe(true);
		expect(args.resumeQuery).toBe("OPTIM: Re");
	});
});
