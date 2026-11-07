import { describe, expect, it } from "bun:test";
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, type CheckTool, type SecurityCheckResult } from "./check";
import { collectSiteDns, type DnsName, type DnsNameRole } from "./dns_collect";
import factory from "./index";
import { serveDns, type Zone } from "./local_dns";
import { type DnsResolver, NameNotFound, systemResolver } from "./resolver";
import { danglingVerdict, HOSTING_PROVIDERS } from "./rules";
import { DESCRIPTION, makeTool, MAX_EXTRA_SUBDOMAINS, type Params, validLabels } from "./tool";

/** One synthetic hostname's records (example hosts, RFC 5737 addresses); empty unless given. */
const name = (host: string, role: DnsNameRole, records: Partial<DnsName> = {}): DnsName => ({
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
/** The names a collection holds for `example.org`: the apex, www, and any further names. */
const zoneNames = (...more: DnsName[]): DnsName[] => [
  name("example.org", "apex", { a: ["192.0.2.10"], mx: [{ exchange: "mx.example.net", priority: 10 }] }),
  name("www.example.org", "www", { a: ["192.0.2.10"] }),
  ...more,
];
const run = (names: readonly DnsName[] | undefined): SecurityCheckResult =>
  answer("example.org", "c", danglingVerdict("example.org", names));

describe("danglingVerdict", () => {
  it("flags a CNAME whose chain ends at a name that does not exist, naming the service", () => {
    const result = run(zoneNames(
      name("old.example.org", "subdomain", { cname: ["gone-app.herokuapp.com"], nxdomain: true }),
      name("go.example.org", "subdomain", { cname: ["custom-proxy.leadpages.net"], nxdomain: true }),
    ));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.dns.dangling", "high"]]);
    expect(result.findings[0]?.evidence).toContain("old.example.org -> gone-app.herokuapp.com (Heroku; the target does not exist)");
    expect(result.findings[0]?.evidence).toContain("go.example.org -> custom-proxy.leadpages.net (Leadpages;");
  });

  it("passes CNAMEs that end at an address, and names with no CNAME", () => {
    const names = zoneNames(
      name("shop.example.org", "subdomain", { cname: ["edge.example.net"], a: ["198.51.100.7"] }),
      name("v6.example.org", "subdomain", { cname: ["edge6.example.net"], aaaa: ["2001:db8::7"] }),
    );
    expect(run(names)).toMatchObject({ status: "pass", findings: [] });
  });

  it("does not flag a CNAME to a name that exists but holds no address", () => {
    expect(run(zoneNames(name("mail.example.org", "subdomain", { cname: ["inbound.example.net"] })))).toMatchObject({ status: "pass" });
  });

  it("does not judge a name whose lookup failed", () => {
    const names = zoneNames(name("slow.example.org", "subdomain", { cname: ["x.example.net"], nxdomain: true, error: "SERVFAIL" }));
    expect(run(names)).toMatchObject({ status: "pass" });
  });

  it("reports a dangling wildcard record once, not once per guessed name", () => {
    const dangling = { cname: ["gone.herokuapp.com"], nxdomain: true, wildcard: true };
    const evidence = run(zoneNames(
      name("shop.example.org", "subdomain", dangling),
      name("blog.example.org", "subdomain", dangling),
      name("app.example.org", "subdomain", dangling),
    )).findings[0]?.evidence ?? "";
    expect(evidence).toContain("*.example.org -> gone.herokuapp.com");
    expect(evidence).not.toContain("shop.example.org");
  });

  it("is unmeasured, not passing, when no DNS was collected or the apex lookup failed outright", () => {
    expect(run(undefined)).toMatchObject({ status: "unmeasured" });
    expect(run([])).toMatchObject({ status: "unmeasured" });
    expect(run([name("www.example.org", "www", { a: ["192.0.2.1"] })])).toMatchObject({ status: "unmeasured" });
    const dead = [name("example.org", "apex", { error: "A: queryA ETIMEOUT example.org" }), name("www.example.org", "www", { error: "A: queryA ETIMEOUT" })];
    expect(run(dead)).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("ETIMEOUT") });
  });

  it("names a provider only when the target is that provider's, not a lookalike", () => {
    const providerOf = (target: string) => HOSTING_PROVIDERS.find((candidate) => candidate.target.test(target))?.name;
    expect(providerOf("x.vercel-dns.com")).toBe("Vercel");
    expect(providerOf("cname.vercel-dns.com.")).toBe("Vercel");
    expect(providerOf("notfastly.net")).toBeUndefined();
    expect(providerOf("edge.fastly.net")).toBe("Fastly");
    expect(providerOf("xunbouncepages.com")).toBeUndefined();
    expect(providerOf("pages.unbouncepages.com")).toBe("Unbounce");
    expect(providerOf("evilhubspot.net")).toBeUndefined();
    expect(providerOf("sites.hs-sites.com")).toBe("HubSpot");
    expect(providerOf("bucket.s3-website-us-east-1.amazonaws.com")).toBe("Amazon S3");
    expect(providerOf("example.org")).toBeUndefined();
  });
});

type Zone2 = Record<
  string,
  Partial<Record<"a" | "aaaa" | "cname" | "ns" | "txt", string[]>> & {
    mx?: { exchange: string; priority: number }[];
    fail?: string;
    /** The name does not exist: an address lookup rejects with `NameNotFound`. */
    missing?: true;
  }
>;

/** A synthetic zone: every answer comes from this table, never from the network. */
function zoneResolver(zone: Zone2): DnsResolver & { asked: string[] } {
  const asked: string[] = [];
  const answerFor = <T>(host: string, kind: string, pick: (entry: Zone2[string]) => T[] | undefined): Promise<T[]> => {
    asked.push(`${kind} ${host}`);
    const entry = zone[host];
    if (entry?.fail !== undefined) return Promise.reject(new Error(entry.fail));
    return Promise.resolve(entry === undefined ? [] : pick(entry) ?? []);
  };
  return {
    asked,
    a: (host) => zone[host]?.missing === true ? Promise.reject(new NameNotFound(host)) : answerFor(host, "A", (entry) => entry.a),
    aaaa: (host) => zone[host]?.missing === true ? Promise.reject(new NameNotFound(host)) : answerFor(host, "AAAA", (entry) => entry.aaaa),
    cname: (host) => answerFor(host, "CNAME", (entry) => entry.cname),
    mx: (host) => answerFor(host, "MX", (entry) => entry.mx),
    ns: (host) => answerFor(host, "NS", (entry) => entry.ns),
    txt: (host) => answerFor(host, "TXT", (entry) => entry.txt),
  };
}

const ZONE: Zone2 = {
  "example.org": { a: ["203.0.113.10"], mx: [{ exchange: "mail.example.org", priority: 10 }], ns: ["ns1.example.net"], txt: ["v=spf1 -all"] },
  "www.example.org": { cname: ["edge.example.net"] },
  "edge.example.net": { a: ["198.51.100.7"] },
  "staging.example.org": { a: ["203.0.113.24"] },
  "mail.example.org": { a: ["203.0.113.10"] },
  "ns1.example.net": { a: ["198.51.100.53"] },
  "shop.example.org": { fail: "SERVFAIL" },
};

describe("collectSiteDns", () => {
  it("collects the apex, www, found subdomains, MX and NS hosts, following CNAME chains", async () => {
    const dns = await collectSiteDns("https://www.example.org/some/page", zoneResolver(ZONE), { subdomains: ["staging", "shop", "blog"] });
    expect(dns.site).toBe("example.org");
    expect(dns.names.map((entry) => [entry.name, entry.role])).toEqual([
      ["example.org", "apex"],
      ["www.example.org", "www"],
      ["staging.example.org", "subdomain"],
      ["shop.example.org", "subdomain"],
      ["mail.example.org", "mx"],
      ["ns1.example.net", "ns"],
    ]);
    expect(dns.names[0]).toEqual({
      name: "example.org",
      role: "apex",
      a: ["203.0.113.10"],
      aaaa: [],
      cname: [],
      mx: [{ exchange: "mail.example.org", priority: 10 }],
      ns: ["ns1.example.net"],
      txt: ["v=spf1 -all"],
    });
    expect(dns.names[1]).toMatchObject({ cname: ["edge.example.net"], a: ["198.51.100.7"] });
    // A failed lookup is kept, with its error, so a reader can tell "no answer" from "no record".
    expect(dns.names[3]).toMatchObject({ name: "shop.example.org", error: expect.stringContaining("SERVFAIL") });
    // A candidate subdomain with no records at all was not found, so it is not listed.
    expect(dns.names.some((entry) => entry.name === "blog.example.org")).toBe(false);
  });

  it("marks the subdomains a wildcard record answers, and keeps the ones with their own address", async () => {
    const resolver = zoneResolver({
      "example.com": { a: ["203.0.113.5"] },
      "zz-probe.example.com": { a: ["203.0.113.5"] },
      "shop.example.com": { a: ["203.0.113.5"] },
      "staging.example.com": { a: ["203.0.113.99"] },
    });
    const dns = await collectSiteDns("example.com", resolver, { subdomains: ["shop", "staging"], wildcardLabel: "zz-probe" });
    expect(dns.wildcard).toEqual({ a: ["203.0.113.5"], aaaa: [], cname: [] });
    expect(dns.names.find((entry) => entry.name === "shop.example.com")?.wildcard).toBe(true);
    expect(dns.names.find((entry) => entry.name === "staging.example.com")?.wildcard).toBeUndefined();
    expect(dns.names.some((entry) => entry.name === "zz-probe.example.com")).toBe(false); // the probe is never a host
  });

  it("reports no wildcard when a made-up label does not answer", async () => {
    const dns = await collectSiteDns("example.org", zoneResolver(ZONE), { subdomains: ["staging"] });
    expect(dns.wildcard).toBeUndefined();
  });

  it("tells a CNAME to a name that does not exist from a CNAME to a name with no address", async () => {
    const resolver = zoneResolver({
      "example.com": { a: ["203.0.113.5"] },
      "gone.example.com": { cname: ["old.example.net"] },
      "old.example.net": { missing: true },
      "mail.example.com": { cname: ["inbound.example.net"] },
      "inbound.example.net": {},
    });
    const dns = await collectSiteDns("example.com", resolver, { subdomains: ["gone", "mail"] });
    expect(dns.names.find((entry) => entry.name === "gone.example.com")).toMatchObject({ nxdomain: true });
    expect(dns.names.find((entry) => entry.name === "mail.example.com")?.nxdomain).toBeUndefined();
  });

  it("keeps a CNAME target that answers only TXT, though its address lookup says the name is absent", async () => {
    const resolver = zoneResolver({
      "example.com": { a: ["203.0.113.5"] },
      "s1._domainkey.example.com": { cname: ["s1.domainkey.example.net"], txt: ["k=rsa; t=s; p=KEY"] },
      "s1.domainkey.example.net": { missing: true },
    });
    const dns = await collectSiteDns("example.com", resolver, { subdomains: ["s1._domainkey"] });
    const entry = dns.names.find((candidate) => candidate.name === "s1._domainkey.example.com");
    expect(entry).toMatchObject({ cname: ["s1.domainkey.example.net"], txt: ["k=rsa; t=s; p=KEY"] });
    expect(entry?.nxdomain).toBeUndefined();
  });

  it("looks up no host for a null MX (`0 .`, as example.org publishes), which names none", async () => {
    const resolver = zoneResolver({
      "example.com": { a: ["203.0.113.5"], mx: [{ exchange: "", priority: 0 }] },
    });
    const dns = await collectSiteDns("example.com", resolver, { subdomains: [] });
    expect(dns.names.map((entry) => entry.role)).toEqual(["apex", "www"]);
    expect(resolver.asked.some((query) => query.endsWith(" "))).toBe(false);
  });

  it("stops a CNAME loop instead of following it forever", async () => {
    const resolver = zoneResolver({
      "example.com": {},
      "www.example.com": { cname: ["loop.example.com"] },
      "loop.example.com": { cname: ["www.example.com"] },
    });
    const dns = await collectSiteDns("example.com", resolver, { subdomains: [] });
    expect(dns.names[1]?.cname).toEqual(["loop.example.com", "www.example.com"]);
    expect(dns.names[1]?.error).toMatch(/loop/i);
  });
});

/** A stand-in for omp's `pi.zod`: every builder call returns the same chainable no-op (the real one is load-checked apart). */
const chain: unknown = new Proxy(() => undefined, { get: () => chain, apply: () => chain });
const pi = { zod: chain } as unknown as Pick<CustomToolAPI, "zod">;

type Tool = CheckTool<Params, unknown>;
const toolWith = (resolver: DnsResolver): Tool => makeTool(pi, { resolver: () => resolver, wildcardLabel: "zz-probe" }) as Tool;
const call = (t: Tool, params: Params, signal?: AbortSignal) => t.execute("id", params, undefined, undefined, signal);

describe("webmaster_security_dns_dangling tool", () => {
  it("collects the zone for the apex of a www address and judges it", async () => {
    const resolver = zoneResolver({ ...ZONE, "go.example.org": { cname: ["gone.herokuapp.com"] }, "gone.herokuapp.com": { missing: true } });
    const result = await call(toolWith(resolver), { site: "https://www.example.org/x", subdomains: ["Go"] });
    expect(result.details).toMatchObject({
      site: "example.org",
      check: "webmaster.security.dns.dangling",
      status: "fail",
      findings: [{ id: "security.dns.dangling", severity: "high" }],
    });
    expect(result.details.findings[0]?.evidence).toContain("go.example.org -> gone.herokuapp.com (Heroku;");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    expect(resolver.asked).toContain("CNAME go.example.org");
  });

  it("passes a clean zone, a null subdomain list being none", async () => {
    const result = await call(toolWith(zoneResolver(ZONE)), { site: "example.org", subdomains: null });
    expect(result.details).toMatchObject({ status: "pass", findings: [] });
  });

  it("is unmeasured when every lookup fails", async () => {
    const dead = zoneResolver({ "example.org": { fail: "queryA ETIMEOUT example.org" } });
    expect((await call(toolWith(dead), { site: "example.org" })).details).toMatchObject({ status: "unmeasured" });
  });

  it("accepts DNS labels and rejects the rest before any query", async () => {
    expect(validLabels([" Go ", "help", "_x", "a.b"])).toEqual(["go", "help", "_x", "a.b"]);
    for (const bad of ["", "a b", "-a", "a..b", "x".repeat(64), "é", "a/b"]) {
      expect(() => validLabels([bad]), bad).toThrow(/subdomains must be DNS labels/);
    }
    expect(() => validLabels(Array(MAX_EXTRA_SUBDOMAINS + 1).fill("a"))).toThrow(/at most 50/);
    const resolver = zoneResolver(ZONE);
    await expect(call(toolWith(resolver), { site: "example.org", subdomains: ["a b"] })).rejects.toThrow(/subdomains/);
    expect(resolver.asked).toEqual([]);
  });

  it("fails on an invalid site and on an already-aborted call", async () => {
    await expect(call(toolWith(zoneResolver(ZONE)), { site: "http://" })).rejects.toThrow(/site must be a domain/);
    const controller = new AbortController();
    controller.abort();
    await expect(call(toolWith(zoneResolver(ZONE)), { site: "example.org" }, controller.signal)).rejects.toThrow();
  });
});

describe("the system resolver against a local DNS server (no external network)", () => {
  const zone: Zone = {
    "example.test": { a: ["192.0.2.10"], mx: [[10, "mail.example.test"]], ns: ["ns1.example.test"] },
    "www.example.test": { cname: "edge.example.test" },
    "edge.example.test": { a: ["192.0.2.20"] },
    "mail.example.test": { a: ["192.0.2.11"] },
    "ns1.example.test": { a: ["192.0.2.53"] },
    "old.example.test": { cname: "gone-app.herokuapp.com" }, // the target is not in the zone: NXDOMAIN
    "inbound.example.test": { cname: "inbound.provider.test" },
    "inbound.provider.test": { txt: ["only text here"] }, // exists, holds no address
    "flaky.example.test": { fail: true },
  };

  it("tells a dangling CNAME from one to a name that exists without an address, and keeps a server failure as an error", async () => {
    const server = await serveDns(zone);
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const dns = await collectSiteDns("example.test", resolver, { subdomains: ["old", "inbound", "flaky"], wildcardLabel: "zz-probe" });
      const byName = (host: string) => dns.names.find((entry) => entry.name === host);
      expect(byName("old.example.test")).toMatchObject({ cname: ["gone-app.herokuapp.com"], nxdomain: true });
      expect(byName("inbound.example.test")).toMatchObject({ cname: ["inbound.provider.test"] });
      expect(byName("inbound.example.test")?.nxdomain).toBeUndefined();
      expect(byName("www.example.test")).toMatchObject({ cname: ["edge.example.test"], a: ["192.0.2.20"] });
      expect(byName("flaky.example.test")?.error).toMatch(/SERVFAIL/);
      expect(dns.wildcard).toBeUndefined();
      expect(dns.names.map((entry) => entry.role)).toContain("mx");
    } finally {
      server.close();
    }
  });

  it("runs the whole tool against it and names the dangling service", async () => {
    const server = await serveDns(zone);
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const result = await call(toolWith(resolver), { site: "example.test", subdomains: ["old", "inbound"] });
      expect(result.details.status).toBe("fail");
      expect(result.details.findings[0]?.evidence).toContain("old.example.test -> gone-app.herokuapp.com (Heroku; the target does not exist)");
      expect(result.details.findings[0]?.evidence).not.toContain("inbound.example.test");
    } finally {
      server.close();
    }
  });
});

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_dns_dangling");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
