import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, scriptedStep, PURPOSE_JSON } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_purpose tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_purpose");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("judges the purpose from the measured page", async () => {
    const step = scriptedStep((p) => (p.startsWith("## Purpose") ? PURPOSE_JSON : undefined));
    const probes = { seo: async () => seoMeasured(), content: async () => contentMeasured() };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/membership" });
    const details = result.details as { intentClass: string; primaryAction: string; evidence: string[]; unmeasured?: string };
    expect(details.intentClass).toBe("convert");
    expect(details.primaryAction).toBe("Join now");
    expect(details.unmeasured).toBeUndefined();
    expect(step.prompts[0]).toContain("Join the club");
  });

  it("is not auditable, with no model call, when the content cannot be read", async () => {
    const step = scriptedStep(() => undefined);
    const probes = {
      seo: async () => seoMeasured(),
      content: async () => ({ status: "unmeasured" as const, reason: "HTTP 403 at x" }),
    };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/x" });
    const details = result.details as { intentClass: string; unmeasured: string };
    expect(details.intentClass).toBe("not auditable");
    expect(details.unmeasured).toBe("HTTP 403 at x");
    expect(step.prompts).toHaveLength(0);
  });

  it("fails when the model never gives a valid purpose", async () => {
    const step = scriptedStep(() => ({ Purpose: { purpose: "" } }));
    const probes = { seo: async () => seoMeasured(), content: async () => contentMeasured() };
    await expect(run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/x" })).rejects.toThrow();
  });
});
