#!/usr/bin/env bun
/**
 * Chunks the session transcripts in `public.omp_session_files` that the archive has not stored yet
 * into `public.memory_chunks`. Safe to rerun: what is written is decided from the store each time.
 *
 *   bun run scripts/memory/archive-backfill.ts [--dry-run] [--limit N] [--since <iso>] [--verbose]
 *
 * The store is `SESSIONS_DB_URL`, else the file the dev-env shell writes it to. Exit 1 when the store
 * cannot be reached or an option is invalid; exit 0 otherwise, even if some transcripts failed (each
 * is counted and logged).
 */

import { archiveBackfill } from "../../src/memory-backend/archive/backfill";
import { openArchiveClient } from "../../src/memory-backend/archive/client";

const USAGE = "usage: archive-backfill.ts [--dry-run] [--limit N] [--since <iso>] [--verbose]";

interface Args {
	dryRun: boolean;
	verbose: boolean;
	limit?: number;
	since?: Date;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { dryRun: false, verbose: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--dry-run") args.dryRun = true;
		else if (flag === "--verbose") args.verbose = true;
		else if (flag === "--limit") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 1) throw new Error(`--limit needs a positive integer; got ${argv[i]}`);
			args.limit = value;
		} else if (flag === "--since") {
			const value = new Date(argv[++i] ?? "");
			if (Number.isNaN(value.getTime())) throw new Error(`--since needs an ISO date or instant; got ${argv[i]}`);
			args.since = value;
		} else throw new Error(`unknown argument ${flag}`);
	}
	return args;
}

let args: Args;
try {
	args = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(`${(error as Error).message}\n${USAGE}`);
	process.exit(1);
}

const client = openArchiveClient();
try {
	const report = await archiveBackfill({
		client,
		dryRun: args.dryRun,
		...(args.limit === undefined ? {} : { limit: args.limit }),
		...(args.since === undefined ? {} : { since: args.since }),
		...(args.verbose ? { onTranscript: (line: string) => console.log(line) } : {}),
	});
	const skipped = Object.values(report.skipped).reduce((sum, n) => sum + n, 0);
	console.log(args.dryRun ? "archive backfill (dry run: nothing written)" : "archive backfill");
	console.log(`  listed as newer than the archive : ${report.listed}`);
	console.log(`  skipped (noise)                  : ${skipped} ${JSON.stringify(report.skipped)}`);
	console.log(`  considered                       : ${report.considered}`);
	console.log(`  already current                  : ${report.upToDate}`);
	console.log(`  sessions ${args.dryRun ? "to write" : "written"}                : ${report.sessionsWritten}`);
	console.log(`  chunks ${args.dryRun ? "to write" : "written"}                  : ${report.chunks}`);
	console.log(`  failed                           : ${report.failed}`);
} catch (error) {
	console.error(`archive backfill: ${(error as Error).message}`);
	process.exitCode = 1;
} finally {
	await client.end();
}
