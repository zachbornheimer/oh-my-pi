import { type CertificateReader, collectSiteCertificate, systemCertificateReader } from "./certificate";
import { collectSiteDns, type DnsResolver, systemResolver } from "./dns";
import { type HomePage, visibleText } from "./defacement";
import { ompImageStep } from "./image_model";
import {
  COMMAND_TIMEOUT_MS,
  measureWordpressInspect,
  type ProcessResult,
  type RunProcess,
  SERVER_GATHER_ENVIRONMENT,
  SERVER_OFF_REASON,
} from "./inspect";
import { describeError, publicGet, type SecurityNet, siteUrlOf, systemSecurityNet } from "./net";
import type { Exec, ModelStep } from "./omp_model";
import { measureWordpressPublicApi } from "./public_api";
import { measurePublicFiles, validatedExposurePaths } from "./public_files";
import { measureScreenshot, type ScreenshotMeasurement } from "./screenshot";
import { securitySiteNames, siteContextForAddress, siteContextNamed, sitesDirectory } from "./site_context";
import type { DailyPorts, SiteFileSecurity, SiteSecurityPorts } from "./site_security";

/** What the real ports reach outside themselves for; tests pass fakes for each. */
export interface LiveDeps {
  /** `pi.exec`: runs `ssh` and headless Chrome, and the `omp -p` call that reads the picture. */
  exec: Exec;
  /** Environment variables; `process.env` by default. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Where the owner's site files are; `WEBMASTER_SITES_DIR` or `~/Developer/Zysys/webmaster/sites` by default. */
  sitesDirectory?: string;
  resolver?: DnsResolver;
  reader?: CertificateReader;
  net?: SecurityNet;
  /** Runs `ssh` for the server inspection; wraps `exec` by default. */
  run?: RunProcess;
  /** Reads the home page; a public GET that follows redirects by default. */
  getHome?: (url: string, signal?: AbortSignal) => Promise<{ status: number; body: string }>;
  /** Takes the picture; headless Chrome behind a gate that refuses private addresses by default. */
  screenshot?: (url: string, signal?: AbortSignal) => Promise<ScreenshotMeasurement>;
  /** The model step that reads the picture at `imagePath`; spawns `omp -p` by default. */
  imageStep?: (imagePath: string) => ModelStep;
  now?: () => Date;
}

/** The real runner for `ssh`, the only program the server inspection starts: a stopped command is recorded as code -1, a cancelled run throws. */
export function runWithExec(exec: Exec, cwd?: string): RunProcess {
  return async (command, args, signal) => {
    if (command !== "ssh") throw new Error(`command not allowed: ${command}`);
    const result = await exec("ssh", [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      timeout: COMMAND_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    const out: ProcessResult = {
      code: result.killed ? -1 : result.code,
      stdout: result.stdout,
      stderr: result.killed ? `${result.stderr}\nstopped after ${COMMAND_TIMEOUT_MS} ms`.trim() : result.stderr,
    };
    return out;
  };
}

const systemGetHome: NonNullable<LiveDeps["getHome"]> = async (url, signal) => {
  const answered = await publicGet(url, {
    headers: { "user-agent": "omp-webmaster-security/1.0 (read-only check)" },
    timeoutMs: 20_000,
    bodyCap: 2_000_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: answered.status, body: answered.body };
};

/** The home page's rendered text from one GET; a page that does not answer is `unmeasured` with why. */
export async function readHome(
  url: string,
  getHome: NonNullable<LiveDeps["getHome"]>,
  signal?: AbortSignal,
): Promise<HomePage> {
  try {
    const page = await getHome(url, signal);
    if (page.status >= 400) return { status: "unmeasured", reason: `HTTP ${page.status} at ${url}` };
    return { status: "measured", final_url: url, http_status: page.status, visible_text: visibleText(page.body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unmeasured", reason: `${url} did not answer: ${describeError(error)}` };
  }
}

/** The ports that collect on this machine: DNS, TLS, public HTTP, SSH and headless Chrome, with the owner's site files. */
export function livePorts(deps: LiveDeps): SiteSecurityPorts {
  const environment = deps.environment ?? process.env;
  const directory = deps.sitesDirectory ?? sitesDirectory(environment);
  const net = deps.net ?? systemSecurityNet;
  return {
    async siteFile(site): Promise<SiteFileSecurity | undefined> {
      return (await siteContextForAddress(site, directory))?.security;
    },
    dns: (site, subdomains, signal) =>
      collectSiteDns(site, deps.resolver ?? systemResolver, {
        subdomains,
        maxSubdomains: Number.MAX_SAFE_INTEGER,
        ...(signal === undefined ? {} : { signal }),
      }),
    certificate: (site, origin, signal) =>
      collectSiteCertificate(site, deps.reader ?? systemCertificateReader, {
        ...(origin === undefined ? {} : { origin }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(signal === undefined ? {} : { signal }),
      }),
    publicFiles: (site, exposurePaths, signal) =>
      measurePublicFiles({ siteUrl: siteUrlOf(site), exposurePaths: validatedExposurePaths(exposurePaths) }, net, signal),
    publicApi: (site, signal) => measureWordpressPublicApi({ siteUrl: siteUrlOf(site) }, net, signal),
    async inspect(_site, server, signal) {
      if (environment[SERVER_GATHER_ENVIRONMENT] !== "1") return { status: "unmeasured", reason: SERVER_OFF_REASON };
      return measureWordpressInspect(server, deps.run ?? runWithExec(deps.exec), {
        ...(deps.now === undefined ? {} : { now: () => deps.now!().toISOString() }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
    homePage: (site, signal) => readHome(`${siteUrlOf(site)}/`, deps.getHome ?? systemGetHome, signal),
    async picture(site, home, signal) {
      // A page that did not answer cannot be pictured; do not launch a browser for it.
      if (home.status !== "measured") return { screenshot: { status: "unmeasured", reason: home.reason } };
      const url = `${siteUrlOf(site)}/`;
      const screenshot = await (deps.screenshot ?? ((address, s) =>
        measureScreenshot(address, { exec: deps.exec, ...(s === undefined ? {} : { signal: s }) })))(url, signal);
      return screenshot.status === "measured"
        ? { screenshot, step: (deps.imageStep ?? ((path: string) => ompImageStep(deps.exec, path)))(screenshot.path) }
        : { screenshot };
    },
  };
}

/** The daily run's ports over the owner's site files: which sites list `security`, and each site's address. */
export function dailyPorts(
  deps: LiveDeps,
  check: DailyPorts["check"],
): DailyPorts {
  const directory = deps.sitesDirectory ?? sitesDirectory(deps.environment ?? process.env);
  return {
    sites: () => securitySiteNames(directory),
    addressOf: async (name) => (await siteContextNamed(name, directory)).url,
    check,
  };
}
