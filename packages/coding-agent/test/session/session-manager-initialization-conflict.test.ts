import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class ConcurrentMissingReadStorage extends FileSessionStorage {
	readonly #target: string;
	#remaining = 2;
	readonly #bothReads = Promise.withResolvers<void>();

	constructor(target: string) {
		super();
		this.#target = path.resolve(target);
	}

	override async readText(file: string): Promise<string> {
		try {
			return await super.readText(file);
		} catch (error) {
			if (
				path.resolve(file) !== this.#target ||
				this.#remaining === 0 ||
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
			this.#remaining--;
			if (this.#remaining === 0) this.#bothReads.resolve();
			await this.#bothReads.promise;
			throw error;
		}
	}
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

function userTurns(manager: SessionManager): string[] {
	return manager
		.getEntries()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
}

describe("SessionManager concurrent initialization of a missing session file", () => {
	it("moves the losing creator to a sibling without logging an error or mixing entries", async () => {
		using tempDir = TempDir.createSync("@omp-session-initialization-conflict-");
		const file = path.join(tempDir.path(), "new-session.jsonl");
		const storage = new ConcurrentMissingReadStorage(file);
		const [first, second] = await Promise.all([
			SessionManager.open(file, tempDir.path(), storage, { initialCwd: tempDir.path(), suppressBreadcrumb: true }),
			SessionManager.open(file, tempDir.path(), storage, { initialCwd: tempDir.path(), suppressBreadcrumb: true }),
		]);
		const errors: Error[] = [];
		first.onPersistenceError(error => errors.push(error));
		second.onPersistenceError(error => errors.push(error));

		first.appendMessage(userTurn("first writer"));
		second.appendMessage(userTurn("second writer"));
		await Promise.all([first.flush(), second.flush()]);

		const firstFile = first.getSessionFile();
		const secondFile = second.getSessionFile();
		expect(firstFile).not.toBe(secondFile);
		expect([firstFile, secondFile]).toContain(file);
		expect(userTurns(first)).toContain("first writer");
		expect(userTurns(second)).toContain("second writer");
		expect(errors).toEqual([]);

		await Promise.all([first.close(), second.close()]);
	});
});
