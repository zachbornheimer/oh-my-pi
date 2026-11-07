import { describe, expect, it } from "bun:test";
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import { answer, type CheckTool, type SecurityCheckResult } from "./check";
import factory from "./index";
import { serveDns } from "./local_dns";
import { type DnsResolver, systemResolver } from "./resolver";
import { dmarcPolicy, dmarcTags, dmarcVerdict } from "./rules";
import { DESCRIPTION, makeTool, type Params } from "./tool";
import { collectTxt, type TxtEntry } from "./txt";

const apex = (...txt: string[]): TxtEntry => ({ name: "example.org", role: "apex", txt });
const dmarc = (...txt: string[]): TxtEntry => ({ name: "_dmarc.example.org", role: "label", txt });
const run = (entries: readonly TxtEntry[] | undefined): SecurityCheckResult =>
  answer("example.org", "c", dmarcVerdict("example.org", entries));
const idsOf = (result: SecurityCheckResult) => result.findings.map((finding) => [finding.id, finding.severity]);

describe("dmarcVerdict", () => {
  it("passes an enforcing policy", () => {
    for (const record of ["v=DMARC1; p=quarantine", "v=DMARC1; p=reject; rua=mailto:r@example.org", "V=dmarc1; P=REJECT"]) {
      expect(run([apex(), dmarc(record)]), record).toMatchObject({ status: "pass" });
    }
  });

  it("flags no DMARC record as medium, and a TXT that is not DMARC as missing", () => {
    expect(idsOf(run([apex(), dmarc()]))).toEqual([["security.email.dmarc.missing", "medium"]]);
    expect(idsOf(run([apex()]))).toEqual([["security.email.dmarc.missing", "medium"]]);
    expect(idsOf(run([apex(), dmarc("not a dmarc record", "v=DMARC10; p=reject")]))).toEqual([
      ["security.email.dmarc.missing", "medium"],
    ]);
  });

  it("flags p=none by its tag, however the record is spaced or cased", () => {
    for (
      const record of [
        "v=DMARC1; p=none",
        "v=DMARC1;p=NONE; rua=mailto:x@example.org",
        "v=DMARC1; rua=mailto:x@example.org; p = none",
      ]
    ) {
      expect(idsOf(run([apex(), dmarc(record)])), record).toEqual([["security.email.dmarc.none", "medium"]]);
    }
    expect(dmarcPolicy(["v=DMARC1; sp=none; p=reject"])).toBe("reject");
    expect(dmarcPolicy(["not dmarc"])).toBeUndefined();
    expect(dmarcTags("v=DMARC1; p = reject ;; =x; junk")).toEqual({ v: "DMARC1", p: "reject" });
  });

  it("reports the policy as published: a record with no p= tag is not flagged, as the Mastra capability does", () => {
    expect(dmarcPolicy(["v=DMARC1; rua=mailto:r@example.org"])).toBe("");
    expect(run([apex(), dmarc("v=DMARC1; rua=mailto:r@example.org")])).toMatchObject({ status: "pass" });
    expect(run([apex(), dmarc("v=DMARC1; pct=100")])).toMatchObject({ status: "pass" });
  });

  it("is unmeasured when nothing was collected, the apex lookup failed, or the _dmarc lookup failed", () => {
    expect(run(undefined)).toMatchObject({ status: "unmeasured" });
    expect(run([{ name: "example.org", role: "apex", txt: [], error: "TXT: queryTxt ETIMEOUT" }])).toMatchObject({
      status: "unmeasured",
    });
    const failed: TxtEntry = { name: "_dmarc.example.org", role: "label", txt: [], error: "TXT: queryTxt ETIMEOUT" };
    expect(run([apex(), failed])).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("_dmarc.example.org") });
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
  it("keeps a failed lookup as that entry's error and asks each name once", async () => {
    const resolver = txtResolver({ "example.org": ["x"], "_dmarc.example.org": "queryTxt ESERVFAIL" });
    const entries = await collectTxt("www.example.org", ["_dmarc", "_dmarc"], resolver);
    expect(entries).toEqual([
      { name: "example.org", role: "apex", txt: ["x"] },
      { name: "_dmarc.example.org", role: "label", txt: [], error: "TXT: queryTxt ESERVFAIL" },
    ]);
    expect(resolver.asked).toEqual(["example.org", "_dmarc.example.org"]);
  });
});

describe("webmaster_security_email_dmarc tool", () => {
  it("asks for the apex and `_dmarc.<apex>` and judges them", async () => {
    const resolver = txtResolver({ "_dmarc.example.org": ["v=DMARC1; p=reject; rua=mailto:r@example.org"] });
    const result = await call(toolWith(resolver), { site: "https://www.example.org/page" });
    expect(result.details).toEqual({ site: "example.org", check: "webmaster.security.email.dmarc", status: "pass", findings: [] });
    expect(resolver.asked.sort()).toEqual(["_dmarc.example.org", "example.org"]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("reports p=none and a missing record as findings, and a failed lookup as unmeasured", async () => {
    const none = await call(toolWith(txtResolver({ "_dmarc.example.org": ["v=DMARC1; p=none"] })), { site: "example.org" });
    expect(none.details.findings.map((finding) => finding.id)).toEqual(["security.email.dmarc.none"]);
    const missing = await call(toolWith(txtResolver({})), { site: "example.org" });
    expect(missing.details.findings.map((finding) => finding.id)).toEqual(["security.email.dmarc.missing"]);
    const failed = await call(toolWith(txtResolver({ "_dmarc.example.org": "queryTxt ETIMEOUT" })), { site: "example.org" });
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
  it("runs the whole tool: a published policy passes, no record is missing, a server failure is unmeasured", async () => {
    const server = await serveDns({
      "example.org": { txt: ["v=spf1 -all"] },
      "_dmarc.example.org": { txt: ["v=DMARC1; p=quarantine"] },
      "plain.test": { a: ["192.0.2.1"] },
      "down.test": { txt: ["x"] },
      "_dmarc.down.test": { fail: true },
    });
    try {
      const resolver = systemResolver({ servers: [`127.0.0.1:${server.port}`], timeoutMs: 500, tries: 1 });
      const t = toolWith(resolver);
      expect((await call(t, { site: "example.org" })).details.status).toBe("pass");
      expect((await call(t, { site: "plain.test" })).details.findings.map((finding) => finding.id)).toEqual([
        "security.email.dmarc.missing",
      ]);
      expect((await call(t, { site: "down.test" })).details).toMatchObject({
        status: "unmeasured",
        reason: expect.stringContaining("SERVFAIL"),
      });
    } finally {
      server.close();
    }
  });
});

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_email_dmarc");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
