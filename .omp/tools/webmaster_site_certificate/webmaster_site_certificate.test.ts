import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import { fileURLToPath } from "node:url";
import {
  type Certificate,
  type CertificateReader,
  CertificateRejected,
  certificateReaderOnPort,
  collectSiteCertificate,
  hostOf,
  originAddress,
} from "./certificate.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";

/** omp's own `pi.zod` (omptype): the fork's package when this directory sits in `.omp/tools/`, else the local checkout. */
async function loadZod(): Promise<unknown> {
  const candidates = [
    fileURLToPath(new URL("../../../packages/omptype/src/zod.ts", import.meta.url)),
    join(homedir(), "Developer/Personal/oh-my-pi/packages/omptype/src/zod.ts"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`omptype zod.ts not found in: ${candidates.join(", ")}`);
  return (await import(found)) as unknown;
}

const CERTIFICATE: Certificate = {
  valid_to: "2027-01-01T00:00:00.000Z",
  subject_names: ["example.org", "www.example.org"],
  issuer: "Example CA",
  authorized: true,
  fingerprint256: "AB:CD",
};
const NOW = new Date("2026-10-27T15:00:00.000Z");

/** A synthetic TLS client: what each `host` or `host@address` answers, a string being a refused chain. */
function reader(answers: Record<string, Certificate | string | Error>): CertificateReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async read(host, address) {
      const key = address === undefined ? host : `${host}@${address}`;
      asked.push(key);
      const answer = answers[key];
      if (answer === undefined) throw new Error(`connect ECONNREFUSED ${address ?? host}:443`);
      if (answer instanceof Error) throw answer;
      if (typeof answer === "string") throw new CertificateRejected(answer);
      return answer;
    },
  };
}

describe("the certificate collection", () => {
  it("records the edge certificate as read, with the clock's time", async () => {
    expect(
      await collectSiteCertificate("https://www.example.org/path", reader({ "www.example.org": CERTIFICATE }), {
        now: () => NOW,
      }),
    ).toEqual({
      status: "measured",
      measured_at: "2026-10-27T15:00:00.000Z",
      host: "www.example.org",
      edge: { status: "measured", ...CERTIFICATE },
    });
  });

  it("reads the origin's certificate for the same name only when an origin is named", async () => {
    const tls = reader({ "example.org": CERTIFICATE, "example.org@203.0.113.7": "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const without = await collectSiteCertificate("example.org", tls);
    expect(without).not.toHaveProperty("origin");
    expect(tls.asked).toEqual(["example.org"]);
    const withOrigin = await collectSiteCertificate("example.org", tls, { origin: "203.0.113.7" });
    expect(withOrigin).toMatchObject({
      origin: { status: "rejected", authorization_error: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    });
  });

  it("keeps a refused chain as rejected and any other failure as unmeasured, never as an exception", async () => {
    const refused = await collectSiteCertificate("example.org", reader({ "example.org": "CERT_HAS_EXPIRED" }));
    expect(refused).toMatchObject({ edge: { status: "rejected", authorization_error: "CERT_HAS_EXPIRED" } });
    const down = await collectSiteCertificate("example.org", reader({}));
    expect(down).toMatchObject({
      edge: { status: "unmeasured", reason: "example.org:443: connect ECONNREFUSED example.org:443" },
    });
  });

  it("keeps a certificate for another name, marked not authorized, with the reason", async () => {
    const wrongName = { ...CERTIFICATE, authorized: false, authorization_error: "ERR_TLS_CERT_ALTNAME_INVALID" };
    const certificate = await collectSiteCertificate("example.org", reader({ "example.org": wrongName }));
    expect(certificate).toMatchObject({
      edge: { status: "measured", authorized: false, authorization_error: "ERR_TLS_CERT_ALTNAME_INVALID" },
    });
  });

  it("names the host from a domain or an address", () => {
    expect(["Example.ORG", "https://example.org:8443/x", "example.org."].map(hostOf)).toEqual(
      Array(3).fill("example.org"),
    );
  });

  it("refuses text that is not a host", () => {
    expect(() => hostOf("exa mple.org")).toThrow(/not a domain or address/);
  });

  it("normalises an origin to a bare host or IP", () => {
    expect(originAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(originAddress("https://origin.example.net/")).toBe("origin.example.net");
    expect(originAddress("origin.example.net:8443")).toBe("origin.example.net");
    expect(originAddress("2001:db8::1")).toBe("2001:db8::1");
  });

  it("stops when cancelled instead of recording the cancellation as data", async () => {
    const controller = new AbortController();
    const slow: CertificateReader = {
      read: (_host, _address, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")))),
    };
    const pending = collectSiteCertificate("example.org", slow, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("a real handshake against a local TLS server", () => {
  let dir: string;
  let server: Server;
  let port: number;
  let certPem: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wm-cert-test-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
        "-days", "30", "-subj", "/CN=example.org/O=Test CA", "-addext",
        "subjectAltName=DNS:example.org,DNS:www.example.org",
      ],
      { stdio: "ignore" },
    );
    certPem = readFileSync(join(dir, "c.pem"), "utf8");
    server = createServer({ key: readFileSync(join(dir, "k.pem")), cert: certPem }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a trusted certificate that covers the name", async () => {
    const result = await collectSiteCertificate("example.org", certificateReaderOnPort(port, certPem), {
      origin: "127.0.0.1",
    });
    expect(result.origin).toMatchObject({
      status: "measured",
      authorized: true,
      issuer: "Test CA",
      subject_names: ["example.org", "www.example.org"],
    });
    expect((result.origin as Certificate).fingerprint256).toMatch(/^[0-9A-F:]+$/);
  });

  it("still reads a certificate for the wrong name and records why it does not match", async () => {
    const result = await collectSiteCertificate("other.example", certificateReaderOnPort(port, certPem), {
      origin: "127.0.0.1",
    });
    expect(result.origin).toMatchObject({ status: "measured", authorized: false });
    expect((result.origin as Certificate).authorization_error).toBeTruthy();
  });

  it("reports an untrusted chain as rejected with the verification error", async () => {
    const result = await collectSiteCertificate("example.org", certificateReaderOnPort(port), {
      origin: "127.0.0.1",
    });
    expect(result.origin).toEqual({ status: "rejected", authorization_error: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  });

  it("records a refused connection as unmeasured", async () => {
    const dead = createServer({});
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const closedPort = (dead.address() as { port: number }).port;
    dead.close();
    const result = await collectSiteCertificate("example.org", certificateReaderOnPort(closedPort), {
      origin: "127.0.0.1",
    });
    expect(result.origin).toMatchObject({ status: "unmeasured" });
  });
});

describe("the tool", () => {
  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const zod = (await loadZod()) as { z: unknown };
    const tool = makeTool({ zod: zod.z, cwd: "." } as never, {
      reader: reader({ "example.org": CERTIFICATE }),
      now: () => NOW,
    });
    expect(tool.name).toBe("webmaster_site_certificate");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", origin: null }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", origin: "203.0.113.7" }).success).toBe(true);
    expect(schema.safeParse({ site: 5 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("returns the certificates as details and as text, and treats a null origin as none", async () => {
    const zod = (await loadZod()) as { z: unknown };
    const tls = reader({ "example.org": CERTIFICATE, "example.org@203.0.113.7": CERTIFICATE });
    const tool = makeTool({ zod: zod.z, cwd: "." } as never, { reader: tls, now: () => NOW });
    const none = await tool.execute("id", { site: "https://Example.org/x", origin: null }, undefined, undefined);
    expect(none.details).toEqual({
      site: "example.org",
      certificate: {
        status: "measured",
        measured_at: "2026-10-27T15:00:00.000Z",
        host: "example.org",
        edge: { status: "measured", ...CERTIFICATE },
      },
    });
    expect(JSON.parse(none.content[0]!.text)).toEqual(none.details);
    expect(tls.asked).toEqual(["example.org"]);
    const both = await tool.execute("id", { site: "example.org", origin: "https://203.0.113.7/" }, undefined, undefined);
    expect(both.details.certificate.origin).toMatchObject({ status: "measured" });
  });

  it("fails on a site that is not a host instead of returning a success", async () => {
    const zod = (await loadZod()) as { z: unknown };
    const tool = makeTool({ zod: zod.z, cwd: "." } as never, { reader: reader({}) });
    await expect(tool.execute("id", { site: "not a host" }, undefined, undefined)).rejects.toThrow(
      /not a domain or address/,
    );
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("never says whether");
  });
});
