import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DnsName } from "./dns";
import type { HomePage } from "./defacement";
import type { WordpressInspect } from "./inspect";
import { dailyPorts, runWithExec } from "./live";
import { readmeVersion } from "./wp_core_version";
import type { WordpressPublicApi } from "./public_api";
import type { SitePublicFiles } from "./public_files";
import { checkSites, type DailyPorts, type SiteSecurityPorts } from "./site_security";
import { DESCRIPTION, makeTool } from "./tool";
import { loadZod } from "./zod_for_tests";

const fixture = <T>(file: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as T;
const empty = { a: [], aaaa: [], cname: [], mx: [], ns: [], txt: [] };
const names = (): DnsName[] => [
  { name: "example.org", role: "apex", ...empty, a: ["192.0.2.10"], txt: ["v=spf1 -all", "v=spf1 +all"] },
  { name: "www.example.org", role: "www", ...empty, a: ["192.0.2.10"] },
] as DnsName[];

/** Collection ports answering from the compromised fixtures, recording the addresses asked. */
function fakePorts(): { ports: SiteSecurityPorts; dns: string[] } {
  const dns: string[] = [];
  const ports: SiteSecurityPorts = {
    siteFile: async () => undefined,
    dns: async (site) => {
      dns.push(site);
      return { site: "example.org", names: names() };
    },
    certificate: async () => ({ status: "unmeasured", reason: "no route in the test" }),
    publicFiles: async () => fixture<SitePublicFiles>("public_files_compromised.json"),
    publicApi: async () => fixture<WordpressPublicApi>("public_api_compromised.json"),
    inspect: async () => fixture<WordpressInspect>("inspect_compromised.json"),
    homePage: async () => fixture<HomePage>("home-page-defaced.json"),
    picture: async () => ({ screenshot: { status: "unmeasured", reason: "no browser in the test" } }),
  };
  return { ports, dns };
}

const result = (site: string, severities: string[]) => ({
  site,
  checks: [],
  findings: severities.map((severity) => ({ id: "x", area: "security", severity, evidence: "", containment: "", fix_hint: "" })),
  unmeasured: [],
}) as never;

const scripted = (configured: string[], failing: readonly string[] = []) => {
  const checked: string[] = [];
  const ports: DailyPorts = {
    sites: async () => configured,
    addressOf: async (name) => `https://${name}.example`,
    check: async (address) => {
      checked.push(address);
      if (failing.some((name) => address.includes(`${name}.`))) throw new Error(`${address}: did not answer`);
      return result(address, ["high"]);
    },
  };
  return { checked, ports };
};

describe("checkSites", () => {
  it("checks every configured site in turn and keeps a failed site as data", async () => {
    const { ports, checked } = scripted(["gamma", "beta", "alpha"], ["beta"]);
    const run = await checkSites(undefined, ports);
    expect(checked).toEqual(["https://gamma.example", "https://beta.example", "https://alpha.example"]);
    expect(run.sites.map((entry) => [entry.site, entry.status])).toEqual([["gamma", "checked"], ["beta", "failed"], ["alpha", "checked"]]);
    expect(run.sites[1]).toMatchObject({ error: "https://beta.example: did not answer" });
    expect(run.totals).toEqual({ high: 2 });
  });

  it("checks only the sites it is told to, and records a site file that cannot be read", async () => {
    const { ports, checked } = scripted(["gamma", "beta"]);
    const run = await checkSites(["beta", "ghost"], {
      ...ports,
      addressOf: async (n) => {
        if (n === "ghost") throw new Error("no site file");
        return `https://${n}.example`;
      },
    });
    expect(checked).toEqual(["https://beta.example"]);
    expect(run.sites[1]).toEqual({ site: "ghost", status: "failed", error: "no site file" });
  });

  it("does not list a cancelled run as a failed site", async () => {
    const controller = new AbortController();
    const { ports } = scripted(["a", "b"]);
    const aborting = { ...ports, check: async () => { controller.abort(); throw new Error("aborted"); } };
    await expect(checkSites(undefined, aborting, controller.signal)).rejects.toThrow();
  });

  it("prefixes progress notes with the site", async () => {
    const notes: string[] = [];
    const { ports } = scripted(["a"]);
    await checkSites(undefined, { ...ports, check: async (address, progress) => { progress?.("dns"); return result(address, []); } }, undefined, (n) => notes.push(n));
    expect(notes).toEqual(["a: dns"]);
  });
});

describe("the tool", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "site-security-daily-"));
    writeFileSync(join(directory, "gamma.yaml"), "url: https://example.org\ncapabilities: [uptime, security]\n");
    writeFileSync(join(directory, "alpha.yaml"), "url: https://example.com\ncapabilities: [security]\n");
    writeFileSync(join(directory, "parked.yaml"), "url: https://parked.example\ncapabilities: [uptime]\n");
    writeFileSync(join(directory, "broken.yaml"), "[: not yaml");
    writeFileSync(join(directory, "notes.md"), "not a site");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const exec = (async () => { throw new Error("exec must not run"); }) as never;
  const build = async (ports: SiteSecurityPorts) => makeTool({ zod: await loadZod(), cwd: ".", exec } as never, { ports, sitesDirectory: directory });

  it("lists the site files that list security among their capabilities, in file order, and resolves their addresses", async () => {
    const live = dailyPorts({ exec, sitesDirectory: directory }, async () => { throw new Error("no"); });
    expect(await live.sites()).toEqual(["alpha", "gamma"]);
    expect(await live.addressOf("gamma")).toBe("https://example.org");
    await expect(live.addressOf("nope")).rejects.toThrow(/no site file/);
    await expect(live.addressOf("../etc/passwd")).rejects.toThrow(/not a site file name/);
  });

  it("checks every site file that lists security with no input, each over the built-in checks", async () => {
    const { ports, dns } = fakePorts();
    const tool = await build(ports);
    const output = await tool.execute("id", {}, undefined, undefined);
    expect(dns).toEqual(["https://example.com", "https://example.org"]);
    expect(output.details.sites.map((entry) => [entry.site, entry.status])).toEqual([["alpha", "checked"], ["gamma", "checked"]]);
    expect(output.details.totals["high"]).toBeGreaterThan(0);
    expect(JSON.parse(output.content[0]!.text)).toEqual(output.details);
  });

  it("checks named sites once each, records an unknown one as failed, and trims names", async () => {
    const { ports } = fakePorts();
    const tool = await build(ports);
    const output = await tool.execute("id", { sites: [" gamma ", "gamma", "ghost"] }, undefined, undefined);
    expect(output.details.sites.map((entry) => [entry.site, entry.status])).toEqual([["gamma", "checked"], ["ghost", "failed"]]);
  });

  it("loads against omp's own zod: accepts valid input and null, rejects an invalid one", async () => {
    const tool = await build(fakePorts().ports);
    const p = tool.parameters as unknown as { parse(value: unknown): unknown };
    expect(tool.name).toBe("webmaster_site_security_daily");
    expect(tool.loadMode).toBe("discoverable");
    expect(() => p.parse({})).not.toThrow();
    expect(() => p.parse({ sites: ["isjac"] })).not.toThrow();
    expect(() => p.parse({ sites: null })).not.toThrow();
    expect(() => p.parse({ sites: [] })).toThrow();
    expect(() => p.parse({ sites: ["  "] })).toThrow();
    expect(() => p.parse({ sites: "isjac" })).toThrow();
  });

  it("has a description of 80 to 250 words that names its boundary, input, result and effects", () => {
    const words = DESCRIPTION.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toMatch(/NEVER pass/);
    expect(DESCRIPTION).toMatch(/billed/);
  });
});

describe("readmeVersion", () => {
  const cases: [string, string | undefined][] = [
    ["Version 6.4.1", "6.4.1"], ["version  6.4", "6.4"], ["Version 6", undefined], ["Version 6. then", undefined],
    ["Version 6.4. done", "6.4"], ["Version 1.2..3", "1.2"], ["Version 5 and Version 6.1.2", "6.1.2"],
    ["Version x1.2", undefined], ["Stable tag 6.4", undefined], ["Version 10.20.30.40", "10.20.30.40"], ["", undefined],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)} as ${expected}`, () => expect(readmeVersion(text)).toBe(expected));
  }
});

describe("runWithExec", () => {
  it("runs ssh and refuses every other program", async () => {
    const seen: string[] = [];
    const exec = async (command: string) => (seen.push(command), { stdout: "", stderr: "", code: 0, killed: false });
    const run = runWithExec(exec);
    expect((await run("ssh", ["host"])).code).toBe(0);
    await expect(run("sh", ["-c", "id"])).rejects.toThrow("command not allowed: sh");
    expect(seen).toEqual(["ssh"]);
  });
});
