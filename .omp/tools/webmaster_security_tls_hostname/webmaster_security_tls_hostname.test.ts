import { describe, expect, it } from "bun:test";
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import {
  type Certificate,
  type CertificateReader,
  CertificateRejected,
  collectSiteCertificate,
  createCertificateReader,
  type SiteCertificate,
} from "./certificate";
import { answer, type CheckTool, type SecurityCheckResult } from "./check";
import factory from "./index";
import { selfSignedLocalhost, serveTls } from "./local_tls";
import { hostnameVerdict } from "./rules";
import { covers } from "./tls_common";
import { DESCRIPTION, makeTool, type Params } from "./tool";

const NOW = "2026-10-27T15:00:00.000Z";
const DAY_MS = 86_400_000;

const edge = (overrides: Record<string, unknown> = {}) => ({
  status: "measured" as const,
  valid_to: new Date(Date.parse(NOW) + 90 * DAY_MS).toISOString(),
  subject_names: ["example.org", "*.example.org"],
  issuer: "Example CA",
  authorized: true,
  fingerprint256: "AA:BB",
  ...overrides,
});
const certificate = (edgePart: unknown): SiteCertificate =>
  ({ status: "measured", measured_at: NOW, host: "example.org", edge: edgePart }) as SiteCertificate;
const run = (cert: SiteCertificate | undefined): SecurityCheckResult => answer("example.org", "c", hostnameVerdict(cert));
const idsOf = (result: SecurityCheckResult) => result.findings.map((finding) => [finding.id, finding.severity]);

describe("hostnameVerdict", () => {
  it("flags a certificate that does not name the host", () => {
    const result = run(certificate(edge({ subject_names: ["other.example.com"] })));
    expect(idsOf(result)).toEqual([["security.tls.hostname", "high"]]);
    expect(result.findings[0]?.evidence).toContain("covers other.example.com, not example.org");
  });

  it("accepts the exact name, and a wildcard one label deep only", () => {
    expect(run(certificate(edge({ subject_names: ["example.org"] })))).toMatchObject({ status: "pass" });
    expect(covers(["*.example.org"], "www.example.org")).toBe(true);
    expect(covers(["*.example.org"], "a.b.example.org")).toBe(false);
    expect(covers(["*.example.org"], "example.org")).toBe(false);
    expect(covers(["*.example.org"], ".example.org")).toBe(false);
    expect(covers(["Example.ORG"], "EXAMPLE.org")).toBe(true);
  });

  it("flags a certificate with no DNS names, saying so", () => {
    const result = run(certificate(edge({ subject_names: [] })));
    expect(result.findings[0]?.evidence).toContain("covers no DNS names, not example.org");
  });

  it("is unmeasured when the handshake refused the chain, failed, or nothing was collected", () => {
    expect(run(certificate({ status: "rejected", authorization_error: "CERT_HAS_EXPIRED" }))).toMatchObject({
      status: "unmeasured",
      reason: expect.stringContaining("CERT_HAS_EXPIRED"),
    });
    expect(run(certificate({ status: "unmeasured", reason: "example.org:443: ETIMEDOUT" }))).toMatchObject({
      status: "unmeasured",
      reason: "example.org:443: ETIMEDOUT",
    });
    expect(run(undefined)).toMatchObject({ status: "unmeasured" });
  });
});

const CERT: Certificate = {
  valid_to: new Date(Date.parse(NOW) + 90 * DAY_MS).toISOString(),
  subject_names: ["example.org"],
  issuer: "Example CA",
  authorized: true,
  fingerprint256: "AB:CD",
};

type Answers = Record<string, Certificate | string | Error>;

/** A synthetic TLS client: what each `host` answers, a string being a refused chain. */
function reader(answers: Answers): CertificateReader {
  return {
    async read(host, address) {
      const found = answers[host];
      if (found === undefined) throw new Error(`connect ECONNREFUSED ${address ?? host}:443`);
      if (found instanceof Error) throw found;
      if (typeof found === "string") throw new CertificateRejected(found);
      return found;
    },
  };
}

/** A stand-in for omp's `pi.zod`: every builder call returns the same chainable no-op (the real one is load-checked apart). */
const chain: unknown = new Proxy(() => undefined, { get: () => chain, apply: () => chain });
const pi = { zod: chain } as unknown as Pick<CustomToolAPI, "zod">;

type Tool = CheckTool<Params, unknown>;
const tool = (answers: Answers): Tool => makeTool(pi, { reader: reader(answers), now: () => new Date(NOW) }) as Tool;
const call = (t: Tool, params: Params, signal?: AbortSignal) => t.execute("id", params, undefined, undefined, signal);

describe("webmaster_security_tls_hostname tool", () => {
  it("asks for the host as given, `www.` included, and judges the names it gets", async () => {
    const result = await call(tool({ "www.example.org": CERT }), { site: "https://www.example.org/path" });
    expect(result.details).toMatchObject({
      site: "example.org",
      check: "webmaster.security.tls.hostname",
      status: "fail",
      findings: [{ id: "security.tls.hostname", severity: "high" }],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    expect((await call(tool({ "example.org": CERT }), { site: "example.org" })).details.status).toBe("pass");
  });

  it("is unmeasured, not a throw or a pass, when the connection fails or the chain is refused", async () => {
    expect((await call(tool({}), { site: "example.org" })).details).toMatchObject({
      status: "unmeasured",
      reason: "example.org:443: connect ECONNREFUSED example.org:443",
    });
    expect((await call(tool({ "example.org": "DEPTH_ZERO_SELF_SIGNED_CERT" }), { site: "example.org" })).details.status)
      .toBe("unmeasured");
  });

  it("fails on an invalid site and on an already-aborted call", async () => {
    await expect(call(tool({}), { site: "http://" })).rejects.toThrow(/site must be a domain/);
    const controller = new AbortController();
    controller.abort();
    await expect(call(tool({}), { site: "example.org" }, controller.signal)).rejects.toThrow();
  });
});

describe("collectSiteCertificate", () => {
  it("keeps a refused chain and a failed connection as data", async () => {
    const refused = await collectSiteCertificate("example.org", reader({ "example.org": "CERT_HAS_EXPIRED" }));
    expect(refused).toMatchObject({ edge: { status: "rejected", authorization_error: "CERT_HAS_EXPIRED" } });
    const down = await collectSiteCertificate("example.org", reader({}));
    expect(down).toMatchObject({
      edge: { status: "unmeasured", reason: "example.org:443: connect ECONNREFUSED example.org:443" },
    });
  });
});

/** A client that reaches the local server whatever name it is asked for, so the name checks run for real. */
const toLocal = (inner: CertificateReader): CertificateReader => ({
  ...(inner.port === undefined ? {} : { port: inner.port }),
  read: (host, _address, signal) => inner.read(host, "127.0.0.1", signal),
});

describe("the TLS client against a local server (no external network)", () => {
  it("passes the name the certificate carries and flags any other, end to end", async () => {
    const credentials = selfSignedLocalhost();
    const server = await serveTls(credentials);
    try {
      const t = makeTool(pi, { reader: toLocal(createCertificateReader({ port: server.port, ca: credentials.cert })) }) as Tool;
      expect((await call(t, { site: "localhost" })).details.status).toBe("pass");
      const other = await call(t, { site: "example.org" });
      expect(other.details.findings.map((finding) => finding.id)).toEqual(["security.tls.hostname"]);
      expect(other.details.findings[0]?.evidence).toContain("covers localhost, not example.org");
    } finally {
      server.close();
    }
  });
});

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_tls_hostname");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
