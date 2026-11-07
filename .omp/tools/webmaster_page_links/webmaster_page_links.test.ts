import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_links tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_links");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  const response = (url: string, status: number, body = "") => ({
    status,
    url,
    xRobotsTag: "",
    contentType: "text/html",
    body,
    ttfbMs: 1,
  });

  it("fetches internal links only and reports the 4xx and 5xx ones", async () => {
    const seen: string[] = [];
    const fetchPage = (async (url: string) => {
      seen.push(url);
      if (url === "https://example.org/about") {
        return response(
          url,
          200,
          '<a href="/ok">ok</a><a href="/gone">gone</a><a href="https://other.com/x">ext</a><a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="/ok#again">dup</a>',
        );
      }
      return response(url, url.endsWith("/gone") ? 404 : 200);
    }) as never;
    const result = await run(makeTool(await makePi(), { fetchPage }), { url: "https://example.org/about" });
    const details = result.details as { checked: number; truncated: boolean; findings: { severity: string; evidence: string }[] };
    expect(seen.sort()).toEqual(["https://example.org/about", "https://example.org/gone", "https://example.org/ok"]);
    expect(details.checked).toBe(2);
    expect(details.truncated).toBe(false);
    expect(details.findings).toHaveLength(1);
    expect(details.findings[0]!.severity).toBe("high");
    expect(details.findings[0]!.evidence).toContain("/gone");
  });

  it("caps the links fetched and says so; a 404 page is unmeasured", async () => {
    const many = Array.from({ length: 60 }, (_, i) => '<a href="/p' + i + '">p</a>').join("");
    const fetchPage = (async (url: string) => response(url, 200, url.endsWith("/page") ? many : "")) as never;
    const result = await run(makeTool(await makePi(), { fetchPage }), { url: "https://example.org/page" });
    const details = result.details as { checked: number; truncated: boolean };
    expect(details.checked).toBe(40);
    expect(details.truncated).toBe(true);
    const missing = (async (url: string) => response(url, 404)) as never;
    const gone = await run(makeTool(await makePi(), { fetchPage: missing }), { url: "https://example.org/page" });
    expect((gone.details as { unmeasured?: string }).unmeasured).toContain("HTTP 404");
  });
});
