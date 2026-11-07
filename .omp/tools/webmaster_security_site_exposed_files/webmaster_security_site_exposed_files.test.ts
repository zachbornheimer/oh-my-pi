import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposedKindOf, exposedVerdict, exposureSeverity } from "./exposed_files.ts";
import { FakeSecurityNet } from "./fake_net.ts";
import { DROP_PATHS, EXPOSURE_PATHS, type SitePublicFiles } from "./public_files.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { loadZod } from "./zod_for_tests.ts";

const SITE = "https://example.org";
const NO_SITE_FILES = join(tmpdir(), "no-such-wm-sites-dir");

/** What the compromised site of the original fixtures serves: a listing, an environment file and a config backup. */
const COMPROMISED = new FakeSecurityNet({
  http: {
    [`${SITE}/dev/`]: { status: 200, contentType: "text/html", body: "<title>Index of /dev/</title>" },
    [`${SITE}/.env`]: { status: 200, contentType: "text/plain", body: "APP_ENV=prod\nDB_PASSWORD=hunter2\n" },
    [`${SITE}/wp-config.php.bak`]: { status: 200, contentType: "application/x-trash", body: "<?php define('DB_NAME','x');" },
  },
});

const run = async (net: FakeSecurityNet, params: Record<string, unknown> = { site: "example.org" }) => {
  const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net, sitesDirectory: NO_SITE_FILES });
  return tool.execute("id", params as never, undefined, undefined);
};

describe("webmaster_security_site_exposed_files", () => {
  it("flags paths that served private content, high when any exposes data", async () => {
    const result = await run(COMPROMISED);
    expect(result.details).toMatchObject({ site: "example.org", check: "webmaster.security.site.exposed_files", status: "fail" });
    expect(result.details.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.site.exposed_files", "high"]]);
    expect(result.details.findings[0]?.evidence).toContain("/.env (environment file)");
    expect(result.details.findings[0]?.evidence).toContain("/dev/ (directory listing)");
    expect(result.details.findings[0]?.evidence).toContain("/wp-config.php.bak (PHP source)");
    // Evidence names paths and kinds, never what the files held.
    expect(JSON.stringify(result.details)).not.toContain("hunter2");
    expect(Object.keys(result.details.findings[0]!)).toEqual(["id", "area", "severity", "evidence", "fix_hint", "containment"]);
  });

  it("is medium when only archives, backups or listings are exposed", async () => {
    const net = new FakeSecurityNet({
      http: {
        [`${SITE}/backup.zip`]: { status: 200, contentType: "application/zip", body: "PK\u0003\u0004" },
        [`${SITE}/backups/`]: { status: 200, contentType: "text/html", body: "<title>Index of /backups/</title>" },
      },
    });
    const result = await run(net);
    expect(result.details.findings.map((finding) => finding.severity)).toEqual(["medium"]);
  });

  it("passes a site whose exposure paths answer nothing", async () => {
    const result = await run(new FakeSecurityNet());
    expect(result.details).toMatchObject({ status: "pass", findings: [] });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("is unmeasured, never pass, when no exposure path answered", async () => {
    const net = new FakeSecurityNet({
      http: Object.fromEntries([...EXPOSURE_PATHS, ...DROP_PATHS].map((path) => [`${SITE}${path}`, new Error("ENOTFOUND")])),
    });
    const result = await run(net);
    expect(result.details).toEqual({
      site: "example.org",
      check: "webmaster.security.site.exposed_files",
      status: "unmeasured",
      findings: [],
      reason: "https://example.org did not answer: ENOTFOUND",
    });
  });

  it("ignores an exposure path that answered with a redirect or an error, even when labelled", () => {
    const files: SitePublicFiles = {
      status: "measured",
      files: [
        { method: "GET", path: "/.env", status: 403, content_type: "text/plain", body: "", purpose: "exposure", exposed: "environment file" },
        { method: "GET", path: "/backup.zip", status: 301, content_type: "", body: "", purpose: "exposure" },
      ],
    };
    expect(exposedVerdict(files)).toEqual([]);
  });

  it("is unmeasured when the data was not collected or no exposure path answered", () => {
    expect(exposedVerdict(undefined)).toEqual({ unmeasured: "no public files were collected" });
    expect(exposedVerdict({ status: "unmeasured", reason: "down" })).toEqual({ unmeasured: "down" });
    expect(
      exposedVerdict({
        status: "measured",
        files: [{ method: "GET", path: "/.env", status: 0, content_type: "", body: "", purpose: "exposure", error: "ECONNRESET" }],
      }),
    ).toEqual({ unmeasured: "no exposure path was answered: ECONNRESET" });
  });

  it("sends only GET requests, to the site's own origin", async () => {
    const net = new FakeSecurityNet();
    await run(net);
    expect(net.sent.every((request) => request.method === "GET" && request.url.startsWith(`${SITE}/`))).toBe(true);
  });
});

describe("severity", () => {
  it("rates by the path's kind first, then by what it served", () => {
    expect(exposureSeverity("/.env", "environment file")).toBe("high");
    expect(exposureSeverity("/backup.sql", "database dump")).toBe("high");
    expect(exposureSeverity("/backup.zip", "archive")).toBe("medium");
    expect(exposureSeverity("/wp-config.php.bak", "PHP source")).toBe("medium");
    expect(exposureSeverity("/dev/", "directory listing")).toBe("medium");
    expect(exposureSeverity("/dev/", "PHP source")).toBe("high");
    expect(exposedKindOf("/.git/HEAD")).toBe("git");
    expect(exposedKindOf("/wp-content/debug.log")).toBe("log");
    expect(exposedKindOf("/phpinfo.php")).toBe("phpinfo");
    expect(exposedKindOf("/wp-content/uploads/")).toBeUndefined();
  });
});

describe("site-file exposure paths and input checks", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wm-sites-"));
    writeFileSync(join(directory, "example.yaml"), "name: example\nurl: https://www.example.org\nsecurity:\n  exposure_paths: [/private-export/]\n");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("asks the extra paths the site file names, and flags one that answers", async () => {
    const net = new FakeSecurityNet({
      http: { [`${SITE}/private-export/`]: { status: 200, contentType: "text/html", body: "<title>Index of /private-export/</title>" } },
    });
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net, sitesDirectory: directory });
    const result = await tool.execute("id", { site: "example.org" }, undefined, undefined);
    expect(result.details.findings[0]?.evidence).toContain("/private-export/ (directory listing)");
  });

  it("refuses a site that is not a host and a path that could leave the site", async () => {
    const zod = await loadZod();
    const tool = makeTool({ zod, cwd: "." } as never, { net: new FakeSecurityNet(), sitesDirectory: NO_SITE_FILES });
    await expect(tool.execute("id", { site: "not a host" }, undefined, undefined)).rejects.toThrow(/not a domain or address/);
    await expect(tool.execute("id", { site: "example.org", exposure_paths: ["//evil.example/x"] }, undefined, undefined)).rejects.toThrow(
      /must be a path of the site/,
    );
  });
});

describe("the tool", () => {
  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net: new FakeSecurityNet() });
    expect(tool.name).toBe("webmaster_security_site_exposed_files");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", exposure_paths: null }).success).toBe(true);
    expect(schema.safeParse({ site: 7 }).success).toBe(false);
    expect(schema.safeParse({ exposure_paths: [] }).success).toBe(false);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("never fixes");
  });
});
