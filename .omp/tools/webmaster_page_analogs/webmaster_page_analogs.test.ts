import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, performanceMeasured, scriptedStep, PURPOSE_JSON } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_analogs tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_analogs");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  const probes = {
    seo: async () => seoMeasured(),
    content: async () => contentMeasured(),
    performance: async () => performanceMeasured(),
  };
  const QUERIES = {
    Queries: { industry: "membership organizations", sameIndustry: ["best membership pages"], differentIndustry: ["join page examples"] },
  };

  it("is unmeasured, and says why, when every search fails", async () => {
    const step = scriptedStep((p) => (p.startsWith("## Purpose") ? PURPOSE_JSON : p.startsWith("## Queries") ? QUERIES : undefined));
    const search = (async () => {
      throw new Error("search down");
    }) as never;
    const result = await run(makeTool(await makePi(), { probes, step, search }), { url: "https://example.org/membership" });
    const details = result.details as { sameIndustry: unknown[]; differentIndustry: unknown[]; unmeasured?: string };
    expect(details.sameIndustry).toEqual([]);
    expect(details.differentIndustry).toEqual([]);
    expect(details.unmeasured).toContain("every search failed");
    expect(details.unmeasured).toContain("search down");
  });

  it("does not search when the target is not auditable", async () => {
    let searches = 0;
    const search = (async () => (searches += 1, { provider: "duckduckgo", results: [] })) as never;
    const step = scriptedStep(() => undefined);
    const down = {
      ...probes,
      content: async () => ({ status: "unmeasured" as const, reason: "HTTP 403 at x" }),
    };
    const result = await run(makeTool(await makePi(), { probes: down as never, step, search }), { url: "https://example.org/x" });
    expect((result.details as { unmeasured?: string }).unmeasured).toContain("not auditable");
    expect(searches).toBe(0);
    expect(step.prompts).toHaveLength(0);
  });

  it("keeps only analogs that were fetched in this run and titles that match", async () => {
    const hit = (url: string) => ({ title: "Club", url, snippet: "s" });
    const search = (async () => ({
      provider: "duckduckgo",
      results: ["https://a.example.com/join", "https://b.example.com/join", "https://c.example.com/join"].map(hit),
    })) as never;
    const choice = (url: string, title: string) => ({
      url, organization: "Org", industry: "clubs", whyAnalogous: "same intent", observedTitle: title, standoutPattern: "clear CTA",
    });
    const step = scriptedStep((p) => {
      if (p.startsWith("## Purpose")) return PURPOSE_JSON;
      if (p.startsWith("## Queries")) return QUERIES;
      if (p.startsWith("## Analogs")) {
        return {
          Analogs: {
            sameIndustry: [choice("https://a.example.com/join", "Wrong title"), choice("https://never-fetched.example.org/", "X")],
            differentIndustry: [],
            rejected: [],
          },
        };
      }
      if (p.startsWith("## FollowUp")) return { FollowUp: { queries: ["another query"] } };
      return undefined;
    });
    const longText = async () => ({ ...contentMeasured(), visible_text: contentMeasured().status === "measured" ? "Join the club today. ".repeat(60) : "" });
    const seoTitled = { ...probes, seo: async () => seoMeasured({ title: "Club" }), content: longText };
    const result = await run(makeTool(await makePi(), { probes: seoTitled as never, step, search }), { url: "https://example.org/membership" });
    const details = result.details as {
      sameIndustry: { url: string }[];
      rejected: { url: string; reason: string }[];
      shortfalls: { set: string; kept: number; minimum: number }[];
    };
    expect(details.sameIndustry.map((a) => a.url)).not.toContain("https://never-fetched.example.org/");
    expect(JSON.stringify(details.rejected)).toContain("never-fetched.example.org");
    expect(details.shortfalls.length).toBeGreaterThan(0);
  });
});
