import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { destinations, openDestinationGate } from "./gate.ts";

export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 800;
export const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;
/** Longest the browser may run before it is killed. */
export const BROWSER_TIMEOUT_MS = 60_000;
/** How often the picture file is looked for while the browser runs. */
const POLL_MS = 100;
/** The last 8 bytes of every complete PNG: the IEND chunk type and its CRC. */
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
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

/** A browser process: it ends by itself or is killed with everything it started. */
export interface BrowserProcess {
  /** Settles when the process has ended (or been killed), with its exit code and the tail of its stderr. */
  readonly ended: Promise<{ code: number; stderr: string }>;
  kill(): void;
}

export type LaunchBrowser = (command: string, args: readonly string[], options: { cwd: string }) => BrowserProcess;

/**
 * Starts the browser in its own process group, so `kill` takes down the helper processes too. Chrome writes the picture
 * and then often takes tens of seconds, or hangs, shutting down (it waits on helper processes and open sockets), so the
 * caller reads the picture as soon as it exists and kills the browser rather than waiting for it to exit.
 */
export const spawnBrowser: LaunchBrowser = (command, args, options) => {
  const child = spawn(command, [...args], { cwd: options.cwd, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const ended = new Promise<{ code: number; stderr: string }>((resolve) => {
    child.once("error", (error) => resolve({ code: -1, stderr: String(error) }));
    child.once("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
  return {
    ended,
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
};

export interface ScreenshotOptions {
  /** Starts the browser; the default spawns it. Tests pass a fake. */
  readonly launch?: LaunchBrowser;
  /** Longest the browser may run before it is killed; default `BROWSER_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  readonly chrome?: string;
  /** Hosts a page may reach although they are private; tests allow a local server. */
  readonly allowedPrivateHosts?: readonly string[];
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The complete PNG at `file`, once the browser has written it; undefined while it is absent or partial. */
async function readComplete(file: string): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(file);
    return bytes.byteLength > PNG_END.length && bytes.subarray(-PNG_END.length).equals(PNG_END) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

type Waited = { status: "taken"; bytes: Buffer } | { status: "timeout" } | { status: "none"; code: number; stderr: string };

/**
 * Waits until the browser has written a complete picture, then kills it (it need not shut down cleanly). Ends early when
 * the browser exits without a picture, and gives up, killing it, at the deadline. The browser is always killed on return.
 */
async function waitForPicture(file: string, browser: BrowserProcess, timeoutMs: number, signal: AbortSignal | undefined): Promise<Waited> {
  let exited: { code: number; stderr: string } | undefined;
  void browser.ended.then((result) => {
    exited = result;
  });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const bytes = await readComplete(file);
      if (bytes !== undefined) return { status: "taken", bytes };
      if (exited !== undefined) return { status: "none", code: exited.code, stderr: exited.stderr };
      if (Date.now() >= deadline) return { status: "timeout" };
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    browser.kill();
    await Promise.race([browser.ended, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
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
    const browser = (options.launch ?? spawnBrowser)(chrome, [
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
    ], { cwd: directory });
    const timeoutMs = options.timeoutMs ?? BROWSER_TIMEOUT_MS;
    const waited = await waitForPicture(file, browser, timeoutMs, options.signal);
    options.signal?.throwIfAborted();
    if (waited.status !== "taken") {
      await release();
      if (waited.status === "timeout") return unmeasured(`the browser did not take a picture within ${timeoutMs / 1000} s`);
      const tail = waited.stderr.trim().split("\n").at(-1) ?? "";
      return unmeasured(`the browser took no picture (exit ${waited.code})${tail === "" ? "" : `: ${tail.slice(0, 200)}`}`);
    }
    const bytes = waited.bytes;
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
