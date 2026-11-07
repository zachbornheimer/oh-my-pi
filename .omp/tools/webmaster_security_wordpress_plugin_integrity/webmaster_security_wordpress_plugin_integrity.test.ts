import { afterAll, describe, expect, it } from "bun:test";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, pluginIntegrityVerdict } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = { name: NAME, check: CHECK, description: DESCRIPTION, makeTool: makeTool as never, commands: ["plugin_checksums"] as const };
serverToolCases(subject);

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (server: ReplayServer) =>
  resultOf(await toolFor(subject, depsFor(server, sites.directory)), { site: "example.org" });

describe("webmaster_security_wordpress_plugin_integrity: the rule", () => {
  it("flags the plugin files a compromised server reports as differing, high, though WP-CLI exited 1", async () => {
    const result = await check(replay("compromised"));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.plugin_integrity", "high"]]);
    expect(result.findings[0]?.evidence).toContain("2 plugin file(s)");
    expect(result.findings[0]?.evidence).toContain("wp-file-manager: lib/php/connector.minimal.php (Checksum does not match)");
    expect(result.findings[0]?.evidence).toContain("akismet: wp-shell.php (File was added)");
  });

  it("passes a clean server whose plugins all verified", async () => {
    expect(await check(replay("clean"))).toMatchObject({ status: "pass", findings: [] });
  });

  it("FIXED: no rows with a non-zero exit is a command that failed, not a pass", async () => {
    const result = await check(
      replay("clean", { plugin_checksums: { code: 1, stdout: "", stderr: "Error: This does not seem to be a WordPress installation." } }),
    );
    expect(result).toMatchObject({ status: "unmeasured", findings: [] });
    expect(result.reason).toContain("could not read the output");
    expect(result.reason).toContain("This does not seem to be a WordPress installation");
  });

  it("is unmeasured, never passing, when the command printed something that is not JSON", async () => {
    const result = await check(replay("clean", { plugin_checksums: { stdout: "Fatal error: Uncaught Error" } }));
    expect(result.status).toBe("unmeasured");
    expect(result.reason).toContain("could not read the output");
  });

  it("is unmeasured when the command did not run or the inspection was not made", async () => {
    const missing = await check(replay("clean", { plugin_checksums: { code: 127, stdout: "", stderr: "wp: command not found" } }));
    expect(missing.status).toBe("unmeasured");
    expect(missing.reason).toContain("did not run (exit 127)");
    expect(pluginIntegrityVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    expect(pluginIntegrityVerdict({ ...inspectFixture("clean"), outputs: [] })).toEqual({
      unmeasured: "the inspection did not run `plugin_checksums`",
    });
  });
});
