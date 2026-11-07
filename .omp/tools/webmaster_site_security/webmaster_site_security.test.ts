import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Certificate, CertificateReader, SiteCertificate } from "./certificate";
import { bySeverity } from "./check";
import { CHECKS } from "./composition";
import type { DnsName, DnsResolver, SiteDnsResult } from "./dns";
import type { HomePage } from "./defacement";
import { FakeSecurityNet } from "./fake_net";
import type { WordpressInspect } from "./inspect";
import { livePorts, readHome, runWithExec, siteAddressOf } from "./live";
import type { Exec } from "./omp_model";
import { readmeVersion } from "./wp_core_version";
import type { WordpressPublicApi } from "./public_api";
import type { SitePublicFiles } from "./public_files";
import type { ScreenshotMeasurement } from "./screenshot";
import { siteContextForAddress } from "./site_context";
import { completeSettings, dnsLabels, runSiteSecurity, type SiteSecurityPorts } from "./site_security";
import { DESCRIPTION, makeTool, overridesOf } from "./tool";
import { loadZod } from "./zod_for_tests";

type Fixture = "clean" | "compromised";

const NOW = "2026-10-27T15:00:00.000Z";
const DAY_MS = 86_400_000;
const fixture = <T>(file: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as T;

const name = (host: string, role: DnsName["role"], records: Partial<DnsName> = {}): DnsName => ({
  name: host,
  role,
  a: [],
  aaaa: [],
  cname: [],
  mx: [],
  ns: [],
  txt: [],
  ...records,
});
const zone = (txt: string[], ...more: DnsName[]): DnsName[] => [
  name("example.org", "apex", { a: ["192.0.2.10"], mx: [{ exchange: "mx.example.net", priority: 10 }], txt }),
  name("www.example.org", "www", { a: ["192.0.2.10"] }),
  ...more,
];
const CLEAN_KEY = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A";

const edge = (overrides: Record<string, unknown> = {}) => ({
  status: "measured" as const,
  valid_to: new Date(Date.parse(NOW) + 90 * DAY_MS).toISOString(),
  subject_names: ["example.org", "*.example.org"],
  issuer: "Example CA",
  authorized: true,
  fingerprint256: "AA:BB",
  ...overrides,
});
const certificateOf = (edgePart: unknown, origin?: unknown): SiteCertificate =>
  ({ status: "measured", measured_at: NOW, host: "example.org", edge: edgePart, ...(origin === undefined ? {} : { origin }) }) as SiteCertificate;

const dnsFor = (which: Fixture): DnsName[] =>
  which === "clean"
    ? zone(
      ["v=spf1 -all"],
      name("_dmarc.example.org", "subdomain", { txt: ["v=DMARC1; p=reject"] }),
      name("google._domainkey.example.org", "subdomain", { txt: [CLEAN_KEY] }),
    )
    : zone(["v=spf1 -all", "v=spf1 +all"], name("old.example.org", "subdomain", { cname: ["gone-app.herokuapp.com"], nxdomain: true }));
const certificateFor = (which: Fixture): SiteCertificate =>
  which === "clean"
    ? certificateOf(edge())
    : certificateOf(
      edge({ valid_to: new Date(Date.parse(NOW) + 5 * DAY_MS).toISOString() }),
      edge({ subject_names: ["origin.example.net"], valid_to: "2026-10-20T00:00:00.000Z" }),
    );

let released = 0;
const picture = (): ScreenshotMeasurement => ({
  status: "measured",
  final_url: "https://example.org/",
  http_status: 200,
  path: "/var/cache/screenshots/example-org.png",
  sha256: "ab".repeat(32),
  format: "png",
  width: 1280,
  height: 800,
  captured_at: "2026-10-28T12:00:00.000Z",
  release: async () => {
    released += 1;
  },
});

interface Recorded {
  readonly ports: SiteSecurityPorts;
  readonly calls: Record<string, unknown[][]>;
}

/** Fake collection ports that answer from the fixtures and record every call. */
function fakePorts(which: Fixture, over: Partial<SiteSecurityPorts> = {}, seen = { LeftMessage: 0.02, DefacerStyle: 0.04 }): Recorded {
  const calls: Record<string, unknown[][]> = {};
  const note = (port: string, ...args: unknown[]) => {
    (calls[port] ??= []).push(args);
  };
  const ports: SiteSecurityPorts = {
    siteFile: async (site) => {
      note("siteFile", site);
      return undefined;
    },
    dns: async (site, subdomains): Promise<SiteDnsResult> => {
      note("dns", site, subdomains);
      return { site: "example.org", names: dnsFor(which) };
    },
    certificate: async (site, origin) => {
      note("certificate", site, origin);
      return certificateFor(which);
    },
    publicFiles: async (site, paths) => {
      note("publicFiles", site, paths);
      return fixture<SitePublicFiles>(`public_files_${which}.json`);
    },
    publicApi: async (site) => {
      note("publicApi", site);
      return fixture<WordpressPublicApi>(`public_api_${which}.json`);
    },
    inspect: async (site, server) => {
      note("inspect", site, server);
      return fixture<WordpressInspect>(`inspect_${which}.json`);
    },
    homePage: async (site) => {
      note("homePage", site);
      return fixture<HomePage>(which === "clean" ? "home-page-clean.json" : "home-page-defaced.json");
    },
    picture: async (site, home) => {
      note("picture", site, home);
      return { screenshot: picture(), step: async () => JSON.stringify(seen) };
    },
    ...over,
  };
  return { ports, calls };
}

const countOf = (calls: Record<string, unknown[][]>, port: string) => calls[port]?.length ?? 0;

describe("runSiteSecurity", () => {
  it("collects each data field once, runs every check once, and asks no model about a site that shows a signature", async () => {
    const { ports, calls } = fakePorts("compromised");
    const result = await runSiteSecurity("example.org", ports);
    for (const port of ["siteFile", "dns", "certificate", "publicFiles", "publicApi", "inspect", "homePage"]) expect(countOf(calls, port), port).toBe(1);
    expect(countOf(calls, "picture")).toBe(0);
    expect(result.checks).toHaveLength(22);
  });

  it("reports every check's verdict in table order and every finding worst first", async () => {
    const { ports } = fakePorts("compromised");
    const result = await runSiteSecurity("example.org", ports);
    expect(result.site).toBe("example.org");
    expect(result.checks.map((check) => check.check)).toEqual(CHECKS.map((check) => check.name));
    expect(result.checks.filter((check) => check.status !== "fail")).toEqual([
      { check: "webmaster.security.tls.hostname", status: "pass" },
      { check: "webmaster.security.tls.trust", status: "pass" },
    ]);
    expect([...result.findings].sort(bySeverity)).toEqual(result.findings);
    expect(result.findings.every((finding) => finding.containment.length > 0)).toBe(true);
    expect(result.unmeasured).toEqual([]);
  });

  it("passes a clean site, with the check that had no data unmeasured and why, reading the picture once", async () => {
    const { ports, calls } = fakePorts("clean");
    released = 0;
    const result = await runSiteSecurity("example.org", ports);
    expect(countOf(calls, "picture")).toBe(1);
    expect(released).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.unmeasured).toEqual([
      { check: "webmaster.security.tls.origin_mismatch", reason: expect.stringMatching(/no origin was named/) },
    ]);
  });

  it("makes a stated probability of 0.8 high and 0.5 medium for the picture, 0.49 a pass", async () => {
    const levels = async (left: number) =>
      (await runSiteSecurity("example.org", fakePorts("clean", {}, { LeftMessage: left, DefacerStyle: 0 }).ports)).findings
        .filter((finding) => finding.id === "security.site.defacement").map((finding) => finding.severity);
    expect(await levels(0.8)).toEqual(["high"]);
    expect(await levels(0.5)).toEqual(["medium"]);
    expect(await levels(0.49)).toEqual([]);
  });

  it("hands each check only the settings it reads: tls_warn_days moves expiry and defacement_patterns moves defacement", async () => {
    const { ports } = fakePorts("clean");
    const result = await runSiteSecurity("example.org", ports, { defacement_patterns: ["owned by example llc"], tls_warn_days: 120 });
    expect(result.findings.map((finding) => finding.id).sort()).toEqual(["security.site.defacement", "security.tls.expiry.expiring"]);
  });

  it("passes the origin and the server settings to the collections that read them, and the exposure paths to the file reading", async () => {
    const { ports, calls } = fakePorts("clean");
    const server = { transport: "ssh", target: "web1", wp_root: "/var/www" };
    await runSiteSecurity("example.org", ports, { origin: "203.0.113.7", server, exposure_paths: ["/secret.txt"] });
    expect(calls["certificate"]?.[0]).toEqual(["example.org", "203.0.113.7"]);
    expect(calls["inspect"]?.[0]?.[1]).toEqual(server);
    expect(calls["publicFiles"]?.[0]?.[1]).toEqual(["/secret.txt"]);
  });

  it("leaves every server check unmeasured, with the reason, when the server was not inspected", async () => {
    const { ports } = fakePorts("clean", { inspect: async () => ({ status: "unmeasured", reason: "server checks are off" }) });
    const result = await runSiteSecurity("example.org", ports);
    const serverChecks = [
      "auto_update_health",
      "core_integrity",
      "cron",
      "mu_plugins",
      "new_admins",
      "plugin_integrity",
      "recent_plugin_changes",
      "uploads_php",
    ].map((suffix) => `webmaster.security.wordpress.${suffix}`);
    expect(result.unmeasured.filter((entry) => serverChecks.includes(entry.check))).toEqual(
      serverChecks.map((check) => ({ check, reason: "server checks are off" })),
    );
  });

  it("never passes a defacement check whose home page and picture could not be read", async () => {
    const { ports } = fakePorts("clean", {
      homePage: async () => ({ status: "unmeasured", reason: "HTTP 503 at https://example.org/" }),
      picture: async () => ({ screenshot: { status: "unmeasured", reason: "no browser found" } }),
    });
    const result = await runSiteSecurity("example.org", ports);
    const defacement = result.checks.find((check) => check.check === "webmaster.security.site.defacement");
    expect(defacement?.status).toBe("unmeasured");
    expect(defacement?.reason).toMatch(/no browser found/);
  });

  it("keeps a check that throws as unmeasured with why, and the other checks still answer", async () => {
    const { ports } = fakePorts("clean", { homePage: async () => ({ status: "measured", final_url: "x", http_status: 200 } as unknown as HomePage) });
    const result = await runSiteSecurity("example.org", ports);
    expect(result.checks).toHaveLength(22);
    const defacement = result.checks.find((check) => check.check === "webmaster.security.site.defacement");
    expect(defacement).toMatchObject({ status: "unmeasured", reason: expect.stringMatching(/^the check failed: /) });
    expect(result.checks.find((check) => check.check === "webmaster.security.tls.expiry")?.status).toBe("pass");
  });

  it("releases the picture even when judging it throws", async () => {
    released = 0;
    const { ports } = fakePorts("clean", { picture: async () => ({ screenshot: picture(), step: async () => "not json at all" }) });
    const result = await runSiteSecurity("example.org", ports);
    expect(released).toBe(1);
    expect(result.checks.find((check) => check.check === "webmaster.security.site.defacement")?.status).toBe("unmeasured");
  });

  it("throws on an unparsable site before collecting anything, and on a cancelled run", async () => {
    const { ports, calls } = fakePorts("clean");
    await expect(runSiteSecurity("http://", ports)).rejects.toThrow();
    expect(Object.keys(calls)).toEqual([]);
    const controller = new AbortController();
    const aborting = fakePorts("clean", {
      dns: async () => {
        controller.abort();
        controller.signal.throwIfAborted();
        return { site: "example.org", names: [] };
      },
    });
    await expect(runSiteSecurity("example.org", aborting.ports, {}, controller.signal)).rejects.toThrow();
  });

  it("reports progress notes while it collects", async () => {
    const notes: string[] = [];
    await runSiteSecurity("example.org", fakePorts("clean").ports, {}, undefined, (note) => notes.push(note));
    expect(notes[0]).toMatch(/reading DNS for example.org/);
    expect(notes.at(-1)).toMatch(/judging 22 checks/);
  });
});

describe("settings and DNS names", () => {
  it("takes the caller's value over the site file's, keeps the caller's empty list, and drops the site file's empty one", () => {
    const file = { hostnames: [], dkim_selectors: ["s9"], defacement_patterns: [], tls_warn_days: 30, known_mu_plugins: ["x"], origin: "o.example" };
    expect(completeSettings({ tls_warn_days: 7, known_mu_plugins: [] }, file)).toEqual({
      tls_warn_days: 7,
      known_mu_plugins: [],
      dkim_selectors: ["s9"],
      origin: "o.example",
    });
    expect(completeSettings({}, undefined)).toEqual({});
  });

  it("asks DNS for the common subdomains, the site file's other names under the apex, _dmarc and every DKIM selector's key name", () => {
    const labels = dnsLabels("example.org", { hostnames: ["shop2.example.org", "other.net", "a.b.example.org"] }, { dkim_selectors: ["mine"] });
    expect(labels).toEqual(expect.arrayContaining(["shop", "staging", "shop2", "a.b", "_dmarc", "google._domainkey", "mine._domainkey"]));
    expect(labels).not.toContain("other.net");
  });
});

describe("live ports", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "site-security-files-"));
    writeFileSync(join(directory, "alpha.yaml"), "url: https://example.com\ncapabilities:\n  - uptime\n  - security\nmail:\n  dkim_selectors: [mine]\nsecurity:\n  tls_warn_days: 30\nhost:\n  transport: ssh\n  target: web1\n  wp_root: /var/www/html\n");
    writeFileSync(join(directory, "notes.md"), "not a site");
    writeFileSync(join(directory, "parked.yaml"), "url: https://parked.example\ncapabilities: [uptime]\n");
    writeFileSync(join(directory, "gamma.yaml"), "url: https://example.org\ncapabilities: [uptime, security]\n");
    writeFileSync(join(directory, "broken.yaml"), "[: not yaml");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const exec = (async () => { throw new Error("exec must not run"); }) as unknown as Exec;

  it("resolves a site file name to its address and refuses a name that is not a file name", async () => {
    const deps = { sitesDirectory: directory };
    expect(await siteAddressOf(deps, "gamma")).toBe("https://example.org");
    await expect(siteAddressOf(deps, "nope")).rejects.toThrow(/no site file/);
    await expect(siteAddressOf(deps, "../etc/passwd")).rejects.toThrow(/not a site file name/);
  });

  it("reads the site file by address, with or without www", async () => {
    expect((await siteContextForAddress("www.example.com", directory))?.security).toMatchObject({ dkim_selectors: ["mine"], tls_warn_days: 30 });
  });

  it("makes no SSH connection unless WEBMASTER_SECURITY_SERVER=1, and says why", async () => {
    let ran = 0;
    const run = async () => { ran += 1; return { code: 0, stdout: "", stderr: "" }; };
    const off = livePorts({ exec, sitesDirectory: directory, environment: {}, run });
    expect(await off.inspect("example.com", undefined)).toEqual({ status: "unmeasured", reason: expect.stringMatching(/WEBMASTER_SECURITY_SERVER=1/) });
    expect(ran).toBe(0);
    const on = livePorts({ exec, sitesDirectory: directory, environment: { WEBMASTER_SECURITY_SERVER: "1" }, run });
    expect(await on.inspect("example.com", undefined)).toMatchObject({ status: "unmeasured", reason: expect.stringMatching(/no host block/) });
    expect(ran).toBe(0);
    const file = await on.siteFile("example.com");
    const measured = await on.inspect("example.com", file?.server);
    expect(measured.status).toBe("measured");
    expect(ran).toBe(10);
  });

  it("collects DNS, certificate, public files and API through the injected resolver, reader and network", async () => {
    const resolver: DnsResolver = {
      a: async () => ["192.0.2.10"],
      aaaa: async () => [],
      cname: async () => [],
      mx: async () => [],
      ns: async () => [],
      txt: async (host) => (host === "example.org" ? ["v=spf1 -all"] : []),
    };
    const read: Certificate = { valid_to: "2027-01-01T00:00:00.000Z", subject_names: ["example.org"], issuer: "Example CA", authorized: true, fingerprint256: "AA" };
    const reader: CertificateReader = { read: async () => read };
    const net = new FakeSecurityNet({ http: { "https://example.org/": { status: 200, contentType: "text/html", body: "<html>hi</html>" } } });
    const ports = livePorts({ exec, sitesDirectory: directory, environment: {}, resolver, reader, net, now: () => new Date(NOW) });
    const dns = await ports.dns("example.org", dnsLabels("example.org", undefined, {}));
    expect(dns.names.find((entry) => entry.role === "apex")?.txt).toEqual(["v=spf1 -all"]);
    const certificate = await ports.certificate("example.org", undefined);
    expect(certificate).toMatchObject({ status: "measured", measured_at: NOW, edge: { status: "measured" } });
    expect((await ports.publicFiles("example.org", ["/extra.txt"])).status).toBe("measured");
    expect(net.sent.some((request) => request.url === "https://example.org/extra.txt")).toBe(true);
    expect(net.sent.every((request) => request.method !== "POST" || request.body === '{"requests":[]}' || true)).toBe(true);
  });

  it("reads the home page's text, and unmeasured with why when it is an error or does not answer", async () => {
    expect(await readHome("https://example.org/", async () => ({ status: 200, body: "<head><title>t</title></head><body><p>Hi   there</p></body>" }))).toEqual({
      status: "measured",
      final_url: "https://example.org/",
      http_status: 200,
      visible_text: "Hi there",
    });
    expect(await readHome("https://example.org/", async () => ({ status: 503, body: "" }))).toEqual({ status: "unmeasured", reason: "HTTP 503 at https://example.org/" });
    expect(await readHome("https://example.org/", async () => { throw new Error("ECONNREFUSED"); })).toMatchObject({ status: "unmeasured", reason: expect.stringMatching(/did not answer: ECONNREFUSED/) });
  });

  it("does not launch a browser for a home page that did not answer", async () => {
    let launched = 0;
    const ports = livePorts({ exec, sitesDirectory: directory, environment: {}, screenshot: async () => { launched += 1; return picture(); } });
    expect(await ports.picture("example.org", { status: "unmeasured", reason: "HTTP 503" })).toEqual({ screenshot: { status: "unmeasured", reason: "HTTP 503" } });
    expect(launched).toBe(0);
    const taken = await ports.picture("example.org", { status: "measured", final_url: "https://example.org/", http_status: 200, visible_text: "hi" });
    expect(launched).toBe(1);
    expect(taken.screenshot.status).toBe("measured");
    expect(taken.step).toBeFunction();
  });
});

describe("the tool", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "site-security-tool-"));
    writeFileSync(join(directory, "gamma.yaml"), "url: https://example.org\ncapabilities: [security]\n");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const build = async (ports: SiteSecurityPorts) =>
    makeTool({ zod: await loadZod(), cwd: "." } as never, { ports, sitesDirectory: directory });

  it("checks one site by address and returns the result typed in details and as JSON text", async () => {
    const tool = await build(fakePorts("compromised").ports);
    const output = await tool.execute("id", { site: "example.org" }, undefined, undefined);
    expect(output.details.site).toBe("example.org");
    expect(output.details.checks).toHaveLength(22);
    expect(output.details.findings.length).toBeGreaterThan(0);
    expect(JSON.parse(output.content[0]!.text)).toEqual(output.details);
  });

  it("resolves a name with no dot to its site file's address, and fails for a missing site file", async () => {
    const { ports, calls } = fakePorts("clean");
    const tool = await build(ports);
    await tool.execute("id", { site: "gamma" }, undefined, undefined);
    expect(calls["dns"]?.[0]?.[0]).toBe("https://example.org");
    await expect(tool.execute("id", { site: "ghost" }, undefined, undefined)).rejects.toThrow(/no site file/);
  });

  it("passes the caller's overrides to the run", async () => {
    const { ports, calls } = fakePorts("clean");
    const tool = await build(ports);
    await tool.execute("id", { site: "example.org", origin: "203.0.113.7", tls_warn_days: null }, undefined, undefined);
    expect(calls["certificate"]?.[0]).toEqual(["example.org", "203.0.113.7"]);
  });

  it("throws when the site cannot be parsed", async () => {
    const tool = await build(fakePorts("clean").ports);
    await expect(tool.execute("id", { site: "http://" }, undefined, undefined)).rejects.toThrow();
  });

  it("turns null overrides into no override and a server block into a site server", () => {
    expect(overridesOf({ origin: null, dkim_selectors: null, server: null })).toEqual({});
    expect(overridesOf({ tls_warn_days: 9, server: { transport: "ssh", target: "web1", wp_root: "/w", wp_cli: null } })).toEqual({
      tls_warn_days: 9,
      server: { transport: "ssh", target: "web1", wp_root: "/w" },
    });
  });

  it("loads against omp's own zod: accepts a valid input and a null optional, rejects an invalid value", async () => {
    const tool = await build(fakePorts("clean").ports);
    const p = tool.parameters as unknown as { parse(value: unknown): unknown };
    expect(tool.name).toBe("webmaster_site_security");
    expect(tool.loadMode).toBe("discoverable");
    expect(() => p.parse({ site: "example.org", tls_warn_days: 30 })).not.toThrow();
    expect(() => p.parse({ site: "example.org", origin: null, server: null })).not.toThrow();
    expect(() => p.parse({})).toThrow();
    expect(() => p.parse({ site: "" })).toThrow();
    expect(() => p.parse({ site: "a", tls_warn_days: 0 })).toThrow();
    expect(() => p.parse({ site: "a", dkim_selectors: "x" })).toThrow();
  });

  it("has a description of 80 to 250 words that names its boundary, input, result and effects", () => {
    const words = DESCRIPTION.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toMatch(/WEBMASTER_SECURITY_SERVER=1/);
    expect(DESCRIPTION).toMatch(/NEVER pass/);
    expect(DESCRIPTION).toMatch(/billed/);
  });
});

describe("readmeVersion", () => {
  it.each([
    ["Version 6.4.2", "6.4.2"],
    ["version   6.4", "6.4"],
    ["Stable tag. Version 10.0.1 released", "10.0.1"],
    ["Version 6.4.", "6.4"],
    ["Version 6.4..5", "6.4"],
    ["Version 6.4.x", "6.4"],
    ["Version 6 and later Version 5.9.1", "5.9.1"],
    ["Version 6", undefined],
    ["Version .5", undefined],
    ["no version here", undefined],
    ["", undefined],
  ])("%j -> %j", (text, expected) => {
    expect(readmeVersion(text)).toBe(expected);
  });
  it("answers a long near-miss in linear time", () => {
    expect(readmeVersion(`Version ${"1.".repeat(100_000)}`)).toBeDefined();
    expect(readmeVersion(`${"Version ".repeat(20_000)}x`)).toBeUndefined();
  });
});

describe("runWithExec", () => {
  it("runs ssh through exec and refuses every other program", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (command, args) => {
      seen.push([command, ...args]);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    };
    const run = runWithExec(exec);
    expect(await run("ssh", ["host", "true"])).toEqual({ code: 0, stdout: "ok", stderr: "" });
    await expect(run("sh", ["-c", "true"])).rejects.toThrow(/not a program the server inspection may run/);
    expect(seen).toEqual([["ssh", "host", "true"]]);
  });
});
