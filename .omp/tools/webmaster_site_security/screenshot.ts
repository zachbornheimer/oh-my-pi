import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { destinations, openDestinationGate } from "./gate.ts";
import type { Exec } from "./omp_model.ts";

export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 800;
export const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;
/** Longest the browser may run before it is killed. */
export const BROWSER_TIMEOUT_MS = 60_000;
/** Virtual time the page gets to run its scripts before the picture is taken. */
const VIRTUAL_TIME_BUDGET_MS = 15_000;
const USER_AGENT = "omp-webmaster-defacement/1.0 (read-only screenshot)";

/** Where Chrome or Chromium is on this machine. `WEBMASTER_CHROME` names one; otherwise the usual places and `PATH`. */
export function findChrome(env: Readonly<Record<string, string | undefined>> = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const named = env["WEBMASTER_CHROME"];
  if (named !== undefined && named !== "") return exists(named) ? named : undefined;
  const fixed = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const onPath = (env["PATH"] ?? "").split(delimiter).filter(Boolean).flatMap((dir) =>
    ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"].map((name) => join(dir, name))
  );
  return [...fixed, ...onPath].find((path) => exists(path));
}

export type ScreenshotMeasurement =
  | {
    status: "measured";
    final_url: string;
    http_status: number;
    /** The picture, a file in a private directory that `release` removes. */
    path: string;
    sha256: string;
    format: "png";
    width: number;
    height: number;
    captured_at: string;
    release: () => Promise<void>;
  }
  | { status: "unmeasured"; reason: string };

export interface ScreenshotOptions {
  readonly exec: Exec;
  readonly chrome?: string;
  /** Hosts a page may reach although they are private; tests allow a local server. */
  readonly allowedPrivateHosts?: readonly string[];
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const unmeasured = (reason: string): ScreenshotMeasurement => ({ status: "unmeasured", reason });

/**
 * The page as a browser renders it, with its scripts run, as a PNG of the first viewport. The page is hostile until
 * proven otherwise: a headless Chrome with a fresh profile, every connection sent through a gate that reaches public
 * addresses only (a private or loopback address is refused wherever the page asks, redirects and websockets included; a
 * plain http request other than a GET is refused too), and the profile removed afterwards. Whatever goes wrong
 * (no browser, a refused address, a crash, no picture) answers `unmeasured` with why; a cancelled run throws.
 */
export async function measureScreenshot(url: string, options: ScreenshotOptions): Promise<ScreenshotMeasurement> {
  const now = options.now ?? (() => new Date());
  let destination: URL;
  try {
    destination = new URL(url);
  } catch {
    return unmeasured(`the page was not taken: ${url} is not an address`);
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:") return unmeasured(`the page was not taken: ${url} is not an http(s) address`);
  const rule = destinations(options.allowedPrivateHosts ?? []);
  const refused = await rule.refuses(destination.hostname);
  if (refused !== undefined) return unmeasured(`the page was not taken: ${refused}`);
  const chrome = options.chrome ?? findChrome(options.env);
  if (chrome === undefined) return unmeasured("no browser: Chrome or Chromium was not found (set WEBMASTER_CHROME to its executable)");
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "omp-defacement-"));
  const release = (): Promise<void> => rm(directory, { recursive: true, force: true });
  let gate: Awaited<ReturnType<typeof openDestinationGate>> | undefined;
  try {
    gate = await openDestinationGate(rule);
    const file = join(directory, "page.png");
    const result = await options.exec(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-breakpad",
      "--password-store=basic",
      "--use-mock-keychain",
      "--hide-scrollbars",
      `--user-data-dir=${join(directory, "profile")}`,
      `--proxy-server=${gate.proxy}`,
      // `<-loopback>` takes back the bypass a loopback target would get: a page reaching the loopback is what the gate is for.
      "--proxy-bypass-list=<-loopback>",
      `--user-agent=${USER_AGENT}`,
      `--window-size=${SCREENSHOT_WIDTH},${SCREENSHOT_HEIGHT}`,
      `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
      `--screenshot=${file}`,
      destination.toString(),
    ], { cwd: directory, timeout: BROWSER_TIMEOUT_MS, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    options.signal?.throwIfAborted();
    if (result.killed) {
      await release();
      return unmeasured(`the browser did not finish within ${BROWSER_TIMEOUT_MS / 1000} s`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      await release();
      const tail = result.stderr.trim().split("\n").at(-1) ?? "";
      return unmeasured(`the browser took no picture (exit ${result.code})${tail === "" ? "" : `: ${tail.slice(0, 200)}`}`);
    }
    if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
      await release();
      return unmeasured(`the picture is ${bytes.byteLength} bytes; the most a model reads is ${SCREENSHOT_MAX_BYTES}`);
    }
    return {
      status: "measured",
      final_url: destination.toString(),
      http_status: 200,
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "png",
      width: SCREENSHOT_WIDTH,
      height: SCREENSHOT_HEIGHT,
      captured_at: now().toISOString(),
      release,
    };
  } catch (error) {
    await release();
    options.signal?.throwIfAborted();
    return unmeasured(`the browser could not take the page: ${describe(error)}`);
  } finally {
    await gate?.close().catch(() => undefined);
  }
}
