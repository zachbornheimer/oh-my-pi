import type * as AxePlaywright from "@axe-core/playwright";
import type * as Playwright from "playwright";
import { AXE_IMPACTS, type AxeImpact } from "./measurement.ts";

/**
 * A headless Chromium page for the accessibility and privacy probes, through `playwright` and `@axe-core/playwright`
 * (declared in this tool's package.json; both load on demand, so a tool that never opens a browser pays nothing).
 * One browser per call, always closed in `finally`. Ported from `@zysys/site-probes`' `facades/browser`.
 */

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const DESKTOP_VIEWPORT: Viewport = { width: 1440, height: 900 };

export interface AxeViolation {
  readonly id: string;
  readonly impact: AxeImpact;
  readonly help: string;
  readonly nodeCount: number;
}

export interface BrowserPage {
  /** The address the page ended at after redirects. */
  readonly finalUrl: string;
  /** Every request the page issued from navigation start until now. */
  requestUrls(): readonly string[];
  html(): Promise<string>;
  axeViolations(): Promise<readonly AxeViolation[]>;
}

/** Opens `url` in a fresh browser, runs `work` on the loaded page, and closes the browser however `work` ends. */
export type PageOpener = <T>(url: string, work: (page: BrowserPage) => Promise<T>, signal?: AbortSignal) => Promise<T>;

const OPEN_PAGE_TIMEOUT_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const NEW_CONTEXT_TIMEOUT_MS = 30_000;
const NEW_PAGE_TIMEOUT_MS = 30_000;
const READ_HTML_TIMEOUT_MS = 30_000;
const AXE_ANALYZE_TIMEOUT_MS = 60_000;
/** Lets late analytics beacons fire after the load event. */
const SETTLE_MS = 2_000;

/** Raised when a browser wait outlives its timeout. */
export class BrowserTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`browser ${operation} timed out after ${timeoutMs}ms`);
    this.name = "BrowserTimeoutError";
  }
}

async function withTimeout<T>(operation: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserTimeoutError(operation, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    if (error instanceof BrowserTimeoutError) work.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const isAxeImpact = (value: string | null | undefined): value is AxeImpact => AXE_IMPACTS.some((i) => i === value);

/** The libraries the real opener needs, loaded on demand; tests pass fakes. */
export interface BrowserLibraries {
  playwright(): Promise<typeof Playwright>;
  axe(): Promise<typeof AxePlaywright>;
}

export const realLibraries: BrowserLibraries = {
  playwright: () => import("playwright"),
  axe: () => import("@axe-core/playwright"),
};

async function load<T>(name: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} is not installed for this tool; run \`bun install\` in its directory (${reason})`);
  }
}

/** The real opener: playwright's Chromium, a fresh incognito context at the desktop viewport, requests recorded from navigation. */
export function chromiumOpener(libraries: BrowserLibraries = realLibraries): PageOpener {
  return async (url, work, signal) => {
    signal?.throwIfAborted();
    const playwright = await load("playwright", libraries.playwright);
    const browser = await withTimeout("launch", LAUNCH_TIMEOUT_MS, playwright.chromium.launch());
    const abort = () => void browser.close().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // axe-core requires a page created from an explicit context.
      const context = await withTimeout(
        "new context",
        NEW_CONTEXT_TIMEOUT_MS,
        browser.newContext({ viewport: DESKTOP_VIEWPORT }),
      );
      const page = await withTimeout("new page", NEW_PAGE_TIMEOUT_MS, context.newPage());
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      try {
        await page.goto(url, { waitUntil: "load", timeout: OPEN_PAGE_TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_MS);
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`browser failed to open ${url}`, { cause: error });
      }
      return await work({
        finalUrl: page.url(),
        requestUrls: () => requests,
        html: () => withTimeout("read html", READ_HTML_TIMEOUT_MS, page.content()),
        async axeViolations() {
          const axe = await load("@axe-core/playwright", libraries.axe);
          const result = await withTimeout("axe analyze", AXE_ANALYZE_TIMEOUT_MS, new axe.AxeBuilder({ page }).analyze());
          return result.violations.map((violation) => ({
            id: violation.id,
            impact: isAxeImpact(violation.impact) ? violation.impact : "minor",
            help: violation.help,
            nodeCount: violation.nodes.length,
          }));
        },
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      await browser.close().catch(() => undefined);
    }
  };
}
