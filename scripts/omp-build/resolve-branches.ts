#!/usr/bin/env bun
/**
 * Resolves the ordered branch list for one omp-build assembly run.
 *
 * Usage: bun scripts/omp-build/resolve-branches.ts [branches_override] [event_name]
 *
 * - Scheduled runs (event_name != "workflow_dispatch") read the `branches`
 *   array from .github/omp-rebuild.toml — the single source of truth.
 * - A workflow_dispatch `branches_override` is a comma-separated branch list;
 *   an empty override means NO branches (assemble upstream main alone).
 *
 * Prints exactly one branch name per line (possibly none) and exits non-zero
 * on a malformed list.
 */

const override = process.argv[2] ?? "";
const event = process.argv[3] ?? "workflow_dispatch";
const tomlPath = ".github/omp-rebuild.toml";

function parseOverride(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

async function parseToml(path: string): string[] {
	const text = await Bun.file(path).text();
	const match = text.match(/^branches\s*=\s*\[([^\]]*)\]/m);
	if (!match) {
		throw new Error(`${path}: expected a top-level \`branches = [...]\` array`);
	}
	return match[1]
		.split("\n")
		.map((line) => line.replace(/#.*$/, ""))
		.join(",")
		.split(",")
		.map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
		.filter((entry) => entry.length > 0);
}

const branches =
	event === "workflow_dispatch" ? parseOverride(override) : await parseToml(tomlPath);

const duplicates = branches.filter((branch, index) => branches.indexOf(branch) !== index);
if (duplicates.length > 0) {
	throw new Error(`duplicate branch entries: ${[...new Set(duplicates)].join(", ")}`);
}

console.log(branches.join("\n"));
