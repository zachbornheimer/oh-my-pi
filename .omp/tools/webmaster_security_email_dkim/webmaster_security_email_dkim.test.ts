import { describe, expect, it } from "bun:test";
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, type CheckTool, type SecurityCheckResult } from "./check";
import factory from "./index";
import { serveDns } from "./local_dns";
import { type DnsResolver, systemResolver } from "./resolver";
import { DKIM_SELECTORS, dkimVerdict, isDkimKey, selectorsToAsk, validSelectors } from "./rules";
import { DESCRIPTION, makeTool, type Params } from "./tool";
import type { TxtEntry } from "./txt";

const apex = (...txt: string[]): TxtEntry => ({ name: "example.org", role: "apex", txt });
const key = (selector: string, ...txt: string[]): TxtEntry => ({ name: `${selector}._domainkey.example.org`, role: "label", txt });
const run = (entries: readonly TxtEntry[] | undefined, extra: readonly string[] = []): SecurityCheckResult =>
  answer("example.org", "c", dkimVerdict("example.org", entries, extra));
const idsOf = (result: SecurityCheckResult) => result.findings.map((finding) => [finding.id, finding.severity]);

describe("dkimVerdict", () => {
  it("passes when any selector asked holds a key, Fastmail's fm2 and Zoho's zmail included", () => {
    for (const selector of ["google", "fm2", "zmail"]) {
      expect(run([apex(), key(selector, "v=DKIM1; k=rsa; p=MIIB")]), selector).toMatchObject({ status: "pass" });
    }
  });

  it("flags no key at any selector as medium, naming the selectors asked", () => {
    const result = run([apex()], ["brand2024"]);
    expect(idsOf(result)).toEqual([["security.email.dkim.missing", "medium"]]);
    expect(result.findings[0]?.evidence).toContain("fm1");
    expect(result.findings[0]?.evidence).toContain("brand2024");
  });

  it("asks the domain's own selectors too", () => {
    expect(run([apex(), key("brand2024", "v=DKIM1; p=MIIB")], ["brand2024"])).toMatchObject({ status: "pass" });
    expect(run([apex(), key("brand2024", "v=DKIM1; p=MIIB")])).toMatchObject({ status: "fail" }); // not asked, so not seen
  });

  it("counts a key only per RFC 6376", () => {
    expect(isDkimKey(["v=DKIM1; k=rsa; p=MIIB"])).toBe(true);
    expect(isDkimKey(["k=rsa; p=MIIB"])).toBe(true);
    expect(isDkimKey(["v=DKIM1; p="])).toBe(false);
    expect(isDkimKey(["v=DKIM2; p=MIIB"])).toBe(false);
    expect(isDkimKey(["v=spf1 include:_spf.example.net -all"])).toBe(false);
    expect(isDkimKey(["v=DKIM1; k=rsa; p=AA==BB"])).toBe(true); // a `=` inside the key data is kept
    expect(run([apex(), key("google", "v=DKIM1; p=")])).toMatchObject({ status: "fail" });
  });

  it("is unmeasured when nothing was collected, or a selector lookup failed and no key was found", () => {
    expect(run(undefined)).toMatchObject({ status: "unmeasured" });
    const failed: TxtEntry = { name: "google._domainkey.example.org", role: "label", txt: [], error: "TXT: queryTxt SERVFAIL" };
    expect(run([apex(), failed])).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("SERVFAIL") });
    expect(run([apex(), failed, key("s1", "v=DKIM1; p=MIIB")])).toMatchObject({ status: "pass" });
  });
});

describe("selectors", () => {
  it("asks the 21 common selectors and the caller's, each once", () => {
    expect(DKIM_SELECTORS).toHaveLength(21);
    expect(selectorsToAsk(["google", "mine"])).toHaveLength(22);
  });

  it("accepts DNS labels and rejects anything else before a query is made", () => {
    expect(validSelectors([" Brand2024 ", "s1.sub", "k-1"])).toEqual(["brand2024", "s1.sub", "k-1"]);
    for (const bad of ["", "a b", "-a", "a-", "a..b", "a._domainkey.evil.example", "sel;x", "x".repeat(64), "é"]) {
      expect(() => validSelectors([bad]), bad).toThrow(/dkim_selectors must be DNS labels/);
    }
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

describe("webmaster_security_email_dkim tool", () => {
  it("asks every selector's `_domainkey` name under the apex, and the caller's own", async () => {
    const resolver = txtResolver({ "brand2024._domainkey.example.org": ["v=DKIM1; k=rsa; p=MIIB"] });
    const result = await call(toolWith(resolver), { site: "https://www.example.org/", dkim_selectors: ["Brand2024"] });
    expect(result.details).toEqual({ site: "example.org", check: "webmaster.security.email.dkim", status: "pass", findings: [] });
    expect(resolver.asked).toHaveLength(1 + 22);
    expect(resolver.asked).toContain("fm3._domainkey.example.org");
    expect(resolver.asked).toContain("brand2024._domainkey.example.org");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("reports no key as a finding, a null selector list as none, and failed lookups as unmeasured", async () => {
    const missing = await call(toolWith(txtResolver({})), { site: "example.org", dkim_selectors: null });
    expect(missing.details.findings.map((finding) => finding.id)).toEqual(["security.email.dkim.missing"]);
    const failed = await call(toolWith(txtResolver({ "google._domainkey.example.org": "queryTxt ETIMEOUT" })), { site: "example.org" });
    expect(failed.details).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("ETIMEOUT") });
  });

  it("throws on an invalid selector without querying, on an invalid site, and on an aborted call", async () => {
    const resolver = txtResolver({});
    await expect(call(toolWith(resolver), { site: "example.org", dkim_selectors: ["a b"] })).rejects.toThrow(/dkim_selectors/);
    expect(resolver.asked).toEqual([]);
    await expect(call(toolWith(resolver), { site: "http://" })).rejects.toThrow(/site must be a domain/);
    const controller = new AbortController();
    controller.abort();
    await expect(call(toolWith(resolver), { site: "example.org" }, controller.signal)).rejects.toThrow();
  });
});

describe("the system resolver against a local DNS server (no external network)", () => {
  it("finds a 2048-bit key split into several strings, and a key reached through a CNAME", async () => {
    const longKey = `v=DKIM1; k=rsa; p=${"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A".repeat(14)}`;
    const server = await serveDns({
      "example.org": { a: ["192.0.2.1"] },
      "google._domainkey.example.org": { txt: [longKey] },
      "plain.test": { a: ["192.0.2.2"] },
      "s1._domainkey.plain.test": { cname: "s1.domainkey.u1.provider.test" },
      "s1.domainkey.u1.provider.test": { txt: ["k=rsa; t=s; p=MIIBabc"] },
    });
    try {
      expect(longKey.length).toBeGreaterThan(255);
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      expect(await resolver.txt("google._domainkey.example.org")).toEqual([longKey]);
      const t = toolWith(resolver);
      expect((await call(t, { site: "example.org" })).details.status).toBe("pass");
      expect((await call(t, { site: "plain.test" })).details.status).toBe("pass");
    } finally {
      server.close();
    }
  });

  it("reports no key when every selector is absent, and fails soft on a server error", async () => {
    const server = await serveDns({ "example.org": { a: ["192.0.2.1"] }, "google._domainkey.broken.test": { fail: true }, "broken.test": { a: ["192.0.2.3"] } });
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const t = toolWith(resolver);
      expect((await call(t, { site: "example.org" })).details.findings.map((finding) => finding.id)).toEqual([
        "security.email.dkim.missing",
      ]);
      expect((await call(t, { site: "broken.test" })).details).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("SERVFAIL") });
    } finally {
      server.close();
    }
  });
});

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_email_dkim");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
