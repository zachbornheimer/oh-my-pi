/**
 * Regression tests for process-wide session storage selection when
 * `SESSIONS_DB_URL` holds a non-SQL connection URL — e.g. an unresolved
 * 1Password `op://` secret reference pushed into a machine's agent env
 * (seen on backend.ai 2026-11-02): `Bun.SQL` rejects such a URL at client
 * construction, and a cached rejection kills every session-bearing call
 * site at startup. Selection must instead log a clear error once and fall
 * back to local file storage so sessions keep working on local disk.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	resetSessionStorageForTesting,
	resolveSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const savedUrl = process.env.SESSIONS_DB_URL;
const savedAlias = process.env.OMP_SESSION_PATH_PREFIX_ALIAS;

afterEach(() => {
	if (savedUrl === undefined) delete process.env.SESSIONS_DB_URL;
	else process.env.SESSIONS_DB_URL = savedUrl;
	if (savedAlias === undefined) delete process.env.OMP_SESSION_PATH_PREFIX_ALIAS;
	else process.env.OMP_SESSION_PATH_PREFIX_ALIAS = savedAlias;
	resetSessionStorageForTesting();
});

describe("resolveSessionStorage with a non-SQL SESSIONS_DB_URL", () => {
	it("falls back to file storage when the URL is an unresolved op:// secret reference", async () => {
		process.env.SESSIONS_DB_URL = "op://Personal/omp-session-db-url/credential";
		resetSessionStorageForTesting();
		await expect(resolveSessionStorage()).resolves.toBeInstanceOf(FileSessionStorage);
	});

	it("falls back to file storage for any unsupported URL protocol", async () => {
		process.env.SESSIONS_DB_URL = "ftp://example.invalid/sessions";
		resetSessionStorageForTesting();
		await expect(resolveSessionStorage()).resolves.toBeInstanceOf(FileSessionStorage);
	});

	it("keeps file storage when SESSIONS_DB_URL is unset", async () => {
		delete process.env.SESSIONS_DB_URL;
		resetSessionStorageForTesting();
		expect(await resolveSessionStorage()).toBeInstanceOf(FileSessionStorage);
	});
});
