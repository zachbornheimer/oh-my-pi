import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_accessibility tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_accessibility");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("turns axe violations into findings and never opens a real browser", async () => {
    const open = (async (url: string, work: (page: unknown) => Promise<unknown>) =>
      work({
        finalUrl: url,
        requestUrls: () => [],
        html: async () => "",
        axeViolations: async () => [
          { id: "color-contrast", impact: "serious", help: "Contrast too low", nodeCount: 3 },
          { id: "region", impact: "minor", help: "Use landmarks", nodeCount: 1 },
        ],
      })) as never;
    const result = await run(makeTool(await makePi(), { open }), { url: "https://example.org/about" });
    const details = result.details as { findings: { id: string; area: string; severity: string; evidence: string }[] };
    expect(details.findings.map((f) => f.severity).sort()).toEqual(["high", "medium"]);
    expect(details.findings.every((f) => f.area === "accessibility")).toBe(true);
    expect(texts(result as never)).toContain("color-contrast");
  });

  it("reports a browser that cannot open the page as unmeasured, not clean", async () => {
    const open = (async () => {
      throw new Error("browser failed to open");
    }) as never;
    const result = await run(makeTool(await makePi(), { open }), { url: "https://example.org/about" });
    const details = result.details as { findings: unknown[]; unmeasured?: string };
    expect(details.findings).toEqual([]);
    expect(details.unmeasured).toContain("browser failed to open");
  });
});
