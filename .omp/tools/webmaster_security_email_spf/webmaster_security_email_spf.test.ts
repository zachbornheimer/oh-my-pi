import { describe, expect, it } from "bun:test";
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, type CheckTool, type SecurityCheckResult } from "./check";
import factory from "./index";
import { serveDns, type Zone } from "./local_dns";
import { type DnsResolver, joinTxt, systemResolver } from "./resolver";
import { SPF_LOOKUP_LIMIT, spfLookups, spfVerdict } from "./rules";
import { DESCRIPTION, makeTool, type Params } from "./tool";
import { collectTxt, type TxtEntry } from "./txt";

const SPF = "v=spf1 include:_spf.example.net -all";
const apexOnly = (...txt: string[]): TxtEntry[] => [{ name: "example.org", role: "apex", txt }];
const run = (entries: readonly TxtEntry[] | undefined): SecurityCheckResult =>
  answer("example.org", "c", spfVerdict("example.org", entries));
const idsOf = (result: SecurityCheckResult) => result.findings.map((finding) => [finding.id, finding.severity]);
const includes = (count: number) =>
  `v=spf1 ${Array.from({ length: count }, (_, index) => `include:s${index}.example.net`).join(" ")} -all`;

describe("spfVerdict", () => {
  it("passes one record within the lookup limit", () => {
    expect(run(apexOnly(SPF))).toMatchObject({ site: "example.org", status: "pass", findings: [] });
  });

  it("flags no SPF record as medium", () => {
    expect(idsOf(run(apexOnly("google-site-verification=x")))).toEqual([["security.email.spf.missing", "medium"]]);
  });

  it("flags two SPF records as high, naming both", () => {
    const result = run(apexOnly(SPF, "v=spf1 a mx -all"));
    expect(idsOf(result)).toEqual([["security.email.spf.duplicate", "high"]]);
    expect(result.findings[0]?.evidence).toContain("v=spf1 a mx -all");
  });

  it("flags a record with more than 10 lookup terms as high, and counts 10 as fine", () => {
    const result = run(apexOnly(includes(11)));
    expect(idsOf(result)).toEqual([["security.email.spf.lookups", "high"]]);
    expect(result.findings[0]?.evidence).toContain("needs 11 DNS lookups");
    expect(run(apexOnly(includes(10)))).toMatchObject({ status: "pass" });
  });

  it("counts a, mx, ptr, exists, include and redirect terms, with qualifiers, and no others", () => {
    expect(spfLookups("v=spf1 a mx:mail.example.net ip4:192.0.2.1 ptr -all")).toBe(3);
    expect(spfLookups("v=spf1 +a ~mx ?exists:x.example.net -include:y.example.net redirect=z.example.net ip6:2001:db8::/32 all")).toBe(5);
    expect(spfLookups("v=spf1 -all")).toBe(0);
  });

  it("does not read the records an include names: only the apex record's own terms count", () => {
    expect(run([...apexOnly(SPF), { name: "_spf.example.net", role: "label", txt: ["v=spf1 a mx a mx a mx a mx a mx a mx -all"] }]))
      .toMatchObject({ status: "pass" });
  });

  it("is unmeasured, never passing, with no records or a failed apex lookup", () => {
    expect(run(undefined)).toMatchObject({ status: "unmeasured", reason: "no DNS records were collected for this site" });
    expect(run([{ name: "example.org", role: "apex", txt: [], error: "TXT: queryTxt ETIMEOUT example.org" }])).toMatchObject({
      status: "unmeasured",
      reason: expect.stringContaining("ETIMEOUT"),
    });
  });
});

/** A synthetic resolver: only TXT is answered (a check asks for nothing else); a string is a failed lookup. */
function txtResolver(zone: Record<string, string[] | string>): DnsResolver & { asked: string[] } {
  const asked: string[] = [];
  const refuse = () => Promise.reject(new Error("this check asks only for TXT"));
  return {
    asked,
    a: refuse,
    aaaa: refuse,
    cname: refuse,
    mx: refuse,
    ns: refuse,
    txt: (name) => {
      asked.push(name);
      const found = zone[name];
      if (typeof found === "string") return Promise.reject(new Error(found));
      return Promise.resolve(found ?? []);
    },
  };
}

/** A stand-in for omp's `pi.zod`: every builder call returns the same chainable no-op (the real one is load-checked apart). */
const chain: unknown = new Proxy(() => undefined, { get: () => chain, apply: () => chain });
const pi = { zod: chain } as unknown as Pick<CustomToolAPI, "zod">;

type Tool = CheckTool<Params, unknown>;
const toolWith = (resolver: DnsResolver): Tool => makeTool(pi, { resolver: () => resolver }) as Tool;
const call = (t: Tool, params: Params, signal?: AbortSignal) => t.execute("id", params, undefined, undefined, signal);

describe("collectTxt", () => {
  it("keeps a failed lookup as the entry's error", async () => {
    const entries = await collectTxt("www.example.org", [], txtResolver({ "example.org": "queryTxt ETIMEOUT" }));
    expect(entries).toEqual([{ name: "example.org", role: "apex", txt: [], error: "TXT: queryTxt ETIMEOUT" }]);
  });
});

describe("webmaster_security_email_spf tool", () => {
  it("collects the apex's TXT for a www address and judges it", async () => {
    const resolver = txtResolver({ "example.org": [SPF] });
    const result = await call(toolWith(resolver), { site: "https://www.example.org/page" });
    expect(result.details).toEqual({ site: "example.org", check: "webmaster.security.email.spf", status: "pass", findings: [] });
    expect(resolver.asked).toEqual(["example.org"]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("reports a missing record, and a failed apex lookup as unmeasured", async () => {
    const missing = await call(toolWith(txtResolver({ "example.org": ["something else"] })), { site: "example.org" });
    expect(missing.details.findings.map((finding) => finding.id)).toEqual(["security.email.spf.missing"]);
    const failed = await call(toolWith(txtResolver({ "example.org": "queryTxt ETIMEOUT example.org" })), { site: "example.org" });
    expect(failed.details).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("ETIMEOUT") });
  });

  it("fails on an invalid site and on an already-aborted call", async () => {
    await expect(call(toolWith(txtResolver({})), { site: "http://" })).rejects.toThrow(/site must be a domain/);
    const controller = new AbortController();
    controller.abort();
    await expect(call(toolWith(txtResolver({})), { site: "example.org" }, controller.signal)).rejects.toThrow();
  });
});

describe("the system resolver against a local DNS server (no external network)", () => {
  const zone: Zone = {
    "example.org": { txt: ["v=spf1 include:_spf.example.net ~all", "google-site-verification=abc"], a: ["192.0.2.10"] },
    "empty.example.org": { a: ["192.0.2.11"] },
    "broken.example.org": { fail: true },
  };

  it("answers TXT, treats a name with no TXT or no such name as empty, and surfaces a server failure", async () => {
    const server = await serveDns(zone);
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      expect(await resolver.txt("example.org")).toEqual(["v=spf1 include:_spf.example.net ~all", "google-site-verification=abc"]);
      expect(await resolver.txt("empty.example.org")).toEqual([]);
      expect(await resolver.txt("nowhere.example.org")).toEqual([]);
      await expect(resolver.txt("broken.example.org")).rejects.toThrow(/SERVFAIL/);
    } finally {
      server.close();
    }
  });

  it("runs the whole tool against it", async () => {
    const server = await serveDns(zone);
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const result = await call(toolWith(resolver), { site: "example.org" });
      expect(result.details.status).toBe("pass");
      expect(server.queries).toEqual(["TXT example.org"]);
    } finally {
      server.close();
    }
  });

  it("joins a TXT record split into 255-byte strings", async () => {
    const long = `v=spf1 ${"ip4:192.0.2.1 ".repeat(30)}-all`;
    const server = await serveDns({ "example.org": { txt: [long] } });
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      expect(await resolver.txt("example.org")).toEqual([long]);
    } finally {
      server.close();
    }
  });

  it("rejects a name the runtime refuses outright (an empty one) instead of throwing synchronously", async () => {
    const resolver = systemResolver({ servers: ["127.0.0.1:9"], timeoutMs: 100, tries: 1 });
    await expect(resolver.a("")).rejects.toThrow();
  });

  it("cancels queries still in flight when the signal aborts", async () => {
    const controller = new AbortController();
    // 192.0.2.1 is TEST-NET-1: nothing answers, so the query can only end by cancellation.
    const resolver = systemResolver({ servers: ["192.0.2.1"], timeoutMs: 60_000, tries: 1, signal: controller.signal });
    const pending = resolver.txt("example.org");
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("joinTxt", () => {
  const full = "x".repeat(255);
  it("joins the strings of each record when the runtime groups them by record (Node)", () => {
    expect(joinTxt([[full, "tail"], ["other"]], false)).toEqual([`${full}tail`, "other"]);
  });

  it("rebuilds records from separate 255-byte strings when the runtime does not group them (Bun)", () => {
    expect(joinTxt([[full], [full], ["tail"], ["other"], [""]], true)).toEqual([`${full}${full}tail`, "other", ""]);
    expect(joinTxt([], true)).toEqual([]);
  });
});

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_email_spf");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(SPF_LOOKUP_LIMIT).toBe(10);
  });
});
