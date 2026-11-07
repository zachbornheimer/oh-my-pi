import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { lookup as resolve } from "node:dns/promises";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP, type LookupFunction } from "node:net";
import { join } from "node:path";
import type * as Playwright from "playwright";
import { type DestinationGate, openDestinationGate } from "./destination_gate.ts";
import { type ScreenshotMeasurement, unmeasured } from "./measurement.ts";
import { describeError } from "./page_fetch.ts";
import { isPrivateAddress, publicAddressLookup } from "./private_address.ts";

/** The picture's size: the first viewport, inside the hosted model's 280-1568 pixel sides and 2,458,624-pixel area. */
export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 800;
/** What the hosted model takes of one image file. */
export const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 20_000;
const QUIET_NETWORK_MS = 5_000;
/** A picture older than this is deleted the next time one is taken; a decision made from it has long been answered. */
export const SCREENSHOT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const HTTP_ERROR_FLOOR = 400;
const USER_AGENT = "omp-webmaster-page/1.0 (+https://github.com/zysys/site-probes)";

export const SCREENSHOT_DIR_ENV = "OMP_WEBMASTER_SCREENSHOT_DIR";

/** Where pictures are kept: `$OMP_WEBMASTER_SCREENSHOT_DIR`, else `~/.cache/omp-webmaster/screenshots`. */
export function screenshotDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SCREENSHOT_DIR_ENV]?.trim();
  return configured ? configured : join(homedir(), ".cache", "omp-webmaster", "screenshots");
}

export interface ScreenshotOptions {
  /** Where pictures are kept, named by their SHA-256. */
  readonly directory: string;
  readonly now?: () => Date;
  /**
   * Hosts fetched all the same though they sit on a private address: a test's own server on the loopback. Production
   * names none, because a page renders with its scripts run, so every request it makes is one this machine makes.
   */
  readonly allowedPrivateHosts?: readonly string[];
  /** The browser library, loaded on demand; tests pass a fake. */
  readonly loadPlaywright?: () => Promise<typeof Playwright>;
  readonly signal?: AbortSignal;
}

/** Deletes pictures older than `SCREENSHOT_KEEP_MS`; a file it cannot remove is left alone. */
async function prune(directory: string, nowMs: number): Promise<void> {
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.endsWith(".png")) continue;
    const path = join(directory, name);
    const age = await stat(path).then((s) => nowMs - s.mtimeMs).catch(() => 0);
    if (age > SCREENSHOT_KEEP_MS) await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * The one rule for where a measurement may reach: a host the caller named is reached as it resolves, and every other
 * host must resolve to an address that is not private. `refuses` is the rule itself; `refusing` adds the request's own
 * part to it, and `dialing` is the lookup a connection is made with, so the address that was checked is the address
 * that is used.
 */
export function destinations(allowedPrivateHosts: readonly string[]): {
  readonly refuses: (host: string) => Promise<string | undefined>;
  readonly refusing: (url: string) => Promise<string | undefined>;
  readonly dialing: LookupFunction;
} {
  const allowed = new Set(allowedPrivateHosts.map((host) => host.toLowerCase()));
  const resolutions = new Map<string, Promise<readonly string[]>>();
  const addressesOf = (host: string): Promise<readonly string[]> => {
    if (isIP(host) !== 0) return Promise.resolve([host]);
    const known = resolutions.get(host);
    if (known !== undefined) return known;
    const resolved = resolve(host, { all: true })
      .then((found) => found.map((entry) => entry.address))
      .catch(() => [] as readonly string[]);
    resolutions.set(host, resolved);
    return resolved;
  };
  /**
   * Why a host must not be reached, or undefined when it may. The page renders with its scripts run, so every request
   * it makes is a request this machine makes: a GET to the loopback, a private network or a link-local address (where
   * the cloud metadata services answer) would hand an internal service's answer to the page, and the page's picture to
   * a decision model. A host resolves once per measurement, so one name does not cost a lookup per request, and a name
   * that resolves to nothing is refused: nothing proves where it would have gone.
   */
  const refuses = async (host: string): Promise<string | undefined> => {
    const known = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (allowed.has(known)) return undefined;
    const found = await addressesOf(known);
    if (found.length === 0) return `${known} does not resolve`;
    const blocked = found.find((address) => isPrivateAddress(address));
    return blocked === undefined ? undefined : `${known} is on a private network (${blocked})`;
  };
  /** Why a request must not go out, or undefined when it may: its scheme, then the host it is addressed to. */
  const refusing = async (raw: string): Promise<string | undefined> => {
    let destination: URL;
    try {
      destination = new URL(raw);
    } catch {
      return `${raw} is not an address`;
    }
    if (destination.protocol !== "http:" && destination.protocol !== "https:") {
      return `${raw} is not an http(s) address`;
    }
    return refuses(destination.hostname);
  };
  /**
   * A host the caller named resolves as the system would; anything else resolves through a lookup that refuses a private
   * address. The browser looks a name up again when it connects, so a name that answers publicly for `refuses` above
   * cannot reach a private address on the connection that follows.
   */
  const dialing: LookupFunction = (host, options, callback) => {
    if (!allowed.has(host.toLowerCase())) {
      publicAddressLookup(host, options, callback);
      return;
    }
    dnsLookup(host, options, callback);
  };
  return { refuses, refusing, dialing };
}

/**
 * The page as a browser renders it, with its scripts run, as a PNG of the first viewport. The page is hostile until
 * proven otherwise: a fresh incognito context (no profile, cookies or service workers survive), downloads off, every
 * request but a GET to a public http(s) address aborted, no permission granted, and every connection dialed through a
 * gate that refuses a private address wherever the browser asks for one, websocket handshakes included. The picture
 * goes to a file named by its SHA-256; nothing but where it is and what it must hold leaves this function. A page,
 * browser or disk problem answers `unmeasured`.
 */
export async function measureScreenshot(url: string, options: ScreenshotOptions): Promise<ScreenshotMeasurement> {
  const now = options.now ?? (() => new Date());
  const reachable = destinations(options.allowedPrivateHosts ?? []);
  const refused = await reachable.refusing(url);
  if (refused !== undefined) return unmeasured(`the page was not taken: ${refused}`);
  let playwright: typeof Playwright;
  try {
    playwright = await (options.loadPlaywright ?? (() => import("playwright")))();
  } catch (error) {
    return unmeasured(`no browser library: ${describeError(error)}`);
  }
  let gate: DestinationGate;
  try {
    gate = await openDestinationGate(reachable);
  } catch (error) {
    return unmeasured(`no gate in front of the browser: ${describeError(error)}`);
  }
  let browser: Playwright.Browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      // `<-loopback>` takes back the bypass a loopback target would get, which is the destination this gate is for.
      proxy: { server: gate.proxy, bypass: "<-loopback>" },
    });
  } catch (error) {
    await gate.close().catch(() => undefined);
    return unmeasured(`no browser: ${describeError(error)}`);
  }
  const abort = () => void browser.close().catch(() => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT },
      deviceScaleFactor: 1,
      userAgent: USER_AGENT,
      permissions: [],
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const blocked = request.method() === "GET" ? await reachable.refusing(request.url()) : "only a GET is sent";
      await (blocked === undefined ? route.continue() : route.abort("blockedbyclient"));
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: QUIET_NETWORK_MS }).catch(() => undefined);
    const httpStatus = response?.status() ?? 0;
    if (httpStatus >= HTTP_ERROR_FLOOR) return unmeasured(`the page answered HTTP ${httpStatus}`);
    const bytes = await page.screenshot({ type: "png", fullPage: false });
    if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
      return unmeasured(`the picture is ${bytes.byteLength} bytes; the most a model reads is ${SCREENSHOT_MAX_BYTES}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(options.directory, `${sha256}.png`);
    await mkdir(options.directory, { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    await prune(options.directory, now().getTime());
    return {
      status: "measured",
      final_url: page.url(),
      http_status: httpStatus,
      path,
      sha256,
      format: "png",
      width: SCREENSHOT_WIDTH,
      height: SCREENSHOT_HEIGHT,
      captured_at: now().toISOString(),
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return unmeasured(`the browser could not take the page: ${describeError(error)}`);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
    await gate.close().catch(() => undefined);
  }
}
