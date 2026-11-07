import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, performanceMeasured } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_measurements tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_measurements");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  const fakeProbes = (asked: string[]) => ({
    seo: async () => (asked.push("seo"), seoMeasured()),
    content: async () => (asked.push("content"), contentMeasured()),
    performance: async (_u: string, f: string) => (asked.push("performance:" + f), performanceMeasured()),
    screenshot: async () => (asked.push("screenshot"), { status: "unmeasured" as const, reason: "no browser" }),
  });

  it("runs seo and content by default and returns raw measurements", async () => {
    const asked: string[] = [];
    const result = await run(makeTool(await makePi(), { probes: fakeProbes(asked) as never }), { url: "https://example.org/" });
    const details = result.details as { measurements: Record<string, { status: string }> };
    expect(asked.sort()).toEqual(["content", "seo"]);
    expect(Object.keys(details.measurements).sort()).toEqual(["content", "seo"]);
    expect(details.measurements.seo!.status).toBe("measured");
  });

  it("runs only the asked probes once each, with the form factor, and keeps unmeasured as a value", async () => {
    const asked: string[] = [];
    const result = await run(makeTool(await makePi(), { probes: fakeProbes(asked) as never }), {
      url: "https://example.org/",
      probes: ["performance", "screenshot", "performance"],
      form_factor: "desktop",
    });
    const details = result.details as { measurements: Record<string, { status: string; reason?: string }> };
    expect(asked.sort()).toEqual(["performance:desktop", "screenshot"]);
    expect(details.measurements.screenshot).toEqual({ status: "unmeasured", reason: "no browser" });
    expect(() => makeTool({ zod: undefined } as never)).toThrow();
    const tool = makeTool(await makePi());
    expect(() => tool.parameters.parse({ url: "https://example.org/", probes: ["whois"] })).toThrow();
  });
});
