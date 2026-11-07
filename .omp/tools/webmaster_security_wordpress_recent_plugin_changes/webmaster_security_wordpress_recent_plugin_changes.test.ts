import { afterAll, describe, expect, it } from "bun:test";
import { CONTENT, FakeWordpressServer, zycmsLayout } from "./fake_server.ts";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, recentPluginChangesVerdict } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: makeTool as never,
  commands: ["content_directories", "plugin_directories", "theme_directories"] as const,
};
serverToolCases(subject);

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (server: { run: ReplayServer["run"] }) =>
  resultOf(await toolFor(subject, depsFor(server, sites.directory)), { site: "example.org" });
const withoutFolder = (folder: string) =>
  Object.fromEntries(Object.entries(zycmsLayout().directories).filter(([path]) => !path.startsWith(folder)));

describe("webmaster_security_wordpress_recent_plugin_changes: the rule on recordings", () => {
  it("flags a compromised server's changed plugin and theme folders, high because a file manager changed", async () => {
    const result = await check(replay("compromised"));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.recent_plugin_changes", "high"]]);
    expect(result.findings[0]?.evidence).toContain("plugin directories wp-file-manager, akismet");
    expect(result.findings[0]?.evidence).toContain("theme directories twentytwentyfour-child");
    expect(result.findings[0]?.evidence).toContain("Changed in the last 14 days");
  });

  it("passes a clean server", async () => {
    expect(await check(replay("clean"))).toMatchObject({ status: "pass", findings: [] });
  });

  it("rates a change with no file manager low", async () => {
    const result = await check(replay("compromised", { plugin_directories: { stdout: "/var/www/example/wp-content/plugins/akismet\n" } }));
    expect(result.findings.map((finding) => finding.severity)).toEqual(["low"]);
    expect(result.findings[0]?.evidence).not.toContain("file manager plugin gives");
  });

  it("is unmeasured, never passing, when the plugin scan did not run, or the themes could not be scanned and plugins show nothing", async () => {
    const missing = await check(replay("clean", { plugin_directories: { code: 127, stdout: "", stderr: "find: command not found" } }));
    expect(missing.status).toBe("unmeasured");
    const themes = await check(replay("clean", { theme_directories: { code: 127, stdout: "", stderr: "find: command not found" } }));
    expect(themes.status).toBe("unmeasured");
    expect(recentPluginChangesVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    expect(recentPluginChangesVerdict({ ...inspectFixture("clean"), outputs: [] })).toMatchObject({ unmeasured: expect.any(String) });
  });

  it("reports the change it saw and names the folder it could not scan", async () => {
    const result = await check(replay("compromised", { theme_directories: { code: 127, stdout: "", stderr: "find: command not found" } }));
    expect(result.status).toBe("fail");
    expect(result.findings[0]?.evidence).toContain("Themes were not scanned");
  });
});

describe("webmaster_security_wordpress_recent_plugin_changes: on a site whose content folder is not wp-content", () => {
  it("scans the plugin and theme folders WordPress names and flags the recent changes in them", async () => {
    const result = await check(new FakeWordpressServer(zycmsLayout()));
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.recent_plugin_changes", "high"]]);
    expect(result.findings[0]?.evidence).toContain("plugin directories wp-file-manager");
    expect(result.findings[0]?.evidence).toContain("theme directories twentytwentyfour-child");
  });

  it("flags a changed theme on its own, low", async () => {
    const directories = { ...zycmsLayout().directories, [`${CONTENT}/plugins/wp-file-manager`]: { recent: false } };
    const result = await check(new FakeWordpressServer(zycmsLayout({ directories })));
    expect(result.findings.map((finding) => finding.severity)).toEqual(["low"]);
    expect(result.findings[0]?.evidence).toContain("theme directories");
    expect(result.findings[0]?.evidence).not.toContain("plugin directories");
  });

  it("is unmeasured, never passing, when a folder is missing and nothing else shows a change", async () => {
    const quiet = { ...withoutFolder(`${CONTENT}/plugins`), [`${CONTENT}/themes/twentytwentyfour-child`]: { recent: false } };
    const result = await check(new FakeWordpressServer(zycmsLayout({ directories: quiet })));
    expect(result.status).toBe("unmeasured");
    expect(result.reason).toMatch(/cannot be scanned.*No such file or directory/);
  });

  it("reports the change it saw and says which folder it could not scan", async () => {
    const result = await check(new FakeWordpressServer(zycmsLayout({ directories: withoutFolder(`${CONTENT}/themes`) })));
    expect(result.status).toBe("fail");
    expect(result.findings[0]?.evidence).toContain("Themes were not scanned");
  });

  it("is unmeasured when WordPress cannot name its folders, and scans nothing", async () => {
    const server = new FakeWordpressServer(zycmsLayout({ contentDirectories: "unresolvable" }));
    const result = await check(server);
    expect(result.status).toBe("unmeasured");
    expect(result.reason).toMatch(/could not resolve the content folders/);
    expect(server.runs.filter((each) => each.commandLine.includes(" find "))).toEqual([]);
  });
});
