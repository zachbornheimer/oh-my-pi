import { describe, expect, it } from "bun:test";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, scriptedStep, SECTIONS_JSON } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_sections tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_sections");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it("returns the model's sections in order", async () => {
    const step = scriptedStep((p) => (p.startsWith("## Sections") ? SECTIONS_JSON : undefined));
    const probes = { seo: async () => seoMeasured(), content: async () => contentMeasured() };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/membership" });
    const details = result.details as { sections: { ordinal: number; name: string; servesPurpose: string }[] };
    expect(details.sections).toEqual([
      { ordinal: 1, name: "Hero", content: "Join the club", goal: "Hook", servesPurpose: "yes", note: null },
    ]);
  });

  it("returns no sections and the reason, with no model call, when the content cannot be read", async () => {
    const step = scriptedStep(() => undefined);
    const probes = {
      seo: async () => seoMeasured(),
      content: async () => ({ status: "unmeasured" as const, reason: "could not read x" }),
    };
    const result = await run(makeTool(await makePi(), { probes, step }), { url: "https://example.org/x" });
    expect(result.details).toEqual({ url: "https://example.org/x", sections: [], unmeasured: "could not read x" });
    expect(step.prompts).toHaveLength(0);
    const bad = scriptedStep(() => ({ Sections: [{ ordinal: 0, name: "" }] }));
    const ok = { seo: async () => seoMeasured(), content: async () => contentMeasured() };
    await expect(run(makeTool(await makePi(), { probes: ok, step: bad }), { url: "https://example.org/x" })).rejects.toThrow();
  });
});
