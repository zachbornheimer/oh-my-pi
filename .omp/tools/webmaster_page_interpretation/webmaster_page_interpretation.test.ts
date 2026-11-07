import { describe, expect, it } from "bun:test";
import { systemHost } from "./probe_performance.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, performanceMeasured, scriptedStep, PURPOSE_JSON, FINDINGS_JSON } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_interpretation tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_interpretation");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  const answer = (p: string) => (p.startsWith("## Purpose") ? PURPOSE_JSON : p.startsWith("## Findings") ? FINDINGS_JSON : undefined);

  it("judges the purpose, then interprets the measurements with it", async () => {
    const step = scriptedStep(answer);
    const probes = {
      seo: async () => seoMeasured(),
      content: async () => contentMeasured(),
      performance: async () => performanceMeasured(),
    };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/membership" });
    expect((result.details as { findings: unknown[] }).findings).toEqual(FINDINGS_JSON.Findings);
    expect(step.prompts).toHaveLength(2);
    expect(step.prompts[1]).toContain("Convince visitors to join the membership.");
    expect(step.prompts[1]).toContain("6500");
  });

  it("is unmeasured with the reason when no probe read anything", async () => {
    const down = async () => ({ status: "unmeasured" as const, reason: "HTTP 500 at x" });
    const step = scriptedStep(answer);
    const result = await run(
      makeTool(await makePi(), { probes: { seo: down, content: down, performance: down } as never, step }),
      { url: "https://example.org/x" },
    );
    const details = result.details as { findings: unknown[]; unmeasured?: string };
    expect(details.findings).toEqual([]);
    expect(details.unmeasured).toBe("HTTP 500 at x");
    expect(step.prompts.filter((p) => p.startsWith("## Findings"))).toHaveLength(0);
  });
});

describe("the real speed-probe host", () => {
  it("refuses any program the probe does not need", async () => {
    const refused = await systemHost.run("sh", ["-c", "echo hi"]);
    expect(refused.code).toBe(127);
    expect(refused.stderr).toContain("is not a program the speed probe may run");
  });
});
