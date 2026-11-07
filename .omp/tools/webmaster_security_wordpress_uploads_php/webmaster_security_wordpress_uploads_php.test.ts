import { afterAll, describe, expect, it } from "bun:test";
import { CONTENT, FakeWordpressServer, zycmsLayout } from "./fake_server.ts";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, uploadsPhpVerdict } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: makeTool as never,
  commands: ["content_directories", "uploads_php"] as const,
};
serverToolCases(subject);

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (server: { run: ReplayServer["run"] }) =>
  resultOf(await toolFor(subject, depsFor(server, sites.directory)), { site: "example.org" });
const withoutFolder = (folder: string) =>
  Object.fromEntries(Object.entries(zycmsLayout().directories).filter(([path]) => !path.startsWith(folder)));

describe("webmaster_security_wordpress_uploads_php: the rule on recordings", () => {
  it("flags the PHP files a compromised server keeps in uploads, high", async () => {
    const result = await check(replay("compromised"));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.uploads_php", "high"]]);
    expect(result.findings[0]?.evidence).toContain("uploads/2026/10/x.php");
    expect(result.findings[0]?.evidence).toContain("shell.phtml");
  });

  it("passes a clean server", async () => {
    expect(await check(replay("clean"))).toMatchObject({ status: "pass", findings: [] });
  });

  it("is unmeasured, never passing, when the scan did not run, failed, or the inspection was not made", async () => {
    const missing = await check(replay("clean", { uploads_php: { code: 127, stdout: "", stderr: "find: command not found" } }));
    expect(missing).toMatchObject({ status: "unmeasured", findings: [] });
    expect(missing.reason).toContain("did not run (exit 127)");
    const failed = await check(replay("clean", { uploads_php: { code: 2, stdout: "", stderr: "find: illegal option" } }));
    expect(failed.status).toBe("unmeasured");
    expect(uploadsPhpVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    expect(uploadsPhpVerdict({ ...inspectFixture("clean"), outputs: [] })).toEqual({
      unmeasured: "the inspection did not run `uploads_php`",
    });
  });
});

describe("webmaster_security_wordpress_uploads_php: on a site whose content folder is not wp-content", () => {
  it("scans the uploads folder WordPress names and flags the PHP file in it, not the leftover wp-content", async () => {
    const server = new FakeWordpressServer(zycmsLayout());
    const result = await check(server);
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.uploads_php", "high"]]);
    expect(result.findings[0]?.evidence).toContain(`${CONTENT}/uploads/2026/cache-1.php`);
    expect(result.findings[0]?.evidence).not.toContain("photo.jpg");
    expect(server.runs.some((run) => run.commandLine.includes("/wp-content/uploads"))).toBe(false);
  });

  it("is unmeasured, never passing, when the folder is missing", async () => {
    const directories = withoutFolder(`${CONTENT}/uploads`);
    const result = await check(new FakeWordpressServer(zycmsLayout({ directories, files: [] })));
    expect(result.status).toBe("unmeasured");
    expect(result.reason).toMatch(/cannot be scanned.*No such file or directory/);
  });

  it("is unmeasured when WordPress cannot name its folders, and scans nothing", async () => {
    const server = new FakeWordpressServer(zycmsLayout({ contentDirectories: "unresolvable" }));
    const result = await check(server);
    expect(result.status).toBe("unmeasured");
    expect(result.reason).toMatch(/could not resolve the content folders/);
    expect(server.runs.filter((each) => each.commandLine.includes(" find "))).toEqual([]);
  });

  it("still judges a folder that was read in part: an unreadable subfolder is not a missing folder", async () => {
    const quiet = zycmsLayout({ files: [], unreadable: [`${CONTENT}/uploads/private`] });
    expect(await check(new FakeWordpressServer(quiet))).toMatchObject({ status: "pass", findings: [] });
    const withFile = zycmsLayout({ unreadable: [`${CONTENT}/uploads/private`] });
    expect((await check(new FakeWordpressServer(withFile))).status).toBe("fail");
  });
});
