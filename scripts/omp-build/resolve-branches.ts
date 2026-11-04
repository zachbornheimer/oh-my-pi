#!/usr/bin/env bun
/**
 * Resolves the ordered branch list for one omp-build assembly run.
 *
 * Usage: bun scripts/omp-build/resolve-branches.ts [branches_override] [event_name]
 *
 * - The single source of truth is the `BRANCH_MANIFEST` env var set on the
 *   `assemble` job in .github/workflows/omp-build.yml: a JSON array of
 *   { branch, reason } entries. The reason is plain English and is what
 *   justifies the branch being merged at all; an entry without one fails the
 *   run, so the list can never grow a branch nobody can explain.
 * - Scheduled runs (event_name != "workflow_dispatch") read that manifest.
 * - A workflow_dispatch with a NON-EMPTY `branches_override` uses that
 *   comma-separated list and publishes a prerelease, never latest.
 * - An empty override (or absent input) falls back to the manifest so a
 *   dispatch can never assemble a branchless build.
 *
 * Prints exactly one branch name per line (possibly none) and exits non-zero
 * on a malformed manifest.
 */

const override = process.argv[2] ?? "";
const event = process.argv[3] ?? "workflow_dispatch";

type Entry = { branch: string; reason: string };

function parseManifest(raw: string): string[] {
	const source = raw.trim();
	if (source.length === 0) {
		throw new Error(
			"BRANCH_MANIFEST is empty: set it on the assemble job in .github/workflows/omp-build.yml as a JSON array of { branch, reason } entries",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`BRANCH_MANIFEST is not valid JSON: ${detail}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error("BRANCH_MANIFEST must be a JSON array of { branch, reason } entries");
	}
	return parsed.map((rawEntry, index) => {
		const entry = rawEntry as Partial<Entry>;
		const where = `BRANCH_MANIFEST[${index}]`;
		if (typeof entry?.branch !== "string" || entry.branch.trim().length === 0) {
			throw new Error(`${where}: missing a \`branch\` name`);
		}
		if (typeof entry?.reason !== "string" || entry.reason.trim().length === 0) {
			throw new Error(
				`${where} (${entry.branch}): missing a \`reason\` - every branch states in plain English what it does for the person running this build`,
			);
		}
		if (/^\s*todo\b/i.test(entry.reason)) {
			console.warn(`::warning title=Unconfirmed branch reason::${entry.branch}: reason is still a TODO`);
		}
		return entry.branch.trim();
	});
}

function parseOverride(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

const branches =
	event === "workflow_dispatch" && override.trim().length > 0
		? parseOverride(override)
		: parseManifest(process.env.BRANCH_MANIFEST ?? "");

const duplicates = branches.filter((branch, index) => branches.indexOf(branch) !== index);
if (duplicates.length > 0) {
	throw new Error(`duplicate branch entries: ${[...new Set(duplicates)].join(", ")}`);
}

console.log(branches.join("\n"));
