import { describe, expect, it } from "bun:test";
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";
import {
  type Certificate,
  type CertificatePart,
  type CertificateReader,
  CertificateRejected,
  collectSiteCertificate,
  createCertificateReader,
  type SiteCertificate,
} from "./certificate";
import { answer, type CheckTool, type SecurityCheckResult } from "./check";
import factory from "./index";
import { selfSignedLocalhost, serveTls } from "./local_tls";
import { NO_ORIGIN_REASON, originVerdict } from "./rules";
import { DESCRIPTION, makeTool, originHost, type Params } from "./tool";

const NOW = "2026-10-27T15:00:00.000Z";
const DAY_MS = 86_400_000;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const part = (overrides: Record<string, unknown> = {}): CertificatePart =>
  ({
    status: "measured",
    valid_to: at(90 * DAY_MS),
    subject_names: ["example.org", "*.example.org"],
    issuer: "Example CA",
    authorized: true,
    fingerprint256: "AA:BB",
    ...overrides,
  }) as CertificatePart;
const certificate = (origin?: CertificatePart): SiteCertificate => ({
  status: "measured",
  measured_at: NOW,
  host: "example.org",
  edge: part(),
  ...(origin === undefined ? {} : { origin }),
});
const run = (cert: SiteCertificate | undefined, warn?: number): SecurityCheckResult =>
  answer("example.org", "c", originVerdict(cert, warn));
const idsOf = (result: SecurityCheckResult) => result.findings.map((finding) => [finding.id, finding.severity]);

describe("originVerdict", () => {
  it("flags an origin certificate for another name that has expired, with both problems", () => {
    const origin = part({ subject_names: ["origin.example.net"], valid_to: at(-7 * DAY_MS) });
    const result = run(certificate(origin));
    expect(idsOf(result)).toEqual([["security.tls.origin_mismatch", "medium"]]);
    expect(result.findings[0]?.evidence).toContain("origin.example.net");
    expect(result.findings[0]?.evidence).toContain("expired 7 days ago");
  });

  it("flags an origin that ended hours ago as expired, not expiring in 0 days", () => {
    const result = run(certificate(part({ valid_to: at(-3_600_000) })));
    expect(result.findings[0]?.evidence).toContain("expired less than a day ago");
  });

  it("flags an origin ending within the warning days, from tls_warn_days, and one with an unreadable date", () => {
    const soon = certificate(part({ valid_to: at(10 * DAY_MS) }));
    expect(run(soon).findings[0]?.evidence).toContain("it expires in 10 days");
    expect(run(soon, 5)).toMatchObject({ status: "pass" });
    expect(run(certificate(part({ valid_to: "nope" }))).findings[0]?.evidence).toContain("end date is unreadable");
  });

  it("flags an origin chain the handshake refused, and passes a matching one", () => {
    const refused: CertificatePart = { status: "rejected", authorization_error: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
    expect(run(certificate(refused))).toMatchObject({ status: "fail" });
    expect(run(certificate(part()))).toMatchObject({ status: "pass" });
  });

  it("is unmeasured when no origin was named, the origin connection failed, or nothing was collected", () => {
    expect(run(certificate())).toMatchObject({ status: "unmeasured", reason: NO_ORIGIN_REASON });
    expect(run(certificate({ status: "unmeasured", reason: "203.0.113.7:443: ETIMEDOUT" }))).toMatchObject({
      status: "unmeasured",
      reason: "203.0.113.7:443: ETIMEDOUT",
    });
    expect(run(undefined)).toMatchObject({ status: "unmeasured" });
  });
});

const CERT: Certificate = {
  valid_to: at(90 * DAY_MS),
  subject_names: ["example.org"],
  issuer: "Example CA",
  authorized: true,
  fingerprint256: "AB:CD",
};

type Answers = Record<string, Certificate | string | Error>;

/** A synthetic TLS client keyed by `address` (the origin); a string is a refused chain. Records every connection. */
function reader(answers: Answers): CertificateReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async read(host, address) {
      asked.push(address === undefined ? host : `${host}@${address}`);
      const found = answers[address ?? host];
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
const toolWith = (tls: CertificateReader): Tool => makeTool(pi, { reader: tls, now: () => new Date(NOW) }) as Tool;
const call = (t: Tool, params: Params, signal?: AbortSignal) => t.execute("id", params, undefined, undefined, signal);

describe("webmaster_security_tls_origin_mismatch tool", () => {
  it("connects to the origin for the site's name and never to the site itself", async () => {
    const tls = reader({ "203.0.113.7": CERT });
    const result = await call(toolWith(tls), { site: "https://www.example.org/", origin: "203.0.113.7" });
    expect(tls.asked).toEqual(["www.example.org@203.0.113.7"]);
    expect(result.details).toMatchObject({
      site: "example.org",
      check: "webmaster.security.tls.origin_mismatch",
      status: "fail",
      findings: [{ id: "security.tls.origin_mismatch", severity: "medium" }], // names example.org, not www.example.org
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("passes a valid origin and honours tls_warn_days, a null being the default", async () => {
    const soon: Certificate = { ...CERT, valid_to: at(10 * DAY_MS) };
    const t = toolWith(reader({ "origin.example.net": soon }));
    expect((await call(t, { site: "example.org", origin: "origin.example.net", tls_warn_days: 5 })).details.status).toBe("pass");
    expect((await call(t, { site: "example.org", origin: "origin.example.net", tls_warn_days: null })).details.status).toBe("fail");
  });

  it("makes no connection and answers unmeasured when no origin is named", async () => {
    const tls = reader({});
    for (const origin of [undefined, null, "  "]) {
      const result = await call(toolWith(tls), { site: "example.org", origin });
      expect(result.details).toMatchObject({ status: "unmeasured", reason: NO_ORIGIN_REASON });
    }
    expect(tls.asked).toEqual([]);
  });

  it("is unmeasured, not a throw or a pass, when the origin connection fails; a refused chain is a finding", async () => {
    expect((await call(toolWith(reader({})), { site: "example.org", origin: "203.0.113.9" })).details).toMatchObject({
      status: "unmeasured",
      reason: "203.0.113.9:443: connect ECONNREFUSED 203.0.113.9:443",
    });
    const refused = reader({ "203.0.113.9": "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect((await call(toolWith(refused), { site: "example.org", origin: "203.0.113.9" })).details.status).toBe("fail");
  });

  it("reduces an origin given as an address to its host, and rejects an unparseable one", async () => {
    expect(originHost("https://203.0.113.7:8443/x")).toBe("203.0.113.7");
    expect(originHost(" origin.example.net ")).toBe("origin.example.net");
    expect(() => originHost("https://")).toThrow(/origin must be/);
  });

  it("fails on an invalid site and on an already-aborted call", async () => {
    await expect(call(toolWith(reader({})), { site: "http://", origin: "203.0.113.7" })).rejects.toThrow(/site must be a domain/);
    const controller = new AbortController();
    controller.abort();
    await expect(call(toolWith(reader({})), { site: "example.org", origin: "203.0.113.7" }, controller.signal)).rejects.toThrow();
  });
});

describe("collectSiteCertificate", () => {
  it("keeps a refused origin chain as data and reads only the origin when asked", async () => {
    const tls = reader({ "203.0.113.7": "CERT_HAS_EXPIRED" });
    const collected = await collectSiteCertificate("example.org", tls, { origin: "203.0.113.7", readEdge: false });
    expect(collected.origin).toMatchObject({ status: "rejected", authorization_error: "CERT_HAS_EXPIRED" });
    expect(collected.edge).toMatchObject({ status: "unmeasured" });
    expect(tls.asked).toEqual(["example.org@203.0.113.7"]);
  });
});

describe("the TLS client against a local server (no external network)", () => {
  it("reads the origin's certificate by address, presenting the site's name, end to end", async () => {
    const credentials = selfSignedLocalhost();
    const server = await serveTls(credentials);
    try {
      const tls = createCertificateReader({ port: server.port, ca: credentials.cert });
      const t = toolWith(tls);
      expect((await call(t, { site: "localhost", origin: "127.0.0.1", tls_warn_days: 1 })).details.status).toBe("pass");
      const other = await call(t, { site: "example.org", origin: "127.0.0.1" });
      expect(other.details.status).toBe("fail");
      expect(other.details.findings[0]?.evidence).toContain("covers localhost, not example.org");
      const untrusted = toolWith(createCertificateReader({ port: server.port }));
      const rejected = await call(untrusted, { site: "localhost", origin: "127.0.0.1" });
      expect(rejected.details.findings[0]?.evidence).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
    } finally {
      server.close();
    }
  });
});

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_tls_origin_mismatch");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
