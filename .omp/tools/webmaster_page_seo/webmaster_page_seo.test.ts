import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, scriptedStep, judgeAll } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_seo tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_seo");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("judges the rule findings with the model and gives it the site", async () => {
    const step = scriptedStep(judgeAll);
    const probes = { seo: async () => seoMeasured() };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/membership" });
    const details = result.details as {
      facts: { title: string };
      findings: { id: string; severity: string; confidence?: number }[];
    };
    expect(step.prompts).toHaveLength(1);
    expect(step.prompts[0]).toContain("unknown site");
    expect(details.findings.length).toBeGreaterThan(0);
    expect(details.findings.every((f) => f.severity === "medium" && f.confidence === 0.8)).toBe(true);
    expect(details.findings.some((f) => f.id.startsWith("seo."))).toBe(true);
  });

  it("asks no model when the page is unmeasured, and fails on a missing site file", async () => {
    const step = scriptedStep(() => undefined);
    const probes = { seo: async () => ({ status: "unmeasured" as const, reason: "HTTP 500 at x" }) };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/x" });
    expect(result.details).toEqual({ url: "https://example.org/x", findings: [], unmeasured: "HTTP 500 at x" });
    expect(step.prompts).toHaveLength(0);
    await expect(
      run(makeTool(await makePi(), { probes, step, sitesDirectory: "/tmp/definitely-no-sites-here" }), {
        url: "https://example.org/x",
        site: "nope",
      }),
    ).rejects.toThrow();
  });

  it("retries a malformed model reply and then uses the valid one", async () => {
    let calls = 0;
    const step = (async (prompt: string) => {
      calls += 1;
      return calls === 1 ? "not json" : JSON.stringify(judgeAll(prompt));
    }) as never;
    const probes = { seo: async () => seoMeasured() };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/membership" });
    expect(calls).toBe(2);
    expect((result.details as { findings: unknown[] }).findings.length).toBeGreaterThan(0);
  });
});
