import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, performanceMeasured, scriptedStep } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_synthesis tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_synthesis");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("stops at a typed unmeasured result, with no search, when the purpose is not auditable", async () => {
    let searches = 0;
    const search = (async () => (searches += 1, { provider: "duckduckgo", results: [] })) as never;
    const step = scriptedStep((p) =>
      p.startsWith("## Purpose")
        ? {
          Purpose: {
            purpose: "Login wall",
            intentClass: "not auditable",
            primaryAudience: "not auditable",
            primaryAction: null,
            evidence: [],
          },
        }
        : undefined
    );
    const probes = {
      seo: async () => seoMeasured(),
      content: async () => contentMeasured(),
      performance: async () => performanceMeasured(),
    };
    const result = await run(makeTool(await makePi(), { probes, step, search }), { url: "https://example.org/x" });
    expect(result.details).toEqual({ url: "https://example.org/x", unmeasured: "Login wall" });
    expect(searches).toBe(0);
    expect(step.prompts).toHaveLength(1);
  });

  it("describes every layer it needs and refuses a missing site", async () => {
    expect(DESCRIPTION).toContain("CURRENT");
    expect(DESCRIPTION).toContain("analog_index");
    const probes = {
      seo: async () => seoMeasured(),
      content: async () => contentMeasured(),
      performance: async () => performanceMeasured(),
    };
    await expect(
      run(makeTool(await makePi(), { probes, step: scriptedStep(() => undefined), sitesDirectory: "/tmp/no-sites-dir" }), {
        url: "https://example.org/x",
        site: "nope",
      }),
    ).rejects.toThrow();
  });
});
