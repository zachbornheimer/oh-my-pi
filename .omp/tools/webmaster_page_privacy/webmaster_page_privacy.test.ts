import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_privacy tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_privacy");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("reports tracker hosts requested before any click", async () => {
    const open = (async (url: string, work: (page: unknown) => Promise<unknown>) =>
      work({
        finalUrl: url,
        requestUrls: () => ["https://www.googletagmanager.com/gtm.js?id=GTM-ABC", "https://example.org/app.js"],
        html: async () => "<html></html>",
        axeViolations: async () => [],
      })) as never;
    const result = await run(makeTool(await makePi(), { open }), { url: "https://example.org/" });
    const details = result.details as { findings: { area: string; severity: string; evidence: string }[] };
    expect(details.findings).toHaveLength(1);
    expect(details.findings[0]!.area).toBe("privacy");
    expect(details.findings[0]!.evidence).toContain("googletagmanager.com");
  });

  it("is clean when no tracker is requested, and unmeasured when the browser fails", async () => {
    const quiet = (async (url: string, work: (page: unknown) => Promise<unknown>) =>
      work({ finalUrl: url, requestUrls: () => [], html: async () => "", axeViolations: async () => [] })) as never;
    const clean = await run(makeTool(await makePi(), { open: quiet }), { url: "https://example.org/" });
    expect((clean.details as { findings: unknown[] }).findings).toEqual([]);
    const broken = (async () => {
      throw new Error("no chromium");
    }) as never;
    const failed = await run(makeTool(await makePi(), { open: broken }), { url: "https://example.org/" });
    expect((failed.details as { unmeasured?: string }).unmeasured).toContain("no chromium");
  });
});
