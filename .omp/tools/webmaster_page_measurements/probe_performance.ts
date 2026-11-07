import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lighthouseFacts } from "./lighthouse_facts.ts";
import { type FormFactor, type PerformanceMeasurement, type PerformanceMetrics, unmeasured } from "./measurement.ts";
import { describeError } from "./page_fetch.ts";

export const PAGE_SPEED_KEY_ENVIRONMENT = "PSI_API_KEY";
export const PAGE_SPEED_KEYCHAIN_SERVICE = "psi-api-key";
const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
/** PageSpeed runs a real Lighthouse pass; it routinely takes 20 to 40 seconds. */
const PAGE_SPEED_TIMEOUT_MS = 90_000;
/** A local Lighthouse run launches Chrome and can take a few minutes on a loaded machine. */
const LIGHTHOUSE_TIMEOUT_MS = 240_000;
const BODY_EXCERPT_CHARS = 200;
const STDERR_EXCERPT_CHARS = 300;

/** The flag that makes a local Lighthouse run emulate each device. */
const LIGHTHOUSE_DEVICE_FLAG: Readonly<Record<FormFactor, string>> = {
  mobile: "--form-factor=mobile",
  desktop: "--preset=desktop",
};

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What the speed probe needs from the machine it runs on; tests pass a fake. */
export interface PerformanceHost {
  environment(name: string): string | undefined;
  run(command: string, args: readonly string[], signal?: AbortSignal): Promise<ProcessResult>;
  fetch(url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/** The real host: this process's environment and `fetch`, and subprocesses through Bun. A command that cannot start is exit code 127. */
export const systemHost: PerformanceHost = {
  environment: (name) => process.env[name],
  fetch(url, init) {
    // The only remote this host reaches is the PageSpeed API: anything else is refused, and the origin is a literal.
    const target = new URL(url);
    if (`${target.origin}${target.pathname}` !== ENDPOINT) throw new Error(`${target.origin} is not the PageSpeed API`);
    return fetch(`https://www.googleapis.com/${target.pathname.slice(1)}${target.search}`, init);
  },
  async run(command, args, signal) {
    try {
      const child = startAllowed(command, args, signal);
      const output = { stdout: "", stderr: "" };
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output.stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output.stderr += chunk));
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve(status ?? 1));
      });
      return { code, ...output };
    } catch (error) {
      signal?.throwIfAborted();
      return { code: 127, stdout: "", stderr: describeError(error) };
    }
  },
};

/** The only programs the speed probe runs: the macOS keychain reader and the Lighthouse launcher. */
type AllowedProgram = "security" | "bunx";

/** Starts one allowlisted program with an argument array and no shell; any other name throws. */
function startAllowed(command: string, args: readonly string[], signal: AbortSignal | undefined) {
  const options = { shell: false, signal, stdio: ["ignore", "pipe", "pipe"] } as const;
  const name = command as AllowedProgram;
  switch (name) {
    case "security":
      return spawn("security", [...args], options);
    case "bunx":
      return spawn("bunx", [...args], options);
    default:
      throw new Error(`${command} is not a program the speed probe may run`);
  }
}

/** The PageSpeed key from the environment, else the macOS keychain; undefined when neither has one. */
async function pageSpeedKey(host: PerformanceHost, signal?: AbortSignal): Promise<string | undefined> {
  const direct = host.environment(PAGE_SPEED_KEY_ENVIRONMENT);
  if (direct !== undefined && direct !== "") return direct;
  const found = await host.run("security", ["find-generic-password", "-s", PAGE_SPEED_KEYCHAIN_SERVICE, "-w"], signal);
  const secret = found.stdout.trim();
  return found.code === 0 && secret !== "" ? secret : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The metrics of one PageSpeed response for `url`: its Lighthouse result's facts, with INP the real-user (CrUX) figure
 * when Google has one; a lab run has none.
 */
export function metricsFromPageSpeed(body: string, url: string): PerformanceMetrics {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error("the PageSpeed response is not an object");
  const percentile = isRecord(parsed["loadingExperience"]) && isRecord(parsed["loadingExperience"]["metrics"])
      && isRecord(parsed["loadingExperience"]["metrics"]["INTERACTION_TO_NEXT_PAINT"])
    ? parsed["loadingExperience"]["metrics"]["INTERACTION_TO_NEXT_PAINT"]["percentile"]
    : undefined;
  return {
    ...lighthouseFacts(parsed["lighthouseResult"], url),
    inp_ms: typeof percentile === "number" ? percentile : null,
  };
}

/** One page on one device through Google's PageSpeed Insights API. Throws a message that never contains the key. */
async function pageSpeedMetrics(
  host: PerformanceHost,
  url: string,
  formFactor: FormFactor,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PerformanceMetrics> {
  const query = new URLSearchParams({ url, strategy: formFactor, category: "performance", key: apiKey });
  const timeout = AbortSignal.timeout(PAGE_SPEED_TIMEOUT_MS);
  const response = await host.fetch(`${ENDPOINT}?${query.toString()}`, {
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  const body = await response.text();
  if (!response.ok) {
    const excerpt = body.slice(0, BODY_EXCERPT_CHARS).replaceAll(apiKey, "<key>");
    throw new Error(`PageSpeed API ${formFactor} run for ${url} failed: HTTP ${response.status}: ${excerpt}`);
  }
  return metricsFromPageSpeed(body, url);
}

/**
 * A full local Lighthouse run, its JSON report read through the same facts as PageSpeed's. It runs through `bunx` in an
 * empty temp directory so the project's own dependency tree is never the one Lighthouse resolves from.
 */
async function viaLocalLighthouse(
  host: PerformanceHost,
  url: string,
  formFactor: FormFactor,
  signal?: AbortSignal,
): Promise<PerformanceMeasurement> {
  const directory = await mkdtemp(join(tmpdir(), "lighthouse-"));
  const report = join(directory, "report.json");
  try {
    const timeout = AbortSignal.timeout(LIGHTHOUSE_TIMEOUT_MS);
    const ran = await host.run("bunx", [
      "lighthouse",
      url,
      "--output=json",
      `--output-path=${report}`,
      "--quiet",
      "--chrome-flags=--headless=new",
      LIGHTHOUSE_DEVICE_FLAG[formFactor],
    ], signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
    if (ran.code !== 0) {
      throw new Error(`lighthouse exited ${ran.code}: ${ran.stderr.trim().slice(-STDERR_EXCERPT_CHARS)}`);
    }
    return {
      status: "measured",
      source: "lighthouse",
      form_factor: formFactor,
      metrics: lighthouseFacts(JSON.parse(await readFile(report, "utf8")), url),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * PageSpeed when a key is configured; if it fails (quota, rate limit, outage) or there is no key, local Lighthouse.
 * Both failing leaves the page `unmeasured` with every reason, never an error.
 */
export async function measurePerformance(
  host: PerformanceHost,
  url: string,
  formFactor: FormFactor,
  signal?: AbortSignal,
): Promise<PerformanceMeasurement> {
  const reasons: string[] = [];
  const key = await pageSpeedKey(host, signal);
  if (key === undefined) {
    reasons.push(`no PageSpeed key (${PAGE_SPEED_KEY_ENVIRONMENT} or keychain ${PAGE_SPEED_KEYCHAIN_SERVICE})`);
  } else {
    try {
      return {
        status: "measured",
        source: "psi",
        form_factor: formFactor,
        metrics: await pageSpeedMetrics(host, url, formFactor, key, signal),
      };
    } catch (error) {
      signal?.throwIfAborted();
      reasons.push(describeError(error));
    }
  }
  try {
    return await viaLocalLighthouse(host, url, formFactor, signal);
  } catch (error) {
    signal?.throwIfAborted();
    reasons.push(`local Lighthouse failed: ${describeError(error)}`);
    return unmeasured(reasons.join("; "));
  }
}
