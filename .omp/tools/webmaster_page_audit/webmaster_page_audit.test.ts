import { describe, expect, it } from "bun:test";
import { systemHost } from "./probe_performance.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { makePi, texts, seoMeasured, contentMeasured, performanceMeasured, scriptedStep, PURPOSE_JSON, SECTIONS_JSON, FINDINGS_JSON, rankAll, judgeAll } from "./fixtures_for_tests.ts";

const run = (tool: ReturnType<typeof makeTool>, params: object) =>
  tool.execute("t", params as never, undefined as never, undefined, undefined);

describe("webmaster_page_audit tool", () => {
  it("describes itself without machine paths and refuses a non-http address", async () => {
    expect(DESCRIPTION).not.toContain("/Users/");
    expect(DESCRIPTION).toContain("unmeasured");
    const tool = makeTool(await makePi());
    expect(tool.name).toBe("webmaster_page_audit");
    await expect(run(tool, { url: "ftp://example.org/" })).rejects.toThrow("http or https");
    await expect(run(tool, { url: "not a url" })).rejects.toThrow("not an address");
    await expect(run(tool, { url: "https://user:secret@example.org/" })).rejects.toThrow("credentials");
    expect(() => tool.parameters.parse({})).toThrow();
  });

  const answer = (p: string) =>
    p.startsWith("## Purpose")
      ? PURPOSE_JSON
      : p.startsWith("## Sections")
      ? SECTIONS_JSON
      : p.startsWith("## Findings")
      ? FINDINGS_JSON
      : rankAll(p) ?? judgeAll(p);

  const probesFor = (asked: string[]) => ({
    seo: async () => (asked.push("seo"), seoMeasured()),
    content: async () => (asked.push("content"), contentMeasured()),
    performance: async () => (asked.push("performance"), performanceMeasured()),
    accessibility: async () => (asked.push("accessibility"), { status: "unmeasured" as const, reason: "no browser" }),
    links: async () => (
      asked.push("links"),
      { status: "measured" as const, final_url: "https://example.org/membership", checked: 3, truncated: false, broken: [{ url: "https://example.org/gone", status: 404 }] }
    ),
    privacy: async () => (asked.push("privacy"), { status: "measured" as const, final_url: "https://example.org/membership", tracker_hosts: [], consent_gate: "absent" as const }),
  });

  it("measures only the asked areas and ranks the merged findings", async () => {
    const asked: string[] = [];
    const step = scriptedStep(answer);
    const result = await run(makeTool(await makePi(), { probes: probesFor(asked) as never, step, search: (async () => { throw new Error("no search"); }) as never }), {
      url: "https://example.org/membership",
      areas: ["links", "accessibility"],
    });
    const details = result.details as {
      areas: Record<string, unknown>;
      findings: { id: string; priority: number; rank: number }[];
      judgment: { purpose: { intentClass: string } };
      research?: unknown;
      summary: { health: string; unmeasured: { area: string; reason: string }[]; finding_counts: Record<string, number>; headline: string };
    };
    expect(Object.keys(details.areas).sort()).toEqual(["accessibility", "links"]);
    expect(asked).not.toContain("performance");
    expect(asked).not.toContain("seo");
    expect(details.research).toBeUndefined();
    expect(details.findings).toHaveLength(1);
    expect(details.findings[0]).toMatchObject({ priority: 3, rank: 1 });
    expect(details.judgment.purpose.intentClass).toBe("convert");
    expect(details.summary.health).toBe("needs_attention");
    expect(details.summary.unmeasured).toEqual([{ area: "accessibility", reason: "no browser" }]);
    expect(details.summary.headline.length).toBeGreaterThan(0);
  });

  it("reports health unknown when every asked area was unmeasured", async () => {
    const asked: string[] = [];
    const step = scriptedStep(answer);
    const result = await run(makeTool(await makePi(), { probes: probesFor(asked) as never, step }), {
      url: "https://example.org/membership",
      areas: ["accessibility"],
    });
    const details = result.details as { findings: unknown[]; summary: { health: string } };
    expect(details.findings).toEqual([]);
    expect(details.summary.health).toBe("unknown");
    expect(step.prompts.some((p) => p.includes('"priorities"'))).toBe(false);
  });

  it("degrades a failed research stage to an unmeasured result instead of failing the audit", async () => {
    const asked: string[] = [];
    const step = scriptedStep((p) => (p.startsWith("## Queries") ? undefined : answer(p)));
    const search = (async () => {
      throw new Error("search down");
    }) as never;
    const result = await run(makeTool(await makePi(), { probes: probesFor(asked) as never, step, search }), {
      url: "https://example.org/membership",
      areas: ["links"],
      research: true,
    });
    const details = result.details as { research: { analogs: { unmeasured?: string } }; summary: { unmeasured: { area: string }[] } };
    expect(details.research.analogs.unmeasured).toContain("analogs:");
    expect(details.summary.unmeasured.some((u) => u.area === "research")).toBe(true);
  });
});

describe("the real speed host", () => {
  it("starts only the programs the probe uses", async () => {
    const refused = await systemHost.run("rm", ["-rf", "/nonexistent"]);
    expect(refused.code).toBe(127);
    expect(refused.stderr).toContain("command not allowed: rm");
    const started = await systemHost.run("bunx", ["--version"]);
    expect(started.code).toBe(0);
  });

  it("reaches only the PageSpeed endpoint", async () => {
    await expect(systemHost.fetch("https://example.org/?q=1", { signal: AbortSignal.timeout(1000) })).rejects.toThrow("not the PageSpeed endpoint");
  });
});
