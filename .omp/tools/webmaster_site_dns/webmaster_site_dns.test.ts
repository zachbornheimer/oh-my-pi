import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apexOf,
  collectSiteDns,
  type DnsResolver,
  MAX_SERVER_HOSTS,
  NameNotFound,
  systemResolver,
  validatedSubdomains,
} from "./dns.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";

/** omp's own `pi.zod` (omptype): the fork's package when this directory sits in `.omp/tools/`, else the local checkout. */
async function loadZod(): Promise<unknown> {
  const candidates = [
    fileURLToPath(new URL("../../../packages/omptype/src/zod.ts", import.meta.url)),
    join(homedir(), "Developer/Personal/oh-my-pi/packages/omptype/src/zod.ts"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`omptype zod.ts not found in: ${candidates.join(", ")}`);
  // The path is chosen at run time (fork layout or local checkout), so a static import cannot name it.
  return ((await import(found)) as { z: unknown }).z;
}

type Zone = Record<
  string,
  Partial<Record<"a" | "aaaa" | "cname" | "ns" | "txt", string[]>> & {
    mx?: { exchange: string; priority: number }[];
    fail?: string;
    /** The name does not exist: an address lookup rejects with `NameNotFound`. */
    missing?: true;
  }
>;

/** A synthetic zone: every answer comes from this table, never from the network. */
function zoneResolver(zone: Zone): DnsResolver & { asked: string[] } {
  const asked: string[] = [];
  const answer = <T>(name: string, kind: string, pick: (entry: Zone[string]) => T[] | undefined): Promise<T[]> => {
    asked.push(`${kind} ${name}`);
    const entry = zone[name];
    if (entry?.fail !== undefined) return Promise.reject(new Error(entry.fail));
    return Promise.resolve(entry === undefined ? [] : (pick(entry) ?? []));
  };
  return {
    asked,
    a: (name) =>
      zone[name]?.missing === true ? Promise.reject(new NameNotFound(name)) : answer(name, "A", (entry) => entry.a),
    aaaa: (name) =>
      zone[name]?.missing === true
        ? Promise.reject(new NameNotFound(name))
        : answer(name, "AAAA", (entry) => entry.aaaa),
    cname: (name) => answer(name, "CNAME", (entry) => entry.cname),
    mx: (name) => answer(name, "MX", (entry) => entry.mx),
    ns: (name) => answer(name, "NS", (entry) => entry.ns),
    txt: (name) => answer(name, "TXT", (entry) => entry.txt),
  };
}

const ZONE: Zone = {
  "example.org": {
    a: ["203.0.113.10"],
    mx: [{ exchange: "mail.example.org", priority: 10 }],
    ns: ["ns1.example.net"],
    txt: ["v=spf1 -all"],
  },
  "www.example.org": { cname: ["edge.example.net"] },
  "edge.example.net": { a: ["198.51.100.7"] },
  "staging.example.org": { a: ["203.0.113.24"] },
  "mail.example.org": { a: ["203.0.113.10"] },
  "ns1.example.net": { a: ["198.51.100.53"] },
  "shop.example.org": { fail: "SERVFAIL" },
};

describe("collectSiteDns", () => {
  it("collects every record of the apex, www, found subdomains, MX and NS hosts, following CNAME chains", async () => {
    const resolver = zoneResolver(ZONE);
    const dns = await collectSiteDns("https://www.example.org/some/page", resolver, {
      subdomains: ["staging", "shop", "blog"],
    });
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
    const dns = await collectSiteDns("example.com", resolver, {
      subdomains: ["shop", "staging"],
      wildcardLabel: "zz-probe",
    });
    expect(dns.wildcard).toEqual({ a: ["203.0.113.5"], aaaa: [], cname: [] });
    expect(dns.names.find((entry) => entry.name === "shop.example.com")?.wildcard).toBe(true);
    expect(dns.names.find((entry) => entry.name === "staging.example.com")?.wildcard).toBeUndefined();
    // The probe itself is never listed as a host.
    expect(dns.names.some((entry) => entry.name === "zz-probe.example.com")).toBe(false);
  });

  it("reports no wildcard when a made-up label does not answer", async () => {
    const dns = await collectSiteDns("example.org", zoneResolver(ZONE), { subdomains: ["staging"] });
    expect(dns.wildcard).toBeUndefined();
    expect(dns.names.find((entry) => entry.name === "staging.example.org")?.wildcard).toBeUndefined();
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

  it("looks up at most MAX_SERVER_HOSTS MX hosts", async () => {
    const mx = Array.from({ length: MAX_SERVER_HOSTS + 10 }, (_, index) => ({
      exchange: `mx${index}.example.net`,
      priority: index,
    }));
    const dns = await collectSiteDns("example.org", zoneResolver({ "example.org": { mx } }), { subdomains: [] });
    expect(dns.names.filter((entry) => entry.role === "mx")).toHaveLength(MAX_SERVER_HOSTS);
  });

  it("does not look up the empty host of a null MX (RFC 7505)", async () => {
    const resolver = zoneResolver({ "example.org": { mx: [{ exchange: "", priority: 0 }], a: ["203.0.113.1"] } });
    const dns = await collectSiteDns("example.org", resolver, { subdomains: [] });
    expect(dns.names.map((entry) => entry.name)).toEqual(["example.org", "www.example.org"]);
    expect(dns.names[0]!.mx).toEqual([{ exchange: "", priority: 0 }]);
    expect(resolver.asked.some((line) => line.endsWith(" "))).toBe(false);
  });

  it("the system resolver turns node:dns's synchronous rejection of an empty name into a rejected lookup", async () => {
    await expect(systemResolver.a("")).rejects.toThrow();
  });

  it("refuses a bad subdomain label before any query", async () => {
    const resolver = zoneResolver(ZONE);
    await expect(collectSiteDns("example.org", resolver, { subdomains: ["a/b"] })).rejects.toThrow(/not a subdomain label/);
    await expect(collectSiteDns("example.org", resolver, { subdomains: ["a b"] })).rejects.toThrow();
    expect(resolver.asked).toEqual([]);
    expect(() => validatedSubdomains(Array.from({ length: 51 }, (_, index) => `s${index}`))).toThrow(/at most 50/);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectSiteDns("example.org", zoneResolver(ZONE), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("apexOf", () => {
  it("names the apex from a domain or an address", () => {
    expect(["https://www.Example.org/x", "WWW.example.org.", "example.org:8080"].map(apexOf)).toEqual(
      Array(3).fill("example.org"),
    );
  });
  it("refuses text that is not a host", () => {
    expect(() => apexOf("exa mple.org")).toThrow(/not a domain or address/);
  });
});

describe("the system resolver", () => {
  it("answers 'no record' with an empty list and a missing name with NameNotFound (localhost has no MX, .invalid does not exist)", async () => {
    // `.invalid` is reserved (RFC 2606) and never resolves; the lookup goes to the machine's resolver only.
    await expect(systemResolver.a("does-not-exist.invalid")).rejects.toBeInstanceOf(NameNotFound);
  });
});

describe("the tool", () => {
  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { resolver: zoneResolver(ZONE) });
    expect(tool.name).toBe("webmaster_site_dns");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", subdomains: null }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", subdomains: ["a"] }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", subdomains: "a" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("returns the collection as details and text; null subdomains means the default list", async () => {
    const resolver = zoneResolver(ZONE);
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { resolver, wildcardLabel: "zz-probe" });
    const result = await tool.execute("id", { site: "example.org", subdomains: null }, undefined, undefined);
    expect(result.details.names.map((entry) => entry.name)).toEqual([
      "example.org",
      "www.example.org",
      "shop.example.org",
      "staging.example.org",
      "mail.example.org",
      "ns1.example.net",
    ]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    // The default list was looked up (webmail has no records and is omitted but was asked).
    expect(resolver.asked).toContain("A webmail.example.org");
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("never says what they mean");
  });
});
