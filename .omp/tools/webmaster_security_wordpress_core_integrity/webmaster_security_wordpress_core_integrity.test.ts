import { afterAll, describe, expect, it } from "bun:test";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, coreIntegrityVerdict, parseChecksums } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = { name: NAME, check: CHECK, description: DESCRIPTION, makeTool: makeTool as never, commands: ["core_checksums"] as const };
serverToolCases(subject);

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (server: ReplayServer) =>
  resultOf(await toolFor(subject, depsFor(server, sites.directory)), { site: "example.org" });

describe("webmaster_security_wordpress_core_integrity: the rule", () => {
  it("flags the modified and the unexpected files a compromised server reports, high", async () => {
    const result = await check(replay("compromised"));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.core_integrity", "high"]]);
    expect(result.findings[0]?.evidence).toContain("2 WordPress core file(s)");
    expect(result.findings[0]?.evidence).toContain("wp-includes/load.php");
    expect(result.findings[0]?.evidence).toContain("wp-includes/class-wp-cache-helper.php");
  });

  it("passes a clean server", async () => {
    expect(await check(replay("clean"))).toMatchObject({ status: "pass", findings: [] });
  });

  it("reads modified and should-not-exist files the way wp core verify-checksums prints them", () => {
    expect(parseChecksums(1, "Warning: File doesn't verify against checksum: wp-login.php\nWarning: File should not exist: x.php")).toEqual({
      verified: false,
      modified: ["wp-login.php"],
      unexpected: ["x.php"],
    });
    expect(parseChecksums(0, "Success: WordPress installation verifies against checksums.")).toEqual({
      verified: true,
      modified: [],
      unexpected: [],
    });
  });

  it("is unmeasured, never passing, when it exits non-zero without naming a file", async () => {
    const result = await check(
      replay("clean", { core_checksums: { code: 1, stdout: "", stderr: "Error: Couldn't get checksums from WordPress.org." } }),
    );
    expect(result).toMatchObject({ status: "unmeasured", findings: [] });
    expect(result.reason).toContain("could not read the output");
  });

  it("is unmeasured when the command did not run or the inspection was not made", async () => {
    const missing = await check(replay("clean", { core_checksums: { code: 127, stdout: "", stderr: "wp: command not found" } }));
    expect(missing.status).toBe("unmeasured");
    expect(missing.reason).toContain("did not run (exit 127)");
    expect(coreIntegrityVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    expect(coreIntegrityVerdict({ ...inspectFixture("clean"), outputs: [] })).toEqual({
      unmeasured: "the inspection did not run `core_checksums`",
    });
  });
});
