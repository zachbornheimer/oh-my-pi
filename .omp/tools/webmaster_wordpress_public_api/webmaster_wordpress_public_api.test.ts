import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeSecurityNet } from "./fake_net.ts";
import { measureWordpressPublicApi, RELEASES_URL, releasesFrom, REST_BATCH_BODY } from "./public_api.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { loadZod } from "./zod_for_tests.ts";

/** A trimmed copy (`offers[].{response,current}`) of WordPress.org's public `core/version-check/1.7/` answer. */
const VERSION_CHECK = readFileSync(new URL("./fixtures/version-check-1.7.json", import.meta.url), "utf8");

const SITE = "https://example.org";

describe("the WordPress release list", () => {
  const releases = releasesFrom(VERSION_CHECK);

  it("holds the newest release of every branch once, newest first", () => {
    expect(releases[0]).toBe("7.1.3");
    expect(releases.filter((version) => version === "7.1.3")).toHaveLength(1);
    expect(releases).toContain("6.4.13");
    const branches = releases.map((version) => version.split(".").slice(0, 2).join("."));
    expect(new Set(branches).size).toBe(branches.length);
  });

  it("refuses an answer that is not the release shape", () => {
    expect(() => releasesFrom("{}")).toThrow(/no offers/);
    expect(() => releasesFrom("not json")).toThrow();
    expect(releasesFrom(JSON.stringify({ offers: [{ response: "upgrade", current: "7.1.3" }, { nope: 1 }] }))).toEqual(["7.1.3"]);
  });
});

describe("the WordPress public API collection", () => {
  it("POSTs only the empty batch, to the two batch routes, and GETs everything else", async () => {
    const net = new FakeSecurityNet({ http: { [`${SITE}/`]: { status: 200, contentType: "text/html", body: "home" } } });
    await measureWordpressPublicApi({ siteUrl: SITE }, net);
    const posts = net.sent.filter((request) => request.method !== "GET");
    expect(posts).toEqual([
      { method: "POST", url: `${SITE}/?rest_route=/batch/v1`, body: REST_BATCH_BODY },
      { method: "POST", url: `${SITE}/wp-json/batch/v1`, body: REST_BATCH_BODY },
    ]);
    expect(JSON.parse(REST_BATCH_BODY)).toEqual({ requests: [] });
    // Every request but the release list goes to the site itself.
    expect(net.sent.filter((request) => !request.url.startsWith(`${SITE}/`)).map((request) => request.url)).toEqual([RELEASES_URL]);
  });

  it("records each endpoint's answer and the release list", async () => {
    const net = new FakeSecurityNet({
      http: {
        [`${SITE}/`]: { status: 200, contentType: "text/html", body: '<meta name="generator" content="WordPress 6.4.1" />' },
        [`${SITE}/xmlrpc.php`]: { status: 405, contentType: "text/plain", body: "XML-RPC server accepts POST requests only." },
        [RELEASES_URL]: { status: 200, contentType: "application/json", body: '{"offers":[{"current":"6.7.1"},{"current":"6.4.5"}]}' },
      },
    });
    const api = await measureWordpressPublicApi({ siteUrl: SITE }, net);
    if (api.status !== "measured") throw new Error("expected a measurement");
    expect(api.home.body).toContain("WordPress 6.4.1");
    expect(api.xmlrpc).toMatchObject({ method: "GET", path: "/xmlrpc.php", status: 405 });
    expect(api.users.map((each) => each.path)).toEqual(["/wp-json/wp/v2/users", "/?rest_route=/wp/v2/users"]);
    expect(api.author.path).toBe("/?author=1");
    expect(api.releases).toEqual({ status: "measured", versions: ["6.7.1", "6.4.5"] });
  });

  it("follows one redirect within the site for the home page and feed, and records the new path", async () => {
    const net = new FakeSecurityNet({
      http: {
        [`${SITE}/`]: { status: 301, contentType: "", location: `${SITE}/home/`, body: "" },
        [`${SITE}/home/`]: { status: 200, contentType: "text/html", body: "real home" },
        [`${SITE}/feed/`]: { status: 301, contentType: "", location: "https://other.example/feed", body: "" },
      },
    });
    const api = await measureWordpressPublicApi({ siteUrl: SITE }, net);
    if (api.status !== "measured") throw new Error("expected a measurement");
    expect(api.home).toMatchObject({ path: "/home/", status: 200, body: "real home" });
    // A redirect to another host is reported, not followed.
    expect(api.feed).toMatchObject({ path: "/feed/", status: 301, location: "https://other.example/feed" });
    expect(net.sent.some((request) => request.url.startsWith("https://other.example"))).toBe(false);
  });

  it("redacts secret-looking values in a kept body", async () => {
    const net = new FakeSecurityNet({
      http: { [`${SITE}/`]: { status: 200, contentType: "text/html", body: "DB_PASSWORD=hunter2" } },
    });
    expect(JSON.stringify(await measureWordpressPublicApi({ siteUrl: SITE }, net))).not.toContain("hunter2");
  });

  it("is unmeasured as a whole when the home page does not answer", async () => {
    const net = new FakeSecurityNet({ http: { [`${SITE}/`]: new Error("ENOTFOUND") } });
    expect(await measureWordpressPublicApi({ siteUrl: SITE }, net)).toEqual({
      status: "unmeasured",
      reason: `${SITE}/ did not answer: ENOTFOUND`,
    });
  });

  it("keeps the other answers when only the release list fails", async () => {
    const net = new FakeSecurityNet({ http: { [RELEASES_URL]: new Error("ECONNRESET") } });
    const api = await measureWordpressPublicApi({ siteUrl: SITE }, net);
    expect(api).toMatchObject({
      status: "measured",
      releases: { status: "unmeasured", reason: "the WordPress releases are unknown: ECONNRESET" },
    });
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(measureWordpressPublicApi({ siteUrl: SITE }, new FakeSecurityNet(), controller.signal)).rejects.toThrow();
  });
});

describe("the tool", () => {
  it("loads against omp's own zod and refuses an invalid input", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net: new FakeSecurityNet() });
    expect(tool.name).toBe("webmaster_wordpress_public_api");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "" }).success).toBe(false);
    expect(schema.safeParse({ site: 3 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("returns { site, public_api } as details and text, asking the site's own address", async () => {
    const net = new FakeSecurityNet({ http: { [`${SITE}/`]: { status: 200, contentType: "text/html", body: "home" } } });
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net });
    const result = await tool.execute("id", { site: "https://www.example.org/some/page" }, undefined, undefined);
    expect(result.details.site).toBe("example.org");
    // The site is asked at the address as given: `www.` is kept for requests and dropped only from the reported apex.
    expect(net.sent[0]?.url).toBe("https://www.example.org/");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("refuses a site that is not a host", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net: new FakeSecurityNet() });
    await expect(tool.execute("id", { site: "not a host" }, undefined, undefined)).rejects.toThrow(/not a domain or address/);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("never says whether");
  });
});
