import { afterAll, describe, expect, it } from "bun:test";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, debugFiles, KNOWN_MU_PLUGINS, muPluginsVerdict } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = { name: NAME, check: CHECK, description: DESCRIPTION, makeTool: makeTool as never, commands: ["must_use_plugins"] as const };
serverToolCases(subject);

const sites = siteDirectory();
const withSettings = siteDirectory({ extra: "security:\n  known_mu_plugins:\n    - wp-cache-helper\n  debug_file_patterns:\n    - wp-cache-*\n" });
afterAll(() => {
  sites.cleanup();
  withSettings.cleanup();
});
const check = async (server: ReplayServer, params: object = {}, directory = sites.directory) =>
  resultOf(await toolFor(subject, depsFor(server, directory)), { site: "example.org", ...params });
const plugins = (...rows: [name: string, status: string][]) => JSON.stringify(rows.map(([name, status]) => ({ name, status })));

describe("webmaster_security_wordpress_mu_plugins: the rule", () => {
  it("flags the must-use plugin nobody vouched for on a compromised server, high, and not the known ones", async () => {
    const result = await check(replay("compromised"));
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.mu_plugins.unknown", "high"]]);
    expect(result.findings[0]?.evidence).toContain("wp-cache-helper (must-use)");
    expect(result.findings[0]?.evidence).not.toContain("0-worker");
    expect(result.findings[0]?.evidence).not.toContain("advanced-cache.php");
  });

  it("passes a clean server", async () => {
    expect(await check(replay("clean"))).toMatchObject({ status: "pass", findings: [] });
  });

  it("takes the vouched plugins and debug globs from the input", async () => {
    const result = await check(replay("compromised"), { known_mu_plugins: ["wp-cache-helper"], debug_file_patterns: ["wp-cache-*"] });
    expect(result.findings.map((finding) => finding.id)).toEqual(["security.wordpress.mu_plugins.debug_file"]);
    expect(result.findings[0]?.evidence).toContain("wp-cache-helper");
  });

  it("takes them from the site file when the input omits them, or sends null", async () => {
    for (const params of [{}, { known_mu_plugins: null, debug_file_patterns: null }]) {
      const result = await check(replay("compromised"), params, withSettings.directory);
      expect(result.findings.map((finding) => finding.id)).toEqual(["security.wordpress.mu_plugins.debug_file"]);
    }
  });

  it("lets a list in the input replace the site file's, not add to it", async () => {
    const result = await check(replay("compromised"), { known_mu_plugins: [], debug_file_patterns: [] }, withSettings.directory);
    expect(result.findings.map((finding) => finding.id)).toEqual(["security.wordpress.mu_plugins.unknown"]);
  });

  it("ignores plugins that are not must-use or drop-ins, and names drop-ins with their status", async () => {
    const stdout = plugins(["akismet", "active"], ["hello", "inactive"], ["custom-loader", "must-use"], ["advanced-cache.php", "dropin"], ["evil.php", "dropin"]);
    const result = await check(replay("clean", { must_use_plugins: { stdout } }));
    expect(result.findings[0]?.evidence).toContain("custom-loader (must-use), evil.php (dropin)");
    expect(result.findings[0]?.evidence).not.toContain("akismet");
  });

  it("matches debug globs without case, with `*` and `?`, over the whole name", () => {
    expect(debugFiles(["Debug-Bar.php", "keep.php", "x-debug.php"], ["debug-*"])).toEqual(["Debug-Bar.php"]);
    expect(debugFiles(["a1.php", "ab1.php"], ["a?.php"])).toEqual(["a1.php"]);
    expect(debugFiles(["a.php", "axphp"], ["a.php"])).toEqual(["a.php"]);
    expect(debugFiles(["keep.php"], [])).toEqual([]);
    expect(KNOWN_MU_PLUGINS).toContain("object-cache.php");
  });

  it("is unmeasured, never passing, when the command did not run, failed or printed something unreadable", async () => {
    const missing = await check(replay("clean", { must_use_plugins: { code: 127, stdout: "", stderr: "wp: command not found" } }));
    expect(missing).toMatchObject({ status: "unmeasured", findings: [] });
    expect(missing.reason).toContain("did not run (exit 127)");
    expect((await check(replay("clean", { must_use_plugins: { code: 1, stdout: "[]", stderr: "Error" } }))).status).toBe("unmeasured");
    expect((await check(replay("clean", { must_use_plugins: { stdout: "Fatal error" } }))).status).toBe("unmeasured");
  });

  it("is unmeasured when the inspection was not made", () => {
    expect(muPluginsVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    expect(muPluginsVerdict({ ...inspectFixture("clean"), outputs: [] })).toEqual({
      unmeasured: "the inspection did not run `must_use_plugins`",
    });
  });

  it("accepts null and omitted lists in its parameters, and refuses a list of non-strings", async () => {
    const tool = await toolFor(subject, {});
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org", known_mu_plugins: null, debug_file_patterns: ["debug-*"] }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", known_mu_plugins: [1] }).success).toBe(false);
  });
});
