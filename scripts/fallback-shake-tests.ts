#!/usr/bin/env bun
/** Run shake contracts without probing the developer's real credentials or configuration. */
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("Pass at least one shake contract test file");

const home = TempDir.createSync("@omp-fallback-shake-tests-");
try {
	const result = await $`${process.execPath} test ${files}`
		.cwd(process.cwd())
		.env({ ...process.env, HOME: home.absolute() })
		.nothrow();
	process.exitCode = result.exitCode;
} finally {
	await home.remove();
}
