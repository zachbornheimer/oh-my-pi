import { describe, expect, it } from "bun:test";
import {
	compareBuildTags,
	fetchLatestForkReleaseTag,
	forkMiseVersion,
	isNewerRelease,
	parseBuildTag,
	parseForkIdentity,
	parseReportedBuildTag,
	STALE_BUILD_MS,
	staleBuildWarning,
} from "@oh-my-pi/pi-coding-agent/cli/fork-release";

const TAG = "build-20261125104043-e1a9f4b-2937770";
const BUILT_AT = Date.UTC(2026, 10, 25, 10, 40, 43);

describe("fork release identity", () => {
	it("reads the build instant from a release tag", () => {
		expect(parseBuildTag(TAG)).toBe(BUILT_AT);
		expect(parseForkIdentity(TAG)).toEqual({ tag: TAG, builtAt: BUILT_AT });
	});

	it("treats an empty or non-release identity as not a fork build", () => {
		expect(parseForkIdentity("")).toBeUndefined();
		expect(parseForkIdentity(undefined)).toBeUndefined();
		expect(parseForkIdentity("v19.1.0")).toBeUndefined();
	});

	it("finds the identity line of `omp --version` output", () => {
		expect(parseReportedBuildTag(`omp/19.1.0\n${TAG}\n`)).toBe(TAG);
		expect(parseReportedBuildTag("omp/19.1.0\n")).toBeUndefined();
	});

	it("orders releases by their stamp, not their commit hashes", () => {
		expect(compareBuildTags("build-20261125144041-b505770-8b86073", TAG)).toBeGreaterThan(0);
		expect(compareBuildTags(TAG, "build-20261125144041-0000000-0000000")).toBeLessThan(0);
		expect(compareBuildTags(TAG, TAG)).toBe(0);
		expect(isNewerRelease("build-20261125144041-b505770-8b86073", TAG)).toBe(true);
		expect(isNewerRelease(TAG, TAG)).toBe(false);
	});

	it("names the mise version the tool's build- prefix strips", () => {
		expect(forkMiseVersion(TAG)).toBe("20261125104043-e1a9f4b-2937770");
	});
});

describe("stale build warning", () => {
	const build = { tag: TAG, builtAt: BUILT_AT };

	it("stays quiet for a build up to 24 hours old", () => {
		expect(staleBuildWarning(build, BUILT_AT + STALE_BUILD_MS)).toBeUndefined();
	});

	it("warns once the build is over 24 hours old and names its age and the fix", () => {
		const warning = staleBuildWarning(build, BUILT_AT + STALE_BUILD_MS + 60_000);
		expect(warning).toContain("24h old");
		expect(warning).toContain(TAG);
		expect(warning).toContain("omp update");
	});

	it("reports days past two days", () => {
		expect(staleBuildWarning(build, BUILT_AT + 3 * 24 * 3_600_000)).toContain("3d old");
	});
});

describe("fork release lookup", () => {
	const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

	it("asks the fork's repository, not upstream's", async () => {
		let requested = "";
		const tag = await fetchLatestForkReleaseTag({
			token: "t",
			fetchImpl: async input => {
				requested = String(input);
				return new Response(JSON.stringify({ tag_name: TAG }));
			},
		});
		expect(tag).toBe(TAG);
		expect(requested).toBe("https://api.github.com/repos/zachbornheimer/oh-my-pi/releases/latest");
	});

	it("rejects a failed answer and a release without a build tag", async () => {
		await expect(fetchLatestForkReleaseTag({ fetchImpl: answer(403, {}) })).rejects.toThrow("403");
		await expect(fetchLatestForkReleaseTag({ fetchImpl: answer(200, { tag_name: "v19.1.0" }) })).rejects.toThrow(
			"no build tag",
		);
	});
});
