import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSecurityNet } from "./fake_net.ts";
import {
  apexOf,
  assertReadableUrl,
  isPublicAddress,
  makeSecurityNet,
  publicGet,
  publicRequest,
  redactSecrets,
  siteUrlOf,
} from "./net.ts";
import {
  DROP_PATHS,
  EXPOSURE_PATHS,
  exposureSignature,
  measurePublicFiles,
  validatedExposurePaths,
} from "./public_files.ts";
import { siteContextForAddress, siteContextFrom } from "./site_context.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { loadZod } from "./zod_for_tests.ts";

const SITE = "https://example.org";

describe("the public files collection", () => {
  it("asks every exposure path and drop page with GET only", async () => {
    const net = new FakeSecurityNet();
    await measurePublicFiles({ siteUrl: SITE }, net);
    expect(net.sent.map((request) => request.method)).toEqual(net.sent.map(() => "GET"));
    expect(net.sent.map((request) => new URL(request.url).pathname)).toEqual([...EXPOSURE_PATHS, ...DROP_PATHS]);
  });

  it("keeps a label of what an exposed path served, never its content", async () => {
    const net = new FakeSecurityNet({
      http: {
        [`${SITE}/wp-config.php.bak`]: {
          status: 200,
          contentType: "text/plain",
          body: "<?php define('DB_PASSWORD', 'hunter2');",
        },
        [`${SITE}/0x.html`]: {
          status: 200,
          contentType: "text/html",
          body: "<h1>Hacked By someone</h1> password=hunter2",
        },
      },
    });
    const files = await measurePublicFiles({ siteUrl: SITE }, net);
    expect(JSON.stringify(files)).not.toContain("hunter2");
    if (files.status !== "measured") throw new Error("expected a measurement");
    expect(files.files.find((file) => file.path === "/wp-config.php.bak")).toMatchObject({
      purpose: "exposure",
      status: 200,
      exposed: "PHP source",
      body: "",
    });
    expect(files.files.find((file) => file.path === "/0x.html")?.body).toContain("Hacked By someone");
  });

  it("asks the extra paths the caller names too", async () => {
    const net = new FakeSecurityNet();
    await measurePublicFiles({ siteUrl: SITE, exposurePaths: ["/private-export/"] }, net);
    expect(net.sent.map((request) => new URL(request.url).pathname)).toContain("/private-export/");
  });

  it("is unmeasured when the site answers nothing at all", async () => {
    const net = new FakeSecurityNet({
      http: Object.fromEntries([...EXPOSURE_PATHS, ...DROP_PATHS].map((path) => [`${SITE}${path}`, new Error("ENOTFOUND")])),
    });
    expect(await measurePublicFiles({ siteUrl: SITE }, net)).toEqual({
      status: "unmeasured",
      reason: `${SITE} did not answer: ENOTFOUND`,
    });
  });

  it("stops when cancelled instead of recording the cancellation as an unanswered path", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(measurePublicFiles({ siteUrl: SITE }, new FakeSecurityNet(), controller.signal)).rejects.toThrow();
  });
});

describe("exposure signatures", () => {
  const sig = (path: string, contentType: string, body: string) => exposureSignature(path, { status: 200, contentType, body });
  it("labels each kind of exposed content", () => {
    expect(sig("/backups/", "text/html", "<title>Index of /backups</title>")).toBe("directory listing");
    expect(sig("/.git/HEAD", "text/plain", "ref: refs/heads/main\n")).toBe("git metadata");
    expect(sig("/x", "text/plain", "<?php echo 1;")).toBe("PHP source");
    expect(sig("/phpinfo.php", "text/html", "<title>phpinfo()</title>")).toBe("PHP configuration page");
    expect(sig("/.env", "text/plain", "APP_ENV=prod\nAPP_KEY=abc\n")).toBe("environment file");
    expect(sig("/.env", "text/plain", "DB_USER=root\n")).toBe("credentials");
    expect(sig("/backup.sql", "text/plain", "-- MySQL dump 10.13")).toBe("database dump");
    expect(sig("/wp-content/debug.log", "text/plain", "[x] PHP Fatal error: boom")).toBe("debug log");
    expect(sig("/backup.zip", "application/zip", "PK\u0003\u0004zz")).toBe("archive");
    expect(sig("/backup.tar.gz", "application/gzip", "binary")).toBe("archive");
  });
  it("labels nothing for an ordinary page", () => {
    expect(sig("/dev/", "text/html", "<html><body>Welcome</body></html>")).toBeUndefined();
  });
  it("does not call an HTML page an environment file even when it has KEY=VALUE lines", () => {
    expect(sig("/.env", "text/html", "<html>\nA=1\nB=2\n</html>")).toBeUndefined();
  });
});

describe("extra exposure paths", () => {
  it("accepts site paths and refuses anything that could leave the site", () => {
    expect(validatedExposurePaths(["/a", "/a", "/b/c?d=1"])).toEqual(["/a", "/b/c?d=1"]);
    for (const bad of ["a", "//evil.example/x", "http://evil.example/", "/a b", "/a\\b", ""]) {
      expect(() => validatedExposurePaths([bad])).toThrow(/must be a path of the site/);
    }
    expect(() => validatedExposurePaths(Array.from({ length: 51 }, (_, index) => `/p${index}`))).toThrow(/at most 50/);
  });
});

describe("addresses and redaction", () => {
  it("knows which literal addresses are public", () => {
    for (const ok of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) expect(isPublicAddress(ok)).toBe(true);
    for (const bad of [
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "not-an-ip",
    ]) {
      expect(isPublicAddress(bad)).toBe(false);
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("refuses an address that is not plain http(s) or carries credentials or a private literal", () => {
    expect(() => assertReadableUrl("ftp://example.org/")).toThrow(/not read/);
    expect(() => assertReadableUrl("https://user:pw@example.org/")).toThrow(/credentials/);
    expect(() => assertReadableUrl("http://127.0.0.1/")).toThrow(/non-public/);
    expect(() => assertReadableUrl("http://[::ffff:7f00:1]/")).toThrow(/non-public/);
    expect(assertReadableUrl("https://example.org/x").hostname).toBe("example.org");
  });

  it("redacts secret-looking values", () => {
    const redacted = redactSecrets("DB_PASSWORD=hunter2\ndefine('AUTH_KEY', 'abc123');\n\"api_token\": \"zzz\"");
    expect(redacted).not.toMatch(/hunter2|abc123|zzz/);
    expect(redacted).toContain("REDACTED");
  });

  it("names the origin and the apex of a site", () => {
    expect(siteUrlOf("example.org")).toBe("https://example.org");
    expect(siteUrlOf("http://www.Example.org:8080/x")).toBe("http://www.example.org:8080");
    expect(apexOf("https://WWW.example.org/x")).toBe("example.org");
    expect(() => siteUrlOf("exa mple")).toThrow(/not a domain or address/);
  });
});

describe("the real network, against a local server", () => {
  let server: Server;
  let base: string;
  const allowAll = () => true;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
      } else if (path === "/final") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("final body");
      } else if (path === "/loop") {
        response.writeHead(302, { location: "/loop" });
        response.end();
      } else if (path === "/big") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(500_000));
      } else if (path === "/echo") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json", "x-method": request.method ?? "" });
          response.end(body);
        });
      } else {
        response.writeHead(200, { "content-type": "text/html", "x-multi": "a" });
        response.end("home");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const options = { headers: {}, timeoutMs: 5000, bodyCap: 1000, allowed: allowAll } as const;

  it("refuses loopback by default (the address policy), without sending anything", async () => {
    await expect(publicRequest(`${base}/`, { ...options, allowed: undefined, method: "GET" })).rejects.toThrow(/non-public/);
    await expect(makeSecurityNet().request("GET", `${base}/`)).rejects.toThrow(/non-public/);
    // A name that resolves to loopback is refused in the socket's own lookup.
    const port = new URL(base).port;
    await expect(makeSecurityNet().request("GET", `http://localhost:${port}/`)).rejects.toThrow(/non-public|EACCES/);
  });

  it("reports a redirect without following it, then follows it in publicGet", async () => {
    const hop = await publicRequest(`${base}/redirect`, { ...options, method: "GET" });
    expect(hop).toMatchObject({ status: 302, location: `${base}/final` });
    expect(await publicGet(`${base}/redirect`, options)).toMatchObject({ status: 200, body: "final body" });
  });

  it("stops a redirect loop", async () => {
    await expect(publicGet(`${base}/loop`, options)).rejects.toThrow(/more than 5 redirects/);
  });

  it("caps the body it keeps and does not read past it", async () => {
    const answer = await publicRequest(`${base}/big`, { ...options, method: "GET" });
    expect(answer.body.length).toBeLessThanOrEqual(1000);
    expect(answer.status).toBe(200);
  });

  it("sends HEAD without a body and POST with the given body", async () => {
    const head = await publicRequest(`${base}/echo`, { ...options, method: "HEAD" });
    expect(head).toMatchObject({ status: 200, body: "" });
    expect(head.headers["x-method"]).toBe("HEAD");
    const post = await publicRequest(`${base}/echo`, { ...options, method: "POST", requestBody: '{"requests":[]}' });
    expect(post.body).toBe('{"requests":[]}');
  });

  it("the security net records what it read, and a cancelled request throws", async () => {
    const net = makeSecurityNet(allowAll);
    expect(await net.request("GET", `${base}/final`)).toMatchObject({ status: 200, contentType: "text/plain", body: "final body" });
    const controller = new AbortController();
    controller.abort();
    await expect(net.request("GET", `${base}/final`, undefined, controller.signal)).rejects.toThrow();
  });
});

describe("site files", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wm-sites-"));
    writeFileSync(
      join(directory, "example.yaml"),
      "name: example\nurl: https://www.example.org\nsecurity:\n  exposure_paths: [/private-export/]\n  hostnames: [shop.example.org]\nuptime:\n  aliases: [https://alias.example.org/]\n",
    );
    writeFileSync(join(directory, "broken.yaml"), "just: text\n");
    writeFileSync(join(directory, "notes.txt"), "ignore me");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("finds the site file whose address has the same host, with or without www", async () => {
    for (const site of ["example.org", "https://www.example.org/x", "WWW.example.org"]) {
      const context = await siteContextForAddress(site, directory);
      expect(context).toMatchObject({ name: "example", host: "www.example.org", probe_paths: ["/"] });
      expect(context?.security).toMatchObject({
        exposure_paths: ["/private-export/"],
        hostnames: ["shop.example.org", "alias.example.org"],
      });
    }
    expect(await siteContextForAddress("example.net", directory)).toBeUndefined();
    expect(await siteContextForAddress("example.net", join(directory, "missing"))).toBeUndefined();
  });

  it("refuses a file that is not a site file, but ignores a malformed security block", () => {
    expect(() => siteContextFrom("just: text", "x", "x.yaml")).toThrow(/x.yaml is not a webmaster site file/);
    expect(siteContextFrom("url: https://a.example\nsecurity: nonsense\n", "a", "a.yaml").security).toBeUndefined();
    expect(() => siteContextFrom("url: https://a.example\nprobes:\n  paths: 3\n", "a", "a.yaml")).toThrow(/paths/);
  });
});

describe("the tool", () => {
  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net: new FakeSecurityNet() });
    expect(tool.name).toBe("webmaster_site_public_files");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", exposure_paths: null }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", exposure_paths: ["/x"] }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", exposure_paths: "/x" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("takes extra paths from the site file when the caller gives none, and the caller's own when given", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wm-sites-"));
    try {
      writeFileSync(join(directory, "example.yaml"), "name: example\nurl: https://www.example.org\nsecurity:\n  exposure_paths: [/private-export/]\n");
      const zod = await loadZod();
      const fromFile = new FakeSecurityNet();
      const tool = makeTool({ zod, cwd: "." } as never, { net: fromFile, sitesDirectory: directory });
      const result = await tool.execute("id", { site: "example.org" }, undefined, undefined);
      expect(result.details.site).toBe("example.org");
      expect(result.details.public_files.status).toBe("measured");
      expect(fromFile.sent.map((r) => new URL(r.url).pathname)).toContain("/private-export/");
      expect(fromFile.sent.every((r) => r.method === "GET")).toBe(true);
      const given = new FakeSecurityNet();
      await makeTool({ zod, cwd: "." } as never, { net: given, sitesDirectory: directory }).execute(
        "id", { site: "example.org", exposure_paths: ["/mine"] }, undefined, undefined,
      );
      const paths = given.sent.map((r) => new URL(r.url).pathname);
      expect(paths).toContain("/mine");
      expect(paths).not.toContain("/private-export/");
      const none = new FakeSecurityNet();
      await makeTool({ zod, cwd: "." } as never, { net: none, sitesDirectory: directory }).execute(
        "id", { site: "example.org", exposure_paths: [] }, undefined, undefined,
      );
      expect(none.sent.map((r) => new URL(r.url).pathname)).not.toContain("/private-export/");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is unmeasured, not an error, for a site that does not answer; refuses a bad site or path", async () => {
    const zod = await loadZod();
    const dead = new FakeSecurityNet({
      http: Object.fromEntries([...EXPOSURE_PATHS, ...DROP_PATHS].map((path) => [`https://example.net${path}`, new Error("ENOTFOUND")])),
    });
    const tool = makeTool({ zod, cwd: "." } as never, { net: dead, sitesDirectory: join(tmpdir(), "no-such-sites-dir") });
    const result = await tool.execute("id", { site: "example.net" }, undefined, undefined);
    expect(result.details.public_files).toEqual({ status: "unmeasured", reason: "https://example.net did not answer: ENOTFOUND" });
    await expect(tool.execute("id", { site: "not a host" }, undefined, undefined)).rejects.toThrow(/not a domain or address/);
    await expect(tool.execute("id", { site: "example.net", exposure_paths: ["//evil.example/"] }, undefined, undefined)).rejects.toThrow(
      /must be a path of the site/,
    );
    expect(dead.sent.length).toBe(EXPOSURE_PATHS.length + DROP_PATHS.length);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("never POST");
  });
});
