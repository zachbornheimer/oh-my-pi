import { describe, expect, it, vi } from "bun:test";
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
import { withHeartbeat } from "./heartbeat";
import factory from "./index";
import { closedPort, selfSignedLocalhost, serveSilence, serveTls } from "./local_tls";
import { expiryVerdict } from "./rules";
import { DESCRIPTION, makeTool, type Params } from "./tool";

const NOW = "2026-10-27T15:00:00.000Z";
const DAY_MS = 86_400_000;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const edge = (overrides: Record<string, unknown> = {}) => ({
  status: "measured" as const,
  valid_to: at(90 * DAY_MS),
  subject_names: ["example.org", "*.example.org"],
  issuer: "Example CA",
  authorized: true,
  fingerprint256: "AA:BB",
  ...overrides,
});
const endingIn = (days: number) => edge({ valid_to: at(days * DAY_MS) });
const certificate = (edgePart: unknown): SiteCertificate =>
  ({ status: "measured", measured_at: NOW, host: "example.org", edge: edgePart }) as SiteCertificate;
const run = (cert: SiteCertificate | undefined, warn?: number): SecurityCheckResult =>
  answer("example.org", "c", expiryVerdict(cert, warn));
const idsOf = (result: SecurityCheckResult) => result.findings.map((finding) => [finding.id, finding.severity]);

describe("expiryVerdict", () => {
  it("warns 21 days out by default: 18 days left is expiring, medium; 22 passes", () => {
    const result = run(certificate(endingIn(18)));
    expect(idsOf(result)).toEqual([["security.tls.expiry.expiring", "medium"]]);
    expect(result.findings[0]?.evidence).toContain("expires in 18 days");
    expect(run(certificate(endingIn(22)))).toMatchObject({ status: "pass" });
  });

  it("makes 7 days or fewer high", () => {
    expect(run(certificate(endingIn(7))).findings[0]?.severity).toBe("high");
    expect(run(certificate(endingIn(8))).findings[0]?.severity).toBe("medium");
  });

  it("rounds a part day up: 20 days 23 hours left is inside a 21-day warning, 21 days 1 hour is outside", () => {
    expect(run(certificate(edge({ valid_to: at(20 * DAY_MS + 23 * 3_600_000) }))).status).toBe("fail");
    expect(run(certificate(edge({ valid_to: at(21 * DAY_MS + 3_600_000) }))).status).toBe("pass");
  });

  it("titles an ended certificate expired N days ago, never expires in -N days", () => {
    const result = run(certificate(endingIn(-3)));
    expect(idsOf(result)).toEqual([["security.tls.expiry.expired", "high"]]);
    expect(result.findings[0]?.evidence).toContain("expired 3 days ago");
    expect(result.findings[0]?.evidence).not.toMatch(/expires in -/);
  });

  it("calls a certificate that ended hours ago expired, not expiring in 0 days", () => {
    const result = run(certificate(edge({ valid_to: at(-12 * 3_600_000) })));
    expect(idsOf(result)).toEqual([["security.tls.expiry.expired", "high"]]);
    expect(result.findings[0]?.evidence).toContain("expired less than a day ago");
    expect(run(certificate(endingIn(-1))).findings[0]?.evidence).toContain("expired 1 day ago");
  });

  it("takes the warning days from tls_warn_days", () => {
    expect(run(certificate(endingIn(25)), 30)).toMatchObject({ status: "fail" });
    expect(run(certificate(endingIn(25)))).toMatchObject({ status: "pass" });
  });

  it("calls a chain the handshake refused as expired expired, and leaves any other refusal unmeasured", () => {
    const expired = run(certificate({ status: "rejected", authorization_error: "CERT_HAS_EXPIRED" }));
    expect(idsOf(expired)).toEqual([["security.tls.expiry.expired", "high"]]);
    expect(run(certificate({ status: "rejected", authorization_error: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toMatchObject({
      status: "unmeasured",
    });
  });

  it("is unmeasured, never a pass, when no certificate was collected, the handshake failed or the date is unreadable", () => {
    expect(run(undefined)).toMatchObject({ status: "unmeasured" });
    expect(run(certificate({ status: "unmeasured", reason: "example.org:443: ETIMEDOUT" }))).toMatchObject({
      status: "unmeasured",
      reason: "example.org:443: ETIMEDOUT",
    });
    expect(run(certificate(edge({ valid_to: "not a date" })))).toMatchObject({
      status: "unmeasured",
      reason: expect.stringContaining("unreadable"),
    });
  });
});

const CERT: Certificate = {
  valid_to: at(10 * DAY_MS),
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

describe("webmaster_security_tls_expiry tool", () => {
  it("reads the edge certificate for the site's host and judges it", async () => {
    const result = await call(tool({ "www.example.org": CERT }), { site: "https://www.example.org/path" });
    expect(result.details).toMatchObject({
      site: "example.org",
      check: "webmaster.security.tls.expiry",
      status: "fail",
      findings: [{ id: "security.tls.expiry.expiring", severity: "medium" }],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("honours tls_warn_days, a null being the default", async () => {
    const t = tool({ "example.org": CERT });
    expect((await call(t, { site: "example.org", tls_warn_days: 5 })).details.status).toBe("pass");
    expect((await call(t, { site: "example.org", tls_warn_days: null })).details.status).toBe("fail");
  });

  it("is unmeasured, not a throw or a pass, when the connection fails", async () => {
    const result = await call(tool({}), { site: "example.org" });
    expect(result.details).toMatchObject({
      status: "unmeasured",
      reason: "example.org:443: connect ECONNREFUSED example.org:443",
    });
  });

  it("reports an expired chain the handshake refused as expired", async () => {
    const result = await call(tool({ "example.org": "CERT_HAS_EXPIRED" }), { site: "example.org" });
    expect(result.details.findings.map((finding) => finding.id)).toEqual(["security.tls.expiry.expired"]);
  });

  it("fails on an invalid site and on an already-aborted call", async () => {
    await expect(call(tool({}), { site: "http://" })).rejects.toThrow(/site must be a domain/);
    const controller = new AbortController();
    controller.abort();
    await expect(call(tool({}), { site: "example.org" }, controller.signal)).rejects.toThrow();
  });

  it("rethrows a cancellation instead of reporting it as an unmeasured certificate", async () => {
    const controller = new AbortController();
    const slow: CertificateReader = {
      read(_host, _address, signal) {
        const { promise, reject } = Promise.withResolvers<Certificate>();
        signal?.addEventListener("abort", () => reject(new Error("cancelled")));
        return promise;
      },
    };
    const t = makeTool(pi, { reader: slow }) as Tool;
    const pending = call(t, { site: "example.org" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});

describe("withHeartbeat", () => {
  it("sends an update every interval while the work runs, and none after it settles", async () => {
    vi.useFakeTimers();
    try {
      const updates: string[] = [];
      const { promise, resolve } = Promise.withResolvers<string>();
      const running = withHeartbeat((update) => updates.push(update.content[0]!.text), "working", () => promise, 10);
      vi.advanceTimersByTime(25);
      expect(updates.length).toBe(2);
      resolve("done");
      expect(await running).toBe("done");
      vi.advanceTimersByTime(100);
      expect(updates.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

describe("description and factory", () => {
  it("builds a tool named for the capability, discoverable, read-tier, with a dense description", () => {
    const built = factory(pi as unknown as CustomToolAPI) as unknown as Tool;
    expect(built.name).toBe("webmaster_security_tls_expiry");
    expect(built.loadMode).toBe("discoverable");
    expect(built.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
/** A client that reaches the local server whatever name it is asked for, so the name checks run for real. */
const toLocal = (inner: CertificateReader): CertificateReader => ({
  ...(inner.port === undefined ? {} : { port: inner.port }),
  read: (host, _address, signal) => inner.read(host, "127.0.0.1", signal),
});

describe("the TLS client against a local server (no external network)", () => {
  it("reads the certificate of a trusted server and reports the days left", async () => {
    const credentials = selfSignedLocalhost();
    const server = await serveTls(credentials);
    try {
      const tls = toLocal(createCertificateReader({ port: server.port, ca: credentials.cert }));
      const t = makeTool(pi, { reader: tls }) as Tool;
      const watched = await call(t, { site: "localhost", tls_warn_days: 3 });
      expect(watched.details).toMatchObject({
        status: "fail",
        findings: [{ id: "security.tls.expiry.expiring", severity: "high" }], // 2 days left is within 7
      });
      expect((await call(t, { site: "localhost", tls_warn_days: 1 })).details.status).toBe("pass");
      const read = await collectSiteCertificate("localhost", tls);
      expect(read.edge).toMatchObject({ status: "measured", authorized: true, subject_names: ["localhost"] });
    } finally {
      server.close();
    }
  });

  it("keeps a certificate for another name, marked not authorized", async () => {
    const credentials = selfSignedLocalhost();
    const server = await serveTls(credentials);
    try {
      const tls = toLocal(createCertificateReader({ port: server.port, ca: credentials.cert }));
      const read = await collectSiteCertificate("example.org", tls);
      expect(read.edge).toMatchObject({
        status: "measured",
        authorized: false,
        authorization_error: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    } finally {
      server.close();
    }
  });

  it("reports a chain that does not verify as rejected, and the expiry check leaves it unmeasured", async () => {
    const server = await serveTls(selfSignedLocalhost());
    try {
      const tls = toLocal(createCertificateReader({ port: server.port }));
      const read = await collectSiteCertificate("localhost", tls);
      expect(read.edge).toMatchObject({ status: "rejected", authorization_error: "DEPTH_ZERO_SELF_SIGNED_CERT" });
      const result = await call(makeTool(pi, { reader: tls }) as Tool, { site: "localhost" });
      expect(result.details.status).toBe("unmeasured");
    } finally {
      server.close();
    }
  });

  it("reports a refused connection as unmeasured with the port", async () => {
    const tls = toLocal(createCertificateReader({ port: await closedPort() }));
    const read = await collectSiteCertificate("localhost", tls);
    expect(read.edge).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("ECONNREFUSED") });
  });

  it("gives up on a server that never answers the handshake, and stops when cancelled", async () => {
    const server = await serveSilence();
    try {
      // Real sockets: a stalled handshake can only be ended by the client's own timeout or an abort.
      const slow = toLocal(createCertificateReader({ port: server.port, timeoutMs: 50 }));
      const read = await collectSiteCertificate("localhost", slow);
      expect(read.edge).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("no TLS answer within 50 ms") });
      const controller = new AbortController();
      const patient = toLocal(createCertificateReader({ port: server.port, timeoutMs: 60_000 }));
      const pending = collectSiteCertificate("localhost", patient, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
    } finally {
      server.close();
    }
  });
});
