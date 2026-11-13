#!/usr/bin/env bun
/** Applies reviewed, exact-input merge resolutions without masking new conflicts. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

interface ConflictStage {
	mode: string;
	blob: string;
	stage: number;
}

interface Resolution {
	path: string;
	stages: ConflictStage[];
	use: number;
	patch?: string;
}

export async function resolveConflicts(repo: string, manifestPath: string): Promise<void> {
	const git = async (args: string[]): Promise<string> => {
        const result = await $`git ${args}`.cwd(repo).quiet().nothrow();
        if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
        return result.text();
	};
	const resolutions: Resolution[] = await Bun.file(manifestPath).json();
	const conflicts = new Map<string, ConflictStage[]>();
	for (const entry of (await git(["ls-files", "--unmerged", "-z"])).split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("\t");
		const [mode, blob, stage] = entry.slice(0, tab).split(" ");
		const file = entry.slice(tab + 1);
		const stages = conflicts.get(file) ?? [];
		stages.push({ mode, blob, stage: Number(stage) });
		conflicts.set(file, stages);
	}
	if (conflicts.size === 0) return;
	// Validate the entire input before touching the index or working tree.
	if (conflicts.size !== resolutions.length) throw new Error("Unreviewed assembly conflict set");
	for (const resolution of resolutions) {
		if (JSON.stringify(conflicts.get(resolution.path)) !== JSON.stringify(resolution.stages)) {
			throw new Error(`Unreviewed assembly conflict: ${resolution.path}`);
		}
		if (path.isAbsolute(resolution.path) || resolution.path.split("/").includes("..")) {
			throw new Error(`Invalid resolution path: ${resolution.path}`);
		}
	}
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-merge-resolution-"));
	try {
		const prepared: { path: string; mode: string; blob: string; content: Uint8Array }[] = [];
		for (const resolution of resolutions) {
			const selected = resolution.stages.find(stage => stage.stage === resolution.use);
			if (!selected) throw new Error(`Missing selected stage: ${resolution.path}`);
			const target = path.join(temp, resolution.path);
			await Bun.write(target, await git(["cat-file", "blob", selected.blob]));
			if (resolution.patch) {
				const patch = path.resolve(path.dirname(manifestPath), resolution.patch);
                const apply = await $`git apply --no-index -- ${patch}`.cwd(temp).quiet().nothrow();
                if (apply.exitCode !== 0) throw new Error(`Invalid resolution patch: ${apply.stderr.toString()}`);
			}
			const content = new Uint8Array(await Bun.file(target).arrayBuffer());
			const blob = (await git(["hash-object", "-w", target])).trim();
			prepared.push({ path: resolution.path, mode: selected.mode, blob, content });
		}
		for (const file of prepared) {
			await Bun.write(path.join(repo, file.path), file.content);
			await git(["update-index", "--add", "--cacheinfo", file.mode, file.blob, file.path]);
		}
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const branch = process.argv[2];
	if (!branch || branch.startsWith("/") || branch.split("/").includes("..")) {
		throw new Error("Expected an assembly branch name");
	}
	const manifest = path.resolve(".omp-build/conflict-resolutions", `${branch}.json`);
	if (await Bun.file(manifest).exists()) await resolveConflicts(process.cwd(), manifest);
}
