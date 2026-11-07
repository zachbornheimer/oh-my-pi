import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMeta, type GetPage, type GetPageOptions, measureSitemap, parseSitemap, type PageResponse, spread } from "./crawl.ts";
import { judgementPrompt, MAX_JUDGED_FINDINGS, parseJudgements } from "./judge.ts";
import {
  canonicalHostOf,
  coverageFindings,
  listingFindings,
  missingProbePaths,
  noStatusCounts,
  reasonFromAddress,
  reasonFromPage,
  shouldNotBeListed,
  statusCounts,
} from "./rules.ts";
import type { SiteContext } from "./site_context.ts";
import { checkedAddress, runSitemap } from "./sitemap.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import type { Finding, SitemapMeasurement } from "./types.ts";
import { loadZod } from "./zod_for_tests.ts";

const SITE: SiteContext = {
  name: "example",
  url: "https://example.org",
  host: "example.org",
  tier: "client",
  platform: "wordpress",
  probe_paths: ["/", "/summit"],
  private_paths: ["/login", "/cart"],
  sitemap_disallow: ["/tag"],
  security: undefined,
} as never;

const SITEMAP_URL = "https://example.org/wp-sitemap.xml";
type Measured = Extract<SitemapMeasurement, { status: "measured" }>;

const messy: Measured = {
  status: "measured",
  sitemap_url: SITEMAP_URL,
  files_read: 2,
  urls_total: 8,
  urls: [
    "https://example.org/",
    "https://example.org/gone",
    "https://example.org/old",
    "https://example.org/hidden",
    "https://example.org/copy",
    "https://example.org/wp-admin/options.php",
    "https://staging.example.org/",
    "https://example.org/?p=12",
  ],
  pages: [
    { url: "https://example.org/", status: 200, noindex: false, canonical: "https://example.org/" },
    { url: "https://example.org/gone", status: 404, noindex: false },
    { url: "https://example.org/old", status: 301, location: "https://example.org/", noindex: false },
    { url: "https://example.org/hidden", status: 200, noindex: true },
    { url: "https://example.org/copy", status: 200, noindex: false, canonical: "https://example.org/" },
  ],
};

const clean: Measured = {
  status: "measured",
  sitemap_url: SITEMAP_URL,
  files_read: 1,
  urls_total: 2,
  urls: ["https://example.org/", "https://example.org/summit"],
  pages: [
    { url: "https://example.org/", status: 200, noindex: false },
    { url: "https://example.org/summit", status: 200, noindex: false },
  ],
};

describe("the rules: the first reason that applies, address rules before page rules", () => {
  it("lists each address that should not be listed with its reason, in sitemap order", () => {
    expect(shouldNotBeListed(messy, SITE)).toEqual([
      { url: "https://example.org/gone", reason: "404" },
      { url: "https://example.org/old", reason: "redirect" },
      { url: "https://example.org/hidden", reason: "noindex" },
      { url: "https://example.org/copy", reason: "duplicate_canonical" },
      { url: "https://example.org/wp-admin/options.php", reason: "private_pattern" },
      { url: "https://staging.example.org/", reason: "staging_host" },
      { url: "https://example.org/?p=12", reason: "private_pattern" },
    ]);
    expect(statusCounts(messy.pages)).toEqual({ "200": 3, "3xx": 1, "4xx": 1, "5xx": 0, unreachable: 0 });
  });

  it("applies the site's own private paths and sitemap policy, and the site's host over the sitemap's", () => {
    const urls = ["https://example.org/", "https://example.org/login", "https://example.org/tag/jazz", "https://example.org/cart/"];
    const measured = { ...clean, urls, urls_total: 4, pages: [] };
    expect(shouldNotBeListed(measured, SITE).map((entry) => entry.url)).toEqual([
      "https://example.org/login",
      "https://example.org/tag/jazz",
      "https://example.org/cart/",
    ]);
    expect(shouldNotBeListed(measured, undefined)).toEqual([]);
    expect(canonicalHostOf(measured, { ...SITE, host: "other.test" })).toBe("other.test");
    expect(canonicalHostOf(measured, undefined)).toBe("example.org");
  });

  it("counts a repeated address once and treats an unparseable one as private", () => {
    const measured = { ...clean, urls: ["https://example.org/x?p=1", "https://example.org/x?p=1"], urls_total: 2, pages: [] };
    expect(shouldNotBeListed(measured, undefined)).toHaveLength(1);
    expect(reasonFromAddress("not a url", "example.org", undefined)).toBe("private_pattern");
    expect(reasonFromAddress("https://example.org/wp-json/x", "example.org", undefined)).toBe("private_pattern");
    expect(reasonFromAddress("https://example.org/wp-administrator", "example.org", undefined)).toBeUndefined();
    expect(reasonFromAddress("https://example.org/?s=cats", "example.org", undefined)).toBe("private_pattern");
  });

  it("judges a page by status first (0 and 5xx are dead), then redirect, noindex, canonical", () => {
    const page = (extra: object) => ({ url: "https://example.org/a", status: 200, noindex: false, ...extra });
    expect(reasonFromPage(page({ status: 0 }))).toBe("404");
    expect(reasonFromPage(page({ status: 503 }))).toBe("404");
    expect(reasonFromPage(page({ status: 302, noindex: true }))).toBe("redirect");
    expect(reasonFromPage(page({ noindex: true }))).toBe("noindex");
    expect(reasonFromPage(page({ canonical: "/a/" }))).toBeUndefined();
    expect(reasonFromPage(page({ canonical: "https://example.org/b" }))).toBe("duplicate_canonical");
    expect(reasonFromPage(page({ canonical: "" }))).toBeUndefined();
  });

  it("buckets status counts and hints at the site's key pages the sitemap leaves out", () => {
    expect(statusCounts([{ url: "u", status: 0, noindex: false }, { url: "v", status: 599, noindex: false }, { url: "w", status: 700, noindex: false }])).toEqual({
      ...noStatusCounts(),
      "5xx": 1,
      unreachable: 2,
    });
    expect(missingProbePaths({ ...clean, urls: ["https://example.org/"], urls_total: 1 }, SITE)).toBe(1);
    expect(missingProbePaths(clean, SITE)).toBe(0);
    expect(missingProbePaths(clean, undefined)).toBeUndefined();
  });

  it("raises one finding per reason, and coverage findings for an empty, sampled or incomplete sitemap", () => {
    expect(listingFindings(shouldNotBeListed(messy, SITE)).map((finding) => finding.id)).toEqual([
      "sitemap.noindex_listed",
      "sitemap.error_status_listed",
      "sitemap.redirect_listed",
      "sitemap.private_listed",
      "sitemap.other_host_listed",
      "sitemap.duplicate_canonical_listed",
    ]);
    const empty = { ...clean, urls_total: 0, urls: [], pages: [] };
    expect(coverageFindings(empty, 0, undefined).map((finding) => finding.id)).toEqual(["sitemap.empty"]);
    expect(coverageFindings(messy, 5, 2).map((finding) => `${finding.id} ${finding.severity}`)).toEqual([
      "sitemap.sampled info",
      "sitemap.probe_paths_missing low",
    ]);
  });
});

/** A fake web: each address answers from the table; an address that is absent cannot be reached. */
class FakeWeb {
  readonly requests: { url: string; follow: boolean | undefined }[] = [];
  constructor(private readonly pages: Record<string, Partial<PageResponse> | Error>) {}
  readonly getPage: GetPage = async (url: string, options?: GetPageOptions) => {
    options?.signal?.throwIfAborted();
    this.requests.push({ url, follow: options?.follow });
    const page = this.pages[url];
    if (page === undefined) throw new Error(`no route to ${url}`);
    if (page instanceof Error) throw page;
    return { status: 200, xRobotsTag: "", contentType: "application/xml", body: "", ...page };
  };
}

const urlset = (...urls: string[]) => `<?xml version="1.0"?><urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
const index = (...urls: string[]) => `<sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;
const html = (head: string) => ({ contentType: "text/html; charset=UTF-8", body: `<html><head>${head}</head><body></body></html>` });

const messyWeb = (): FakeWeb =>
  new FakeWeb({
    "https://example.org/robots.txt": { contentType: "text/plain", body: "User-agent: *\nSitemap: https://example.org/wp-sitemap.xml\n" },
    "https://example.org/wp-sitemap.xml": { body: index("https://example.org/wp-sitemap-posts.xml", "https://example.org/wp-sitemap-pages.xml") },
    "https://example.org/wp-sitemap-posts.xml": { body: urlset("https://example.org/", "https://example.org/gone", "https://example.org/old", "https://example.org/hidden") },
    "https://example.org/wp-sitemap-pages.xml": {
      body: urlset("https://example.org/copy", "https://example.org/wp-admin/options.php", "https://staging.example.org/", "https://example.org/?p=12", "https://example.org/"),
    },
    "https://example.org/": html('<link rel="canonical" href="https://example.org/">'),
    "https://example.org/gone": { status: 404, contentType: "text/html", body: "gone" },
    "https://example.org/old": { status: 301, location: "https://example.org/", contentType: "text/html" },
    "https://example.org/hidden": html('<meta name="robots" content="noindex, follow">'),
    "https://example.org/copy": html('<link rel="canonical" href="https://example.org/">'),
    "https://example.org/wp-admin/options.php": { status: 302, location: "https://example.org/wp-login.php" },
    "https://staging.example.org/": new Error("ECONNREFUSED"),
    "https://example.org/?p=12": { ...html(""), xRobotsTag: "noindex" },
  });

describe("reading the live sitemap", () => {
  it("finds the sitemap from robots.txt, follows the index, de-duplicates, and samples pages without following redirects", async () => {
    const web = messyWeb();
    const measured = await measureSitemap({ siteUrl: "https://example.org", maxPages: 60 }, web.getPage);
    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    expect(measured).toMatchObject({ sitemap_url: SITEMAP_URL, files_read: 3, urls_total: 8 });
    expect(measured.urls).toEqual(messy.urls);
    expect(measured.pages.find((page) => page.url.endsWith("/old"))).toEqual({
      url: "https://example.org/old",
      status: 301,
      location: "https://example.org/",
      noindex: false,
    });
    expect(measured.pages.find((page) => page.url.endsWith("/hidden"))?.noindex).toBe(true);
    expect(measured.pages.find((page) => page.url.endsWith("/?p=12"))?.noindex).toBe(true);
    expect(measured.pages.find((page) => page.url.endsWith("/copy"))?.canonical).toBe("https://example.org/");
    expect(measured.pages.find((page) => page.url.startsWith("https://staging"))).toEqual({ url: "https://staging.example.org/", status: 0, noindex: false });
    // sitemap files are read following redirects; sampled pages are not
    const pageRequests = web.requests.filter((request) => !request.url.includes("sitemap") && !request.url.endsWith("robots.txt"));
    expect(pageRequests.every((request) => request.follow === false)).toBe(true);
    expect(shouldNotBeListed(measured, SITE).map((entry) => entry.reason)).toEqual(shouldNotBeListed(messy, SITE).map((entry) => entry.reason));
  });

  it("falls back to the usual WordPress locations and stops at the first sitemap that lists pages", async () => {
    const web = new FakeWeb({
      "https://example.org/robots.txt": { status: 404 },
      "https://example.org/wp-sitemap.xml": { status: 404 },
      "https://example.org/sitemap_index.xml": { body: urlset("https://example.org/a") },
      "https://example.org/sitemap.xml": { body: urlset("https://example.org/never") },
      "https://example.org/a": html(""),
    });
    const measured = await measureSitemap({ siteUrl: "https://example.org", maxPages: 60 }, web.getPage);
    expect(measured).toMatchObject({ status: "measured", sitemap_url: "https://example.org/sitemap_index.xml", urls: ["https://example.org/a"] });
    expect(web.requests.map((request) => request.url)).not.toContain("https://example.org/sitemap.xml");
  });

  it("reports unmeasured, with the places it tried, when nothing answers; a sitemap that is not XML does not count", async () => {
    const web = new FakeWeb({ "https://example.org/sitemap.xml": { body: "<html>not a sitemap</html>" } });
    const measured = await measureSitemap({ siteUrl: "https://example.org", maxPages: 60 }, web.getPage);
    expect(measured).toEqual({
      status: "unmeasured",
      reason: "no sitemap answered at https://example.org/wp-sitemap.xml, https://example.org/sitemap_index.xml, https://example.org/sitemap.xml",
    });
  });

  it("reads an explicit sitemap address as the only start, and caps the files read at 50", async () => {
    const children = Array.from({ length: 60 }, (_, i) => `https://example.org/s${i}.xml`);
    const pages: Record<string, Partial<PageResponse>> = { "https://example.org/all.xml": { body: index(...children) } };
    for (const child of children) pages[child] = { body: urlset(`${child}/page`) };
    const web = new FakeWeb(pages);
    const measured = await measureSitemap({ sitemapUrl: "https://example.org/all.xml", maxPages: 0 }, web.getPage);
    expect(measured).toMatchObject({ status: "measured", files_read: 50, urls_total: 49 });
    expect(web.requests).toHaveLength(50);
  });

  it("stops when cancelled instead of reporting the sitemap unmeasured", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(measureSitemap({ siteUrl: "https://example.org", maxPages: 60 }, messyWeb().getPage, controller.signal)).rejects.toThrow();
  });

  it("parses indexes, urlsets, CDATA and entities, and ignores anything else", () => {
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://a/x.xml</loc></sitemap></sitemapindex>")).toEqual({ kind: "index", locs: ["https://a/x.xml"] });
    expect(parseSitemap("<urlset><url><loc><![CDATA[https://a/?x=1&amp;y=2]]></loc></url></urlset>")).toEqual({ kind: "urlset", locs: ["https://a/?x=1&y=2"] });
    expect(parseSitemap("<html><loc>x</loc></html>")).toEqual({ kind: "unknown", locs: [] });
  });

  it("reads the robots meta and canonical link of a page, and spreads a sample evenly", () => {
    expect(extractMeta('<meta property="robots" content="NOINDEX"><link rel="canonical" href="/x">')).toEqual({ robots: "NOINDEX", canonical: "/x" });
    expect(extractMeta("<p>nothing</p>")).toEqual({ robots: "", canonical: "" });
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([1, 3, 5, 7, 9]);
    expect(spread([1, 2], 5)).toEqual([1, 2]);
  });
});

/** A scripted model: answers the judgement prompt from the findings it quotes. */
class FakeModel {
  readonly prompts: string[] = [];
  constructor(private readonly answer: (ids: string[], prompt: string, call: number) => unknown) {}
  readonly step = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    this.prompts.push(prompt);
    const ids = [...(prompt.split("Findings:\n")[1] ?? "").split("\nRespond as JSON")[0]!.matchAll(/^- (sitemap\.\S+):/gm)].map((match) => match[1]!);
    const reply = this.answer(ids, prompt, this.prompts.length);
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
}
const verdicts = (real: number, severity: "high" | "medium" | "low") => (ids: string[]) => ({
  Judgement: ids.map((id) => ({ id, real_probability: real, severity, confidence: 0.8 })),
});

let sites: string;
beforeAll(() => {
  sites = mkdtempSync(join(tmpdir(), "sitemap-sites-"));
  writeFileSync(
    join(sites, "example.yaml"),
    "url: https://example.org\nplatform: wordpress\ntier: client\nprobes:\n  paths:\n    - /\n    - /summit\nflows:\n  login_path: /login\nsitemap:\n  disallow:\n    - /tag\n",
  );
});
afterAll(() => rmSync(sites, { recursive: true, force: true }));

describe("runSitemap", () => {
  it("raises one finding per reason, judged in one model call, and notes the sample", async () => {
    const model = new FakeModel(verdicts(0.9, "high"));
    const out = await runSitemap({ site_url: "https://example.org" }, { model: model.step, getPage: messyWeb().getPage, sitesDirectory: sites });
    expect(out.findings.map((finding) => finding.id)).toEqual([
      "sitemap.noindex_listed",
      "sitemap.error_status_listed",
      "sitemap.redirect_listed",
      "sitemap.private_listed",
      "sitemap.other_host_listed",
      "sitemap.duplicate_canonical_listed",
    ]);
    expect(out.findings.every((finding) => finding.severity === "high" && finding.confidence === 0.8)).toBe(true);
    expect(out).toMatchObject({ sitemap_url: SITEMAP_URL, urls_total: 8, urls_checked: 8, truncated: false });
    expect(out.by_status).toEqual({ "200": 4, "3xx": 2, "4xx": 1, "5xx": 0, unreachable: 1 });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("Site: unknown site");
  });

  it("drops a finding the model does not confirm to info, and keeps a coverage finding as the rules made it", async () => {
    const model = new FakeModel(verdicts(0.2, "high"));
    const out = await runSitemap({ site_url: "https://example.org", site: "example" }, { model: model.step, getPage: messyWeb().getPage, sitesDirectory: sites });
    expect(out.findings.filter((finding) => finding.id !== "sitemap.probe_paths_missing").every((finding) => finding.severity === "info")).toBe(true);
    expect(model.prompts[0]).toContain("Site: example, client tier, wordpress");
  });

  it("stands the site's own address in for a missing one, and applies its private paths", async () => {
    const web = new FakeWeb({
      "https://example.org/robots.txt": { status: 404 },
      "https://example.org/wp-sitemap.xml": { body: urlset("https://example.org/", "https://example.org/login", "https://example.org/tag/jazz") },
      "https://example.org/": html(""),
      "https://example.org/login": html(""),
      "https://example.org/tag/jazz": html(""),
    });
    const model = new FakeModel(verdicts(0.9, "medium"));
    const out = await runSitemap({ site: "example" }, { model: model.step, getPage: web.getPage, sitesDirectory: sites });
    expect(out.should_not_be_listed.map((entry) => entry.url)).toEqual(["https://example.org/login", "https://example.org/tag/jazz"]);
    expect(out.missing_from_sitemap_hint).toBe(1);
    expect(out.findings.map((finding) => finding.id)).toEqual(["sitemap.private_listed", "sitemap.probe_paths_missing"]);
  });

  it("finds nothing wrong with a clean sitemap and asks no model", async () => {
    const web = new FakeWeb({
      "https://example.org/robots.txt": { status: 404 },
      "https://example.org/wp-sitemap.xml": { body: urlset("https://example.org/", "https://example.org/summit") },
      "https://example.org/": html(""),
      "https://example.org/summit": html(""),
    });
    const model = new FakeModel(() => {
      throw new Error("no model call expected");
    });
    const out = await runSitemap({ site_url: "https://example.org", site: "example" }, { model: model.step, getPage: web.getPage, sitesDirectory: sites });
    expect(out).toMatchObject({ urls_total: 2, urls_checked: 2, truncated: false, should_not_be_listed: [], findings: [] });
    expect(model.prompts).toHaveLength(0);
  });

  it("flags an empty sitemap without asking the model", async () => {
    const web = new FakeWeb({ "https://example.org/sitemap.xml": { body: urlset() }, "https://example.org/robots.txt": { status: 404 } });
    const model = new FakeModel(verdicts(1, "high"));
    const out = await runSitemap({ sitemap_url: "https://example.org/sitemap.xml" }, { model: model.step, getPage: web.getPage });
    expect(out.findings.map((finding) => finding.id)).toEqual(["sitemap.empty"]);
    expect(model.prompts).toHaveLength(0);
  });

  it("returns unmeasured with the reason, never an empty clean sitemap, when no sitemap answered", async () => {
    const web = new FakeWeb({});
    const out = await runSitemap({ site_url: "https://example.org" }, { model: new FakeModel(verdicts(1, "high")).step, getPage: web.getPage });
    expect(out).toMatchObject({ sitemap_url: "https://example.org/", urls_total: 0, findings: [] });
    expect(out.unmeasured).toContain("no sitemap answered at");
  });

  it("keeps the rule severities and says so when the model never gives a valid reply", async () => {
    const model = new FakeModel(() => "not json at all");
    const out = await runSitemap({ site_url: "https://example.org" }, { model: model.step, getPage: messyWeb().getPage });
    expect(model.prompts).toHaveLength(3);
    expect(out.judgment_unavailable).toContain("no valid reply after 3 attempts");
    expect(out.findings.map((finding) => finding.severity)).toEqual(["medium", "high", "medium", "high", "high", "medium"]);
  });

  it("asks again with the reason when the reply names the findings in the wrong order, then accepts the corrected one", async () => {
    const model = new FakeModel((ids, _prompt, call) => verdicts(0.9, "low")(call === 1 ? [...ids].reverse() : ids));
    const out = await runSitemap({ site_url: "https://example.org" }, { model: model.step, getPage: messyWeb().getPage });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("expected \"sitemap.noindex_listed\"");
    expect(out.findings.every((finding) => finding.severity === "low")).toBe(true);
    expect(out.judgment_unavailable).toBeUndefined();
  });

  it("needs an address, and reads only web addresses", async () => {
    const model = new FakeModel(verdicts(1, "high"));
    await expect(runSitemap({}, { model: model.step })).rejects.toThrow(/give site_url, sitemap_url or a site/);
    await expect(runSitemap({ sitemap_url: "file:///etc/passwd" }, { model: model.step })).rejects.toThrow(/only http and https/);
    await expect(runSitemap({ site_url: "example.org" }, { model: model.step })).rejects.toThrow(/not a web address/);
    await expect(runSitemap({ site: "../x" }, { model: model.step, sitesDirectory: sites })).rejects.toThrow(/not a site file name/);
    await expect(runSitemap({ site: "nope" }, { model: model.step, sitesDirectory: sites })).rejects.toThrow(/no site file/);
    expect(checkedAddress("https://a.test/x.xml", "f")).toBe("https://a.test/x.xml");
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSitemap({ site_url: "https://example.org" }, { model: new FakeModel(verdicts(1, "high")).step, getPage: messyWeb().getPage, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("the judgement prompt and reply", () => {
  const finding = (id: string): Finding => ({ id, area: "sitemap", severity: "medium", evidence: `${id} evidence`, fix_hint: "fix" });

  it("quotes both questions with their criteria, the site and every finding", () => {
    const prompt = judgementPrompt([finding("sitemap.a"), finding("sitemap.b")], SITEMAP_URL, "example, client tier");
    expect(prompt).toContain("Real: A deterministic check of one XML sitemap");
    expect(prompt).toContain("- false: The listing is intentional or harmless for this site.");
    expect(prompt).toContain("- high: Search wastes crawl budget");
    expect(prompt).toContain(`Sitemap: ${SITEMAP_URL}\nSite: example, client tier`);
    expect(prompt).toContain("- sitemap.a: sitemap.a evidence\n- sitemap.b: sitemap.b evidence");
    expect(prompt).toContain("Respond as JSON matching this schema:");
  });

  it("refuses a reply with the wrong count, id, severity or probability", () => {
    const findings = [finding("sitemap.a")];
    const ok = { Judgement: [{ id: "sitemap.a", real_probability: 0.5, severity: "low", confidence: 1 }] };
    expect(parseJudgements(ok, findings)[0]).toMatchObject({ severity: "low" });
    const bad = (patch: object) => () => parseJudgements({ Judgement: [{ ...ok.Judgement[0], ...patch }] }, findings);
    expect(bad({ severity: "info" })).toThrow(/severity/);
    expect(bad({ real_probability: 1.5 })).toThrow(/real_probability/);
    expect(bad({ confidence: "high" })).toThrow(/confidence/);
    expect(bad({ id: "sitemap.z" })).toThrow(/expected "sitemap.a"/);
    expect(() => parseJudgements({ Judgement: [] }, findings)).toThrow(/expected 1 elements/);
    expect(() => parseJudgements([], findings)).toThrow(/Judgement/);
  });

  it("judges at most the first dozen findings; the rest keep the rule's severity", async () => {
    const { judgeFindings } = await import("./judge.ts");
    const many = Array.from({ length: MAX_JUDGED_FINDINGS + 2 }, (_, i) => finding(`sitemap.f${i}`));
    const seen: string[] = [];
    const model = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^- (sitemap\.f\d+):/gm)].map((match) => match[1]!);
      seen.push(...ids);
      return JSON.stringify({ Judgement: ids.map((id) => ({ id, real_probability: 1, severity: "high", confidence: 1 })) });
    };
    const out = await judgeFindings(many, { subject: SITEMAP_URL, site: "x" }, model);
    expect(seen).toHaveLength(MAX_JUDGED_FINDINGS);
    expect(out.slice(0, MAX_JUDGED_FINDINGS).every((each) => each.severity === "high")).toBe(true);
    expect(out.slice(MAX_JUDGED_FINDINGS).every((each) => each.severity === "medium")).toBe(true);
  });
});

describe("the tool", () => {
  it("runs the check and returns it as JSON text and as details; null optionals mean omitted", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
      model: new FakeModel(verdicts(0.9, "high")).step,
      getPage: messyWeb().getPage,
      sitesDirectory: sites,
    });
    const out = await tool.execute("id", { site_url: "https://example.org", sitemap_url: null, site: null }, undefined as never, undefined);
    expect(out.details.urls_total).toBe(8);
    expect(JSON.parse(out.content[0]!.text).findings).toHaveLength(6);
    await expect(tool.execute("id", { site_url: null, sitemap_url: null, site: null }, undefined as never, undefined)).rejects.toThrow(/give site_url/);
  });

  it("is one dense block of 80-250 words naming the inputs, limits, cost and the unmeasured boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("never edits");
    expect(DESCRIPTION).toContain("`unmeasured`");
    expect(DESCRIPTION).toContain("billed");
  });
});
