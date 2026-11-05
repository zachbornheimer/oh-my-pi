#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Resolves a CROSS_TARGET value to the Bun compile target used by local binary builds. */
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-arm64":
			return { id: value, platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" };
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64", target: "bun-darwin-x64" };
		case "linux-arm64":
			return { id: value, platform: "linux", arch: "arm64", target: "bun-linux-arm64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" };
		case "win32-x64":
		case "windows-x64":
			return { id: value, platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" };
		case "win32-arm64":
		case "windows-arm64":
			return { id: value, platform: "win32", arch: "arm64", target: "bun-windows-arm64" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;

/** Reject on a non-zero exit; `label` names the command in the error. */
function waitForExit(proc: ReturnType<typeof spawn>, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		proc.on("error", reject);
		proc.on("exit", code => {
			if (code === 0) resolve();
			else reject(new Error(`Command failed with exit code ${code}: ${label}`));
		});
	});
}

/** Run one of the two build tools this script may launch. */
async function runCommand(command: string[]): Promise<void> {
	const [executable, ...args] = command;
	if (executable === "bun") {
		await waitForExit(spawn("bun", args, { cwd: packageDir, stdio: "inherit" }), command.join(" "));
		return;
	}
	if (executable === "codesign") {
		await waitForExit(spawn("codesign", args, { cwd: packageDir, stdio: "inherit" }), command.join(" "));
		return;
	}
	throw new Error(`Refusing to run an executable this build never launches: ${executable}`);
}

async function main(): Promise<void> {
	const crossBuild = resolveCrossBuild(Bun.env.CROSS_TARGET);
	const shouldAdhocSign =
		process.platform === "darwin" &&
		(!crossBuild || crossBuild.platform === "darwin") &&
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = crossBuild ? `omp-${crossBuild.id}` : "omp";
	const outputPath = path.join(packageDir, "dist", outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		// Embed metadata for the same content-addressed viewer used by source exports.
		// Generate here too for clean checkouts that skipped install hooks.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:export-viewer"]);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(packageDir, "src", "cli.ts"),
			outfile: outputPath,
			transformersVersion,
			buildIdentity: Bun.env.PI_BUILD_IDENTITY || undefined,
			native: crossBuild ?? { platform: process.platform, arch: process.arch },
			target: crossBuild?.target,
			executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
			skipBuiltinCodesign: shouldAdhocSign,
		});

		if (shouldAdhocSign) {
			await runCommand([
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				path.join(repoRoot, "scripts", "macos-entitlements.plist"),
				outputPath,
			]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await main();
