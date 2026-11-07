import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { type DefacementInput, defacementVerdict, defacementVerdictBySight, parseSeen, pictureQuestion, seenVerdict, visibleText } from "./defacement.ts";
import { FakeSecurityNet } from "./fake_net.ts";
import { destinations, openDestinationGate } from "./gate.ts";
import { ompImageStep } from "./image_model.ts";
import type { Exec } from "./omp_model.ts";
import type { SitePublicFiles } from "./public_files.ts";
import { type BrowserProcess, findChrome, type LaunchBrowser, measureScreenshot, type ScreenshotMeasurement } from "./screenshot.ts";
import { DESCRIPTION, makeTool } from "./tool.ts";
import { loadZod } from "./zod_for_tests.ts";

const SITE = "https://example.org";
const PLAIN_HTTP = "http:";
const NO_SITE_FILES = join(tmpdir(), "no-such-wm-sites-dir");
const CLEAN_HOME = { status: 200, body: "<html><head><title>x</title></head><body><h1>Welcome to Example</h1><p>Summit news</p></body></html>" };
const DEFACED_HOME = { status: 200, body: "<html><body><h1>Hacked By Crew</h1></body></html>" };

const page = (body: string) => ({ status: 200, contentType: "text/html", body });
const cleanNet = () => new FakeSecurityNet({ http: { [`${SITE}/index.html`]: page("<html>welcome</html>") } });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let shots: string;
beforeAll(() => {
  shots = mkdtempSync(join(tmpdir(), "defacement-test-"));
  writeFileSync(join(shots, "page.png"), PNG);
});
afterAll(() => rmSync(shots, { recursive: true, force: true }));

const picture = (): ScreenshotMeasurement => ({
  status: "measured",
  final_url: `${SITE}/`,
  http_status: 200,
  path: join(shots, "page.png"),
  sha256: "ab".repeat(32),
  format: "png",
  width: 1280,
  height: 800,
  captured_at: "2026-11-06T00:00:00.000Z",
  release: async () => {
    released.count += 1;
  },
});
const released = { count: 0 };

const seeing = (left: number, style: number) => {
  const prompts: string[] = [];
  const paths: string[] = [];
  return {
    prompts,
    paths,
    imageStep: (path: string) => async (prompt: string) => {
      paths.push(path);
      prompts.push(prompt);
      return JSON.stringify({ LeftMessage: left, DefacerStyle: style });
    },
  };
};

const run = async (
  params: Record<string, unknown>,
  deps: { net?: FakeSecurityNet; home?: { status: number; body: string } | Error; screenshot?: ScreenshotMeasurement; model?: ReturnType<typeof seeing> } = {},
) => {
  const model = deps.model ?? seeing(0.01, 0.01);
  let taken = 0;
  const home = deps.home ?? CLEAN_HOME;
  const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
    net: deps.net ?? cleanNet(),
    getHome: async () => {
      if (home instanceof Error) throw home;
      return home;
    },
    screenshot: async () => {
      taken += 1;
      return deps.screenshot ?? picture();
    },
    imageStep: model.imageStep,
    sitesDirectory: NO_SITE_FILES,
  });
  const out = await tool.execute("id", { site: "example.org", ...params } as never, undefined as never, undefined);
  return { result: out.details, model, taken: () => taken };
};

describe("the text rules", () => {
  it("flags a signature on the home page and on a drop page, without asking a model or taking a picture", async () => {
    const net = new FakeSecurityNet({ http: { [`${SITE}/0x.html`]: page("<h1>H4ck3d By someone</h1>") } });
    const { result, model, taken } = await run({}, { net, home: DEFACED_HOME });
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.site.defacement", "high"]]);
    expect(result.findings[0]?.evidence).toContain('the home page says "Hacked By"');
    expect(result.findings[0]?.evidence).toContain('/0x.html says "H4ck3d By"');
    expect(model.prompts).toEqual([]);
    expect(taken()).toBe(0);
  });

  it("matches the caller's own phrases, without case, and the site file's when none are given", async () => {
    const home = { status: 200, body: "<body>OWNED BY THE CREW</body>" };
    expect((await run({ defacement_patterns: ["owned by the crew"] }, { home })).result.status).toBe("fail");
    expect((await run({}, { home })).result.status).toBe("pass");
    const dir = mkdtempSync(join(tmpdir(), "defacement-sites-"));
    writeFileSync(join(dir, "example.yaml"), "url: https://example.org\nsecurity:\n  defacement_patterns:\n    - owned by the crew\n");
    try {
      const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { net: cleanNet(), getHome: async () => home, screenshot: async () => picture(), imageStep: seeing(0, 0).imageStep, sitesDirectory: dir });
      expect((await tool.execute("id", { site: "example.org", defacement_patterns: null } as never, undefined as never, undefined)).details.status).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores text in the head, scripts and styles, and a drop page that did not answer 2xx", () => {
    expect(visibleText("<head><title>Hacked By</title></head><script>x='Hacked By'</script><style>a{}</style><body><!-- Hacked By --> Hello   <b>world</b></body>")).toBe("Hello world");
    const files: SitePublicFiles = {
      status: "measured",
      files: [{ method: "GET", path: "/x.html", status: 404, content_type: "text/html", body: "Hacked By", purpose: "drop" }],
    };
    expect(defacementVerdict({ status: "measured", final_url: SITE, http_status: 200, visible_text: "fine" }, files)).toEqual([]);
  });

  it("asks only the drop pages of the site, not the exposure paths, and never POSTs", async () => {
    const net = cleanNet();
    await run({}, { net });
    expect(net.sent.length).toBe(7);
    expect(net.sent.every((request) => request.method === "GET")).toBe(true);
    expect(net.sent.map((request) => new URL(request.url).pathname)).toContain("/hacked.html");
  });
});

describe("judging the picture", () => {
  it("passes a clean site whose picture the model does not find defaced, and removes the picture afterwards", async () => {
    const before = released.count;
    const model = seeing(0.02, 0.05);
    const { result, taken } = await run({}, { model });
    expect(result).toMatchObject({ site: "example.org", status: "pass", findings: [] });
    expect(taken()).toBe(1);
    expect(model.prompts).toHaveLength(1);
    expect(model.paths).toEqual([join(shots, "page.png")]);
    expect(released.count).toBe(before + 1);
  });

  it("shows the model both questions with their criteria, and the schema", async () => {
    const prompt = pictureQuestion("example.org");
    expect(prompt).toContain("LeftMessage: `screenshot` is the first screen");
    expect(prompt).toContain("- true: The screen looks like a defacer's page.");
    expect(prompt).toContain("Respond as JSON matching this schema:");
  });

  it.each([
    [0.93, 0.2, "high", "LeftMessage"],
    [0.1, 0.8, "high", "DefacerStyle"],
    [0.6, 0.3, "medium", "LeftMessage"],
    [0.1, 0.5, "medium", "DefacerStyle"],
  ])("fails a picture the model finds defaced (%s, %s) as %s", async (left, style, severity, field) => {
    const { result } = await run({}, { model: seeing(left, style) });
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.site.defacement", severity]]);
    expect(result.findings[0]?.evidence).toContain(field);
  });

  it("is unmeasured, never a text-only pass, when the picture was not taken, and asks no model", async () => {
    const model = seeing(0.99, 0.99);
    const { result } = await run({}, { screenshot: { status: "unmeasured", reason: "no browser" }, model });
    expect(result).toMatchObject({ status: "unmeasured", reason: "the home page was not pictured (no browser)" });
    expect(model.prompts).toEqual([]);
  });

  it("is unmeasured, never a pass, when the model's reply is not valid after three tries or it errors", async () => {
    let calls = 0;
    const result = await seenVerdict("example.org", picture() as never, async () => {
      calls += 1;
      return "I cannot see images";
    });
    expect(calls).toBe(3);
    expect(result).toEqual({ unmeasured: expect.stringContaining("the screenshot could not be judged: no valid reply after 3 attempts") });
    const mute = await seenVerdict("example.org", picture() as never, async () => {
      throw new Error("provider down");
    });
    expect(mute).toEqual({ unmeasured: "the screenshot could not be judged: provider down" });
  });

  it("accepts a fenced JSON reply and refuses out-of-range or missing probabilities", () => {
    expect(parseSeen({ LeftMessage: 0.5, DefacerStyle: 0 })).toEqual({ LeftMessage: 0.5, DefacerStyle: 0 });
    expect(() => parseSeen({ LeftMessage: 2, DefacerStyle: 0 })).toThrow(/LeftMessage/);
    expect(() => parseSeen({ LeftMessage: 0 })).toThrow(/DefacerStyle/);
    expect(() => parseSeen([])).toThrow(/object/);
  });

  it("is unmeasured when no source was read, and when a text source was not read even though the picture looks fine", async () => {
    const down = new FakeSecurityNet({ http: Object.fromEntries(["/0x.html", "/x.html", "/1.html", "/hacked.html", "/hacked.htm", "/deface.html", "/index.html"].map((p) => [`${SITE}${p}`, new Error("ECONNREFUSED")])) });
    const none = await run({}, { net: down, home: new Error("ECONNREFUSED") });
    expect(none.result).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("the home page was not pictured") });
    expect(none.taken()).toBe(0);
    const noHome = await run({}, { home: { status: 503, body: "" }, model: seeing(0.01, 0.01) });
    expect(noHome.result).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("the home page was not read (HTTP 503 at https://example.org/)") });
    const noDrops = await run({}, { net: down, model: seeing(0.01, 0.01) });
    expect(noDrops.result).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("the drop pages were not read") });
  });

  it("still fails on a signature in the source that was read, or on the picture, when another was not", async () => {
    const down = new FakeSecurityNet({ http: Object.fromEntries(["/0x.html", "/x.html", "/1.html", "/hacked.html", "/hacked.htm", "/deface.html", "/index.html"].map((p) => [`${SITE}${p}`, new Error("ECONNREFUSED")])) });
    expect((await run({}, { net: down, home: DEFACED_HOME })).result.status).toBe("fail");
    expect((await run({}, { net: down, model: seeing(0.95, 0.9) })).result.status).toBe("fail");
    expect((await run({}, { home: { status: 503, body: "" }, model: seeing(0.95, 0.9) })).result.status).toBe("unmeasured");
  });

  it("the verdict function never takes a picture when the text already shows a signature", async () => {
    let taken = 0;
    const input: DefacementInput = { site: "example.org", home_page: { status: "measured", final_url: SITE, http_status: 200, visible_text: "Defaced By x" }, public_files: { status: "measured", files: [] } };
    const verdict = await defacementVerdictBySight(input, async () => {
      taken += 1;
      return { screenshot: picture() };
    });
    expect(Array.isArray(verdict)).toBe(true);
    expect(taken).toBe(0);
  });
});

describe("the image model step", () => {
  it("passes the prompt file and the image file to omp -p with the bare flags, and cleans up", async () => {
    const calls: { command: string; args: string[]; prompt: string }[] = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args: [...args], prompt: readFileSync(args[1]!.slice(1), "utf8") });
      return { code: 0, stdout: ' {"LeftMessage":0,"DefacerStyle":0} ', stderr: "", killed: false };
    };
    const reply = await ompImageStep(exec, "/tmp/shot.png")("the prompt");
    expect(reply).toBe('{"LeftMessage":0,"DefacerStyle":0}');
    expect(calls[0]!.command).toBe("omp");
    expect(calls[0]!.args[0]).toBe("-p");
    expect(calls[0]!.args[2]).toBe("@/tmp/shot.png");
    expect(calls[0]!.args).toContain("--no-tools");
    expect(calls[0]!.prompt).toBe("the prompt");
    const failing: Exec = async () => ({ code: 2, stdout: "", stderr: "no key", killed: false });
    await expect(ompImageStep(failing, "/tmp/x.png")("p")).rejects.toThrow(/exited 2: no key/);
  });
});

describe("the destination gate", () => {
  it("refuses private and loopback addresses, names that resolve to them, and allows what the caller names", async () => {
    const rule = destinations(["127.0.0.1"], (address) => !address.startsWith("10.") && address !== "127.0.0.1" && address !== "::1");
    expect(await rule.refuses("10.0.0.5")).toContain("private network address");
    expect(await rule.refuses("127.0.0.1")).toBeUndefined();
    expect(await rule.refuses("192.0.2.1")).toBeUndefined();
    expect(await rule.refuses("localhost")).toContain("resolves to a private network address");
    expect(await destinations().refuses("[::1]")).toContain("private network address");
    expect(await destinations().refuses("169.254.169.254")).toContain("private network address");
  });

  it("answers 502 for a private destination through the proxy and records it; never forwards a POST", async () => {
    const gate = await openDestinationGate(destinations());
    try {
      // Plain HTTP on purpose: a proxy sees (and can refuse) the destination of a plain request, not of a tunnelled one.
      const get = await fetch(new URL("/", `${PLAIN_HTTP}//10.255.255.1`), { proxy: gate.proxy } as never);
      expect(get.status).toBe(502);
      const post = await fetch(new URL("/", `${PLAIN_HTTP}//example.invalid`), { method: "POST", body: "x", proxy: gate.proxy } as never);
      expect(post.status).toBe(405);
      expect(gate.refused.some((why) => why.includes("10.255.255.1"))).toBe(true);
    } finally {
      await gate.close();
    }
  });
});

const chrome = findChrome();
/** A fake browser: runs `act` with the arguments, ends with `code` when `act` returns, and records kills. */
const fakeBrowser = (act: (args: readonly string[]) => Promise<void> | void, code = 0, stderr = ""): { launch: LaunchBrowser; kills: () => number } => {
  let kills = 0;
  return {
    kills: () => kills,
    launch: (_command, args) => {
      let end: (result: { code: number; stderr: string }) => void = () => undefined;
      const ended = new Promise<{ code: number; stderr: string }>((resolve) => {
        end = resolve;
      });
      void (async () => {
        await act(args);
        end({ code, stderr });
      })();
      const process: BrowserProcess = {
        ended,
        kill: () => {
          kills += 1;
          end({ code: -1, stderr: "" });
        },
      };
      return process;
    },
  };
};
const screenshotPath = (args: readonly string[]): string => args.find((arg) => arg.startsWith("--screenshot="))!.slice("--screenshot=".length);
const ONE_PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("the real browser (headless Chrome behind the gate, against a local server)", () => {
  let server: Server;
  let origin = "";
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html" }).end("<html><body style='background:#000;color:#0f0'><h1>HACKED BY TESTCREW</h1></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => server.close());

  it.skipIf(chrome === undefined)("takes a PNG of a local page when the caller allows that host, and removes it on release", async () => {
    const measured = await measureScreenshot(origin, { allowedPrivateHosts: ["127.0.0.1"] });
    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    const bytes = readFileSync(measured.path);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(measured.sha256).toHaveLength(64);
    expect(hits.length).toBeGreaterThan(0);
    await measured.release();
    expect(() => readFileSync(measured.path)).toThrow();
  }, 90_000);

  it.skipIf(chrome === undefined)("refuses a local page by default, so the server is never reached", async () => {
    const before = hits.length;
    const measured = await measureScreenshot(origin, {});
    expect(measured).toEqual({ status: "unmeasured", reason: expect.stringContaining("the page was not taken: 127.0.0.1 is a private network address") });
    expect(hits.length).toBe(before);
  });

  it("is unmeasured, not a throw, with no browser, a bad address or a browser that dies", async () => {
    expect(await measureScreenshot(origin, { env: { PATH: "", WEBMASTER_CHROME: join(tmpdir(), "no-chrome") }, allowedPrivateHosts: ["127.0.0.1"] })).toEqual({
      status: "unmeasured",
      reason: expect.stringContaining("no browser: Chrome or Chromium was not found"),
    });
    expect(await measureScreenshot("file:///etc/passwd", {})).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("not an http(s) address") });
    expect(await measureScreenshot("nonsense", {})).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("not an address") });
    const dying = fakeBrowser(() => undefined, 1, "boom\nChrome crashed");
    expect(await measureScreenshot(origin, { launch: dying.launch, chrome: "/bin/true", allowedPrivateHosts: ["127.0.0.1"] })).toEqual({
      status: "unmeasured",
      reason: "the browser took no picture (exit 1): Chrome crashed",
    });
    const hung = fakeBrowser(() => new Promise<void>(() => undefined));
    expect(await measureScreenshot(origin, { launch: hung.launch, chrome: "/bin/true", timeoutMs: 300, allowedPrivateHosts: ["127.0.0.1"] })).toEqual({
      status: "unmeasured",
      reason: "the browser did not take a picture within 0.3 s",
    });
    expect(hung.kills()).toBe(1);
  });

  it("takes the picture as soon as it is complete and kills a browser that never shuts down, ignoring a partial file", async () => {
    const stuck = fakeBrowser(async (args) => {
      const file = screenshotPath(args);
      await Bun.write(file, ONE_PIXEL.subarray(0, 20));
      await new Promise((resolve) => setTimeout(resolve, 250));
      await Bun.write(file, ONE_PIXEL);
      await new Promise<void>(() => undefined);
    });
    const started = Date.now();
    const measured = await measureScreenshot(origin, { launch: stuck.launch, chrome: "/bin/true", allowedPrivateHosts: ["127.0.0.1"], timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(measured.status).toBe("measured");
    expect(stuck.kills()).toBe(1);
    if (measured.status === "measured") await measured.release();
  });

  it("finds Chrome from WEBMASTER_CHROME, the usual places and PATH", () => {
    expect(findChrome({ WEBMASTER_CHROME: "/x/chrome" }, (path) => path === "/x/chrome")).toBe("/x/chrome");
    expect(findChrome({ WEBMASTER_CHROME: "/x/missing" }, () => false)).toBeUndefined();
    expect(findChrome({ PATH: "/a:/b" }, (path) => path === "/b/chromium")).toBe("/b/chromium");
  });
});

describe("the tool", () => {
  it("is one dense block of 80-250 words naming the inputs, cost, browser and the never-a-pass boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("WEBMASTER_CHROME");
    expect(DESCRIPTION).toContain("billed");
    expect(DESCRIPTION).toContain("never a pass");
  });

  it("stops when cancelled instead of reporting a verdict", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
      net: { request: async (_m, _u, _b, signal) => { signal?.throwIfAborted(); return page("x"); } },
      getHome: async (_url, signal) => { signal?.throwIfAborted(); return CLEAN_HOME; },
      screenshot: async () => picture(),
      imageStep: seeing(0, 0).imageStep,
      sitesDirectory: NO_SITE_FILES,
    });
    await expect(tool.execute("id", { site: "example.org" } as never, undefined as never, undefined, controller.signal)).rejects.toThrow();
  });
});
