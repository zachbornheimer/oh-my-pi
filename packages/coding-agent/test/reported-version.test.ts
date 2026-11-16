import { describe, expect, it } from "bun:test";
import { parseReportedVersion } from "@oh-my-pi/pi-coding-agent/cli/update-cli";

describe("parseReportedVersion", () => {
	it("reads the version from the first line when a release build appends its identity", () => {
		expect(
			parseReportedVersion("omp/18.0.5\ngithub.com/zachbornheimer/oh-my-pi@build-20261105143448-2155dff-295d1a6"),
		).toBe("18.0.5");
		expect(parseReportedVersion("omp/18.0.5")).toBe("18.0.5");
	});
});
