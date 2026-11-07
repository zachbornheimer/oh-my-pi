import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, performanceMeasured, scriptedStep, judgeAll } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_performance tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_performance");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("derives tones and findings from the measured metrics without a model for poor ones", async () => {
    const step = scriptedStep(judgeAll);
    const probes = { performance: async () => performanceMeasured() };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/" });
    const details = result.details as {
      source: string;
      form_factor: string;
      tones: Record<string, string>;
      findings: { id: string; severity: string }[];
    };
    expect(details.source).toBe("psi");
    expect(details.form_factor).toBe("mobile");
    expect(Object.values(details.tones)).toContain("poor");
    expect(details.findings.length).toBeGreaterThan(0);
    expect(details.findings.some((f) => f.severity === "high")).toBe(true);
  });

  it("passes form_factor to the probe and reports an unmeasured page with its reason", async () => {
    const asked: string[] = [];
    const probes = {
      performance: async (_url: string, factor: string) => {
        asked.push(factor);
        return { status: "unmeasured" as const, reason: "no PageSpeed key; local Lighthouse failed: x" };
      },
    };
    const step = scriptedStep(() => undefined);
    const result = await run(makeTool(await makePi(), { probes: probes as never, step }), {
      url: "https://example.org/",
      form_factor: "desktop",
    });
    expect(asked).toEqual(["desktop"]);
    const details = result.details as { source: string; findings: unknown[]; reason?: string };
    expect(details.source).toBe("unmeasured");
    expect(details.findings).toEqual([]);
    expect(details.reason).toContain("no PageSpeed key");
    expect(step.prompts).toHaveLength(0);
    expect(() => makeTool({ zod: undefined } as never)).toThrow();
  });
});
