import { describe, expect, it } from "bun:test";
import { coreStanding } from "./core_standing.ts";
import { apiFixture, netFor, releaseBody, SITE } from "./http_support.ts";
import { httpToolCases, run } from "./http_cases.ts";
import { RELEASES_URL } from "./public_api.ts";
import { CHECK, coreVersionVerdict, publishedVersion, readmeVersion, VERSION_HIDDEN_REASON } from "./rule.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: makeTool as never,
  requests: ["GET SITE/", "GET SITE/feed/", "GET SITE/readme.html", `GET ${RELEASES_URL}`],
  sibling: "webmaster_security_wordpress_auto_update_health",
};
httpToolCases(subject);

const page = (body: string) => ({ status: 200, contentType: "text/html", body });
const generator = (version: string) => page(`<meta name="generator" content="WordPress ${version}" />`);
const releases = (...versions: string[]) => ({ [RELEASES_URL]: { status: 200, contentType: "application/json", body: releaseBody(versions) } });
/** A site whose home, feed and readme publish nothing. */
const hidden = { [`${SITE}/`]: page("<html></html>"), [`${SITE}/feed/`]: page("<rss/>"), [`${SITE}/readme.html`]: { status: 404, contentType: "", body: "" } };

describe("webmaster_security_wordpress_core_version: the rule on recordings", () => {
  it("flags the compromised site's 6.4.3, behind 6.4.5 on its own branch, high", async () => {
    const result = await run(subject, netFor(apiFixture("compromised")));
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.core_version.behind_branch", "high"]]);
    expect(result.findings[0]?.evidence).toContain("WordPress 6.4.3, behind 6.4.5");
    expect(result.findings[0]?.evidence).toContain("newest overall 6.7.1");
  });

  it("passes a clean site on the newest release", async () => {
    expect(await run(subject, netFor(apiFixture("clean")))).toMatchObject({ status: "pass", findings: [] });
  });

  it("flags the latest of an older branch as older_branch, medium", async () => {
    const result = await run(subject, netFor(apiFixture("clean"), { [`${SITE}/`]: generator("6.6.2") }));
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.core_version.older_branch", "medium"]]);
  });

  it("reads the version from the feed, then the readme, when the generator tag is gone", async () => {
    const feed = netFor(apiFixture("clean"), { ...hidden, [`${SITE}/feed/`]: { status: 200, contentType: "application/rss+xml", body: "<generator>https://wordpress.org/?v=6.4.3</generator>" } });
    expect((await run(subject, feed)).findings[0]?.evidence).toContain("WordPress 6.4.3");
    const readme = netFor(apiFixture("clean"), { ...hidden, [`${SITE}/readme.html`]: page("<h1>WordPress</h1> Version 6.4.3") });
    expect((await run(subject, readme)).findings[0]?.evidence).toContain("WordPress 6.4.3");
  });

  it("reads a readme's version exactly as the former pattern /Version\\s+(\\d+(?:\\.\\d+)+)/i did", () => {
    const table: [string, string | undefined][] = [
      ["Version 6.5", "6.5"], ["version\t6.5.2", "6.5.2"], ["Version 6.5.", "6.5"], ["Version 6..5", undefined],
      ["Version 6", undefined], ["Version 6x.5", undefined], ["Version 6.5abc", "6.5"], ["Version .5", undefined],
      ["Version 6 then Version 7.1.2", "7.1.2"], ["Version 6..5 Version 7.1", "7.1"], ["Version6.5", undefined],
      ["no version here", undefined], ["", undefined],
    ];
    for (const [text, expected] of table) expect([text, readmeVersion(text)]).toEqual([text, expected]);
    expect(readmeVersion(`Version ${"1.".repeat(50_000)}!`)).toBeDefined();
  });

  it("reads a generator tag whichever order its attributes come in", () => {
    const tag = (body: string) => publishedVersion({ home: { method: "GET", path: "/", status: 200, content_type: "", body } });
    expect(tag('<meta content="WordPress 6.2.1" name="generator" />')).toBe("6.2.1");
    expect(tag('<meta name="generator" content="WordPress 6.2.1" />')).toBe("6.2.1");
    expect(tag("<html></html>")).toBeUndefined();
  });

  it("does not read a version from a page that did not answer 2xx", () => {
    const body = '<meta name="generator" content="WordPress 6.2.1" />';
    expect(publishedVersion({ home: { method: "GET", path: "/", status: 404, content_type: "", body } })).toBeUndefined();
  });

  it("is unmeasured, never passing, when the site hides its version", async () => {
    const result = await run(subject, netFor(apiFixture("clean"), hidden));
    expect(result).toMatchObject({ status: "unmeasured", findings: [], reason: VERSION_HIDDEN_REASON });
  });

  it("is unmeasured when the release list is unreadable or WordPress.org is unreachable", async () => {
    const broken = await run(subject, netFor(apiFixture("clean"), { [RELEASES_URL]: { status: 200, contentType: "application/json", body: "not json" } }));
    expect(broken.status).toBe("unmeasured");
    expect(broken.reason).toContain("the WordPress releases are unknown");
    const down = await run(subject, netFor(apiFixture("clean"), { [RELEASES_URL]: new Error("ECONNRESET") }));
    expect(down.reason).toContain("ECONNRESET");
  });

  it("is unmeasured when the home page did not answer, and when the public API was not read", async () => {
    const result = await run(subject, netFor(apiFixture("clean"), { [`${SITE}/`]: new Error("ETIMEDOUT") }));
    expect(result.status).toBe("unmeasured");
    expect(result.reason).toContain("ETIMEDOUT");
    expect(coreVersionVerdict({})).toEqual({ unmeasured: "the public API was not read" });
  });

  it("judges a version newer than every release as current", async () => {
    const result = await run(subject, netFor(apiFixture("clean"), { [`${SITE}/`]: generator("7.0.0"), ...releases("6.7.1") }));
    expect(result.status).toBe("pass");
  });
});

describe("coreStanding", () => {
  it("compares versions part by part, so 6.10 is newer than 6.9", () => {
    expect(coreStanding("6.9.1", ["6.10.0", "6.9.4"])).toMatchObject({ branchLatest: "6.9.4", newest: "6.10.0", status: "fail" });
    expect(coreStanding("6.9.4", ["6.10.0", "6.9.4"]).status).toBe("warn");
    expect(coreStanding("6.10.0", ["6.10.0", "6.9.4"]).status).toBe("pass");
  });
});
