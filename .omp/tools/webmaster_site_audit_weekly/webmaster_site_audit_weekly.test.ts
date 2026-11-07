import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSites, PAGE_CAP, type PageAuditSlice, type SiteAuditPorts, type SitemapSlice } from "./audit";
import { keyUrls, liveAuditPorts } from "./live";
import { contentMeasured, FINDINGS_JSON, judgeAll, performanceMeasured, PURPOSE_JSON, rankAll, scriptedStep, SECTIONS_JSON, seoMeasured } from "./page/fixtures_for_tests";
import type { Certificate } from "./security/certificate";
import type { DnsResolver } from "./security/dns";
import { FakeSecurityNet } from "./security/fake_net";
import type { SiteSecurityResult } from "./security/site_security";
import type { Exec } from "./sitemap/omp_model";
import type { GetPage } from "./sitemap/crawl";
import { DESCRIPTION, makeTool } from "./tool";
import { loadZod } from "./zod_for_tests";
import { readmeVersion } from "./security/wp_core_version";

const security = (site: string, severities: string[]): SiteSecurityResult => ({
  site,
  checks: [],
  findings: severities.map((severity) => ({ id: "x", area: "security", severity, evidence: "e", containment: "c", fix_hint: "f" })) as never,
  unmeasured: [],
});
const sitemap = (severities: string[]): SitemapSlice => ({
  sitemap_url: "https://x/sitemap.xml",
  urls_total: 3,
  findings: severities.map((severity) => ({ id: "s", severity, evidence: "e" })) as never,
});
const page = (severities: string[]): PageAuditSlice => ({
  health: "needs_attention",
  headline: "h",
  findings: severities.map((severity) => ({ severity })),
  unmeasured: [],
  purpose: "p",
  interpretation: [],
});

interface Calls {
  order: string[];
  research: boolean[];
}
function fakePorts(over: Partial<SiteAuditPorts> = {}, keyPages: Record<string, string[]> = {}): { ports: SiteAuditPorts; calls: Calls } {
  const calls: Calls = { order: [], research: [] };
  const ports: SiteAuditPorts = {
    sites: async () => ["alpha", "beta"],
    pages: async (site) => {
      if (site === "ghost") throw new Error(`site "ghost": no site file`);
      return { url: `https://${site}.example`, pages: keyPages[site] ?? [`https://${site}.example/`] };
    },
    security: async (site) => {
      calls.order.push(`security ${site}`);
      return security(site, ["high"]);
    },
    sitemap: async (site) => {
      calls.order.push(`sitemap ${site}`);
      return sitemap(["low"]);
    },
    auditPage: async (_site, url, research) => {
      calls.order.push(`page ${url}`);
      calls.research.push(research);
      return page(["medium"]);
    },
    ...over,
  };
  return { ports, calls };
}

describe("auditSites", () => {
  it("audits every site file in turn: security, sitemap, then each key page, and totals the findings by severity", async () => {
    const { ports, calls } = fakePorts();
    const audit = await auditSites({}, ports);
    expect(calls.order).toEqual([
      "security alpha", "sitemap alpha", "page https://alpha.example/",
      "security beta", "sitemap beta", "page https://beta.example/",
    ]);
    expect(audit.totals).toEqual({ high: 2, low: 2, medium: 2 });
    expect(audit.research).toBe(false);
    expect(audit.sites.map((site) => [site.site, site.status, site.url])).toEqual([
      ["alpha", "audited", "https://alpha.example"],
      ["beta", "audited", "https://beta.example"],
    ]);
    expect(audit.sites[0]).toMatchObject({
      security: { status: "checked", result: { site: "alpha" } },
      sitemap: { status: "checked", urls_total: 3 },
      pages: [{ url: "https://alpha.example/", status: "audited", health: "needs_attention" }],
    });
  });

  it("audits only the named sites, once each, and hands the research flag to every page audit", async () => {
    const { ports, calls } = fakePorts();
    const audit = await auditSites({ sites: ["beta", "beta"], research: true }, ports);
    expect(audit.sites.map((site) => site.site)).toEqual(["beta"]);
    expect(audit.research).toBe(true);
    expect(calls.research).toEqual([true]);
  });

  it("records a site that cannot be located as failed and keeps going", async () => {
    const { ports } = fakePorts();
    const audit = await auditSites({ sites: ["ghost", "alpha"] }, ports);
    expect(audit.sites[0]).toEqual({ site: "ghost", status: "failed", error: `site "ghost": no site file`, pages: [] });
    expect(audit.sites[1]?.status).toBe("audited");
  });

  it("keeps a failed security check, sitemap or page as data that does not stop the others, and counts only what returned", async () => {
    const { ports } = fakePorts({
      security: async () => { throw new Error("ssh refused"); },
      sitemap: async () => { throw new Error("sitemap down"); },
      auditPage: async (_s, url) => { if (url.endsWith("/bad")) throw new Error("timeout"); return page(["low"]); },
    }, { alpha: ["https://alpha.example/", "https://alpha.example/bad", "https://alpha.example/ok"] });
    const audit = await auditSites({ sites: ["alpha"] }, ports);
    const alpha = audit.sites[0]!;
    expect(alpha.security).toEqual({ status: "failed", error: "ssh refused" });
    expect(alpha.sitemap).toEqual({ status: "failed", error: "sitemap down" });
    expect(alpha.pages.map((row) => row.status)).toEqual(["audited", "failed", "audited"]);
    expect(alpha.pages[1]).toEqual({ url: "https://alpha.example/bad", status: "failed", error: "timeout" });
    expect(audit.totals).toEqual({ low: 2 });
  });

  it(`audits at most ${PAGE_CAP} key pages and says how many it did not fetch`, async () => {
    const urls = Array.from({ length: 11 }, (_, index) => `https://alpha.example/p${index}`);
    const { ports, calls } = fakePorts({}, { alpha: urls });
    const audit = await auditSites({ sites: ["alpha"] }, ports);
    expect(audit.sites[0]?.pages).toHaveLength(PAGE_CAP);
    expect(audit.sites[0]?.pagesTruncated).toBe(3);
    expect(calls.order.filter((entry) => entry.startsWith("page "))).toHaveLength(PAGE_CAP);
    const small = await auditSites({ sites: ["beta"] }, fakePorts().ports);
    expect(small.sites[0]).not.toHaveProperty("pagesTruncated");
  });

  it("throws on a cancelled run instead of recording the cancellation as a failed check", async () => {
    const controller = new AbortController();
    const { ports } = fakePorts({
      security: async () => { controller.abort(); throw new Error("aborted"); },
    });
    await expect(auditSites({}, ports, controller.signal)).rejects.toThrow();
    const before = new AbortController();
    before.abort();
    await expect(auditSites({}, fakePorts().ports, before.signal)).rejects.toThrow();
  });

  it("reports progress per site and step", async () => {
    const notes: string[] = [];
    await auditSites({ sites: ["alpha"] }, fakePorts().ports, undefined, (note) => notes.push(note));
    expect(notes).toEqual(["alpha: locating", "alpha: security", "alpha: sitemap", "alpha: page https://alpha.example/"]);
  });
});

describe("keyUrls", () => {
  it("resolves declared key URL paths against the site address, drops repeats and unusable entries", () => {
    expect(keyUrls("uptime:\n  key_urls:\n    - path: /about\n    - path: /about\n    - path: https://other.example/x\n    - nothing: 1\n", "https://a.example")).toEqual([
      "https://a.example/about",
      "https://other.example/x",
    ]);
  });
  it("falls back to the site address alone when none is declared or the file is not YAML", () => {
    expect(keyUrls("url: https://a.example\n", "https://a.example")).toEqual(["https://a.example"]);
    expect(keyUrls("[: not yaml", "https://a.example")).toEqual(["https://a.example"]);
  });
});

describe("live ports", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "site-audit-files-"));
    writeFileSync(join(directory, "example.yaml"), "url: https://example.org\nplatform: wordpress\ntier: client\nuptime:\n  key_urls:\n    - path: /about\n");
    writeFileSync(join(directory, "parked.yaml"), "url: https://parked.example\ntier: personal\n");
    writeFileSync(join(directory, "notes.md"), "not a site");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const exec = (async () => { throw new Error("exec must not run"); }) as unknown as Exec;
  const resolver: DnsResolver = {
    a: async () => ["192.0.2.10"],
    aaaa: async () => [],
    cname: async () => [],
    mx: async () => [],
    ns: async () => [],
    txt: async () => [],
  };
  const read: Certificate = { valid_to: "2099-01-01T00:00:00.000Z", subject_names: ["example.org", "*.example.org"], issuer: "Example CA", authorized: true, fingerprint256: "AA" };
  const SITEMAP = "https://example.org/sitemap.xml";
  const getPage: GetPage = async (url) => {
    if (url === "https://example.org/robots.txt") return { status: 200, contentType: "text/plain", xRobotsTag: "", body: `Sitemap: ${SITEMAP}` };
    if (url === SITEMAP) return { status: 200, contentType: "application/xml", xRobotsTag: "", body: "<urlset><url><loc>https://example.org/</loc></url></urlset>" };
    return { status: 200, contentType: "text/html", xRobotsTag: "", body: "<html><body>hello</body></html>" };
  };
  const modelCalls: string[] = [];
  let zod: unknown;
  beforeAll(async () => { zod = await loadZod(); });
  const pageAnswer = (prompt: string) =>
    prompt.startsWith("## Purpose") ? PURPOSE_JSON
      : prompt.startsWith("## Sections") ? SECTIONS_JSON
      : prompt.startsWith("## Findings") ? FINDINGS_JSON
      : rankAll(prompt) ?? judgeAll(prompt);
  const pageFakes = () => ({
    step: scriptedStep(pageAnswer),
    probes: {
      seo: async () => seoMeasured(),
      content: async () => contentMeasured(),
      performance: async () => performanceMeasured(),
      accessibility: async () => ({ status: "unmeasured" as const, reason: "no browser in the test" }),
      links: async () => ({ status: "measured" as const, final_url: "https://example.org/about", checked: 3, truncated: false, broken: [{ url: "https://example.org/gone", status: 404 }] }),
      privacy: async () => ({ status: "measured" as const, final_url: "https://example.org/about", tracker_hosts: [], consent_gate: "absent" as const }),
    },
    search: (async () => { throw new Error("no search"); }) as never,
  });
  const ports = () =>
    liveAuditPorts({
      exec,
      zod: zod as never,
      page: pageFakes() as never,
      environment: {},
      sitesDirectory: directory,
      getPage,
      model: async (prompt) => { modelCalls.push(prompt); return "{}"; },
      security: {
        exec: exec as never,
        resolver,
        reader: { read: async () => read },
        net: new FakeSecurityNet({ http: { "https://example.org/": { status: 200, contentType: "text/html", body: "<html>hi</html>" } } }),
        getHome: async () => ({ status: 200, body: "<body><p>Welcome to our site</p></body>" }),
        screenshot: async () => ({ status: "unmeasured", reason: "no browser in the test" }),
      },
    });

  it("lists every site file, not only those listing security", async () => {
    expect(await ports().sites()).toEqual(["example", "parked"]);
  });

  it("reads a site's address and its key pages from the site file, and fails for a missing file or a bad name", async () => {
    expect(await ports().pages("example")).toEqual({ url: "https://example.org", pages: ["https://example.org/about"] });
    expect(await ports().pages("parked")).toEqual({ url: "https://parked.example", pages: ["https://parked.example"] });
    await expect(ports().pages("nope")).rejects.toThrow(/no site file/);
    await expect(ports().pages("../x")).rejects.toThrow(/not a site file name/);
  });

  it("runs the built-in security check over fakes, with every check answering and the server inspection off", async () => {
    const result = await ports().security("example");
    expect(result.site).toBe("example.org");
    expect(result.checks).toHaveLength(22);
    expect(result.unmeasured.some((entry) => entry.check.endsWith("core_integrity"))).toBe(true);
  });

  it("runs the built-in sitemap check, asking no model for a clean sitemap", async () => {
    const result = await ports().sitemap("example", "https://example.org");
    expect(result).toMatchObject({ sitemap_url: SITEMAP, urls_total: 1 });
    expect(result.findings.every((finding) => finding.severity === "info" || finding.severity === "low")).toBe(true);
    expect(modelCalls).toEqual([]);
  });

  it("audits a key page with the built-in page audit: probes, judgment stages and ranking over fakes", async () => {
    const slice = await ports().auditPage("example", "https://example.org/about", false);
    expect(slice.health).toBe("needs_attention");
    expect(slice.headline.length).toBeGreaterThan(0);
    expect(slice.purpose.length).toBeGreaterThan(0);
    expect(slice.findings.length).toBeGreaterThan(0);
    expect(slice.unmeasured).toEqual([{ area: "accessibility", reason: "no browser in the test" }]);
    expect(Array.isArray(slice.interpretation)).toBe(true);
  });

  it("refuses a page address that is not http or https, and an unknown site file, before measuring", async () => {
    await expect(ports().auditPage("example", "ftp://example.org/", false)).rejects.toThrow(/http or https/);
    await expect(ports().auditPage("nope", "https://example.org/", false)).rejects.toThrow(/no site file/);
  });

  it("says plainly that the page audit has no zod when none was given, and takes an injected page audit instead", async () => {
    const bare = liveAuditPorts({ exec, environment: {}, sitesDirectory: directory });
    await expect(bare.auditPage("example", "https://example.org/", false)).rejects.toThrow(/needs omp's zod/);
    const injected = liveAuditPorts({ exec, environment: {}, sitesDirectory: directory, auditPage: async () => page([]) });
    expect((await injected.auditPage("example", "https://example.org/", false)).health).toBe("needs_attention");
  });

  it("audits end to end over the live ports: security, sitemap and the page audit all return", async () => {
    const audit = await auditSites({ sites: ["example"] }, ports());
    const site = audit.sites[0]!;
    expect(site.security?.status).toBe("checked");
    expect(site.sitemap?.status).toBe("checked");
    expect(site.pages).toHaveLength(1);
    expect(site.pages[0]).toMatchObject({ url: "https://example.org/about", status: "audited", health: "needs_attention" });
    expect(JSON.stringify(audit)).not.toContain("BLOCKED");
    expect(audit.totals["medium"]).toBeGreaterThan(0);
  });
});

describe("the tool", () => {
  const build = async (ports: SiteAuditPorts) => makeTool({ zod: await loadZod(), cwd: ".", exec: exec as never } as never, { ports });
  const exec = (async () => { throw new Error("exec must not run"); }) as unknown as Exec;

  it("returns the audit in details and as JSON text, trimming and deduping the site names", async () => {
    const tool = await build(fakePorts().ports);
    const output = await tool.execute("id", { sites: [" alpha ", "alpha"], research: null }, undefined, undefined);
    expect(output.details.sites.map((site) => site.site)).toEqual(["alpha"]);
    expect(JSON.parse(output.content[0]!.text)).toEqual(output.details);
  });

  it("loads against omp's own zod: accepts valid input and null optionals, rejects an invalid one", async () => {
    const tool = await build(fakePorts().ports);
    const p = tool.parameters as unknown as { parse(value: unknown): unknown };
    expect(tool.name).toBe("webmaster_site_audit_weekly");
    expect(tool.loadMode).toBe("discoverable");
    expect(() => p.parse({})).not.toThrow();
    expect(() => p.parse({ sites: ["isjac"], research: true })).not.toThrow();
    expect(() => p.parse({ sites: null, research: null })).not.toThrow();
    expect(() => p.parse({ sites: [] })).toThrow();
    expect(() => p.parse({ sites: ["  "] })).toThrow();
    expect(() => p.parse({ research: "yes" })).toThrow();
  });

  it("has a description of 80 to 250 words that names its boundary, input, result, effects and the browser requirement", () => {
    const words = DESCRIPTION.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).not.toMatch(/BLOCKED/);
    expect(DESCRIPTION).toMatch(/playwright/);
    expect(DESCRIPTION).toMatch(/billed/);
    expect(DESCRIPTION).toMatch(/never fixes/);
  });
});

describe("readmeVersion", () => {
  it.each([
    ["Version 6.4.2", "6.4.2"],
    ["Version 6.4.", "6.4"],
    ["version   5.0", "5.0"],
    ["Version 6 then Version 1.2", "1.2"],
    ["Version 1.2..3", "1.2"],
    ["Stable tag. Version 4.9.26 notes", "4.9.26"],
  ])("reads %j as %j", (readme, expected) => {
    expect(readmeVersion(readme)).toBe(expected);
  });

  it.each(["Version 6", "Version .5", "Version x.y", "no number", ""])("finds nothing in %j", (readme) => {
    expect(readmeVersion(readme)).toBeUndefined();
  });
});
