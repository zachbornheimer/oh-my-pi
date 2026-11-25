import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { resolveConflicts } from "./resolve-conflicts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-conflict-test-"));
	directories.push(repo);
	const git = async (args: string[], input?: string) => {
		const result = input === undefined
			? await $`git ${args}`.cwd(repo).quiet().nothrow()
			: await $`git ${args} < ${Buffer.from(input)}`.cwd(repo).quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.text().trim();
	};
	await git(["init", "--quiet"]);
	const stages = [
		{ mode: "100644", blob: await git(["hash-object", "-w", "--stdin"], "old\n"), stage: 1 },
		{ mode: "100644", blob: await git(["hash-object", "-w", "--stdin"], "new\n"), stage: 3 },
	];
	await git(["update-index", "--index-info"], stages.map(s => `${s.mode} ${s.blob} ${s.stage}\trestored.txt\n`).join(""));
	await Bun.write(path.join(repo, "restored.txt"), "conflicted\n");
	const manifest = path.join(repo, "resolution.json");
	return { repo, git, stages, manifest };
}

describe("reviewed assembly conflict resolutions", () => {
	test("restores a modified file deleted by the sync, including its staged content", async () => {
		const f = await fixture();
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages, use: 3 }]));
		await resolveConflicts(f.repo, f.manifest);
		expect(await f.git(["ls-files", "--unmerged"])).toBe("");
		expect(await f.git(["show", ":restored.txt"])).toBe("new");
		expect(await Bun.file(path.join(f.repo, "restored.txt")).text()).toBe("new\n");
	});

	test("rejects changed inputs without changing the conflict index or working file", async () => {
		const f = await fixture();
		const before = await f.git(["ls-files", "--unmerged"]);
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages.slice(1), use: 3 }]));
		await expect(resolveConflicts(f.repo, f.manifest)).rejects.toThrow("Unreviewed assembly conflict");
		expect(await f.git(["ls-files", "--unmerged"])).toBe(before);
		expect(await Bun.file(path.join(f.repo, "restored.txt")).text()).toBe("conflicted\n");
	});

	test("applies the reviewed content transform before staging", async () => {
		const f = await fixture();
		await Bun.write(path.join(f.repo, "fix.patch"), "diff --git a/restored.txt b/restored.txt\n--- a/restored.txt\n+++ b/restored.txt\n@@ -1 +1 @@\n-new\n+combined\n");
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages, use: 3, patch: "fix.patch" }]));
		await resolveConflicts(f.repo, f.manifest);
		expect(await f.git(["show", ":restored.txt"])).toBe("combined");
	});

	test("an invalid patch leaves the original unresolved state intact", async () => {
		const f = await fixture();
		const before = await f.git(["ls-files", "--unmerged"]);
		await Bun.write(path.join(f.repo, "fix.patch"), "not a patch\n");
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages, use: 3, patch: "fix.patch" }]));
		await expect(resolveConflicts(f.repo, f.manifest)).rejects.toThrow("Invalid resolution patch");
		expect(await f.git(["ls-files", "--unmerged"])).toBe(before);
		expect(await Bun.file(path.join(f.repo, "restored.txt")).text()).toBe("conflicted\n");
	});
});
