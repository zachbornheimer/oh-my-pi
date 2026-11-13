import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConflicts } from "./resolve-conflicts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-conflict-test-"));
	directories.push(repo);
	const git = (args: string[], input?: string) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdin: input ? Buffer.from(input) : undefined });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git(["init", "--quiet"]);
	const blob = (text: string) => git(["hash-object", "-w", "--stdin"], text);
	const stages = [
		{ mode: "100644", blob: blob("old\n"), stage: 1 },
		{ mode: "100644", blob: blob("new\n"), stage: 3 },
	];
	git(["update-index", "--index-info"], stages.map(s => `${s.mode} ${s.blob} ${s.stage}\trestored.txt\n`).join(""));
	await Bun.write(path.join(repo, "restored.txt"), "conflicted\n");
	const manifest = path.join(repo, "resolution.json");
	return { repo, git, stages, manifest };
}

describe("reviewed assembly conflict resolutions", () => {
	test("restores a modified file deleted by the sync, including its staged content", async () => {
		const f = await fixture();
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages, use: 3 }]));
		await resolveConflicts(f.repo, f.manifest);
		expect(f.git(["ls-files", "--unmerged"])).toBe("");
		expect(f.git(["show", ":restored.txt"])).toBe("new");
		expect(await Bun.file(path.join(f.repo, "restored.txt")).text()).toBe("new\n");
	});

	test("rejects changed inputs without changing the conflict index or working file", async () => {
		const f = await fixture();
		const before = f.git(["ls-files", "--unmerged"]);
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages.slice(1), use: 3 }]));
		await expect(resolveConflicts(f.repo, f.manifest)).rejects.toThrow("Unreviewed assembly conflict");
		expect(f.git(["ls-files", "--unmerged"])).toBe(before);
		expect(await Bun.file(path.join(f.repo, "restored.txt")).text()).toBe("conflicted\n");
	});

	test("applies the reviewed content transform before staging", async () => {
		const f = await fixture();
		await Bun.write(path.join(f.repo, "fix.patch"), "diff --git a/restored.txt b/restored.txt\n--- a/restored.txt\n+++ b/restored.txt\n@@ -1 +1 @@\n-new\n+combined\n");
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages, use: 3, patch: "fix.patch" }]));
		await resolveConflicts(f.repo, f.manifest);
		expect(f.git(["show", ":restored.txt"])).toBe("combined");
	});

	test("an invalid patch leaves the original unresolved state intact", async () => {
		const f = await fixture();
		const before = f.git(["ls-files", "--unmerged"]);
		await Bun.write(path.join(f.repo, "fix.patch"), "not a patch\n");
		await Bun.write(f.manifest, JSON.stringify([{ path: "restored.txt", stages: f.stages, use: 3, patch: "fix.patch" }]));
		await expect(resolveConflicts(f.repo, f.manifest)).rejects.toThrow("Invalid resolution patch");
		expect(f.git(["ls-files", "--unmerged"])).toBe(before);
		expect(await Bun.file(path.join(f.repo, "restored.txt")).text()).toBe("conflicted\n");
	});
});
