import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  COMMAND_TIMEOUT_MS,
  type InspectCommand,
  measureWordpressInspect,
  type ProcessResult,
  type RunProcess,
  SERVER_GATHER_ENVIRONMENT,
  SERVER_OFF_REASON,
  type WordpressInspect,
} from "./inspect.ts";
import { siteContextForAddress, type SiteSecurity } from "./site_context.ts";

type Pi = Parameters<CustomToolFactory>[0];

/** What the server-reading tools take from outside: all optional, defaults are the real thing. */
export interface ServerDeps {
  /** Runs `ssh`; the factory wraps `pi.exec`. */
  run?: RunProcess;
  /** Where the owner's site files are; the default is `WEBMASTER_SITES_DIR` or `~/Developer/Zysys/webmaster/sites`. */
  sitesDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => string;
}

/** The real runner: omp's `exec`, a stopped command recorded as code -1, a cancelled run thrown. */
export function runWithPi(pi: Pi): RunProcess {
  return async (command, args, signal) => {
    const result = await pi.exec(command, [...args], {
      cwd: pi.cwd,
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

export interface ServerReading {
  inspect: WordpressInspect;
  /** What the site file says about the site's security, when it has a site file. Read only when the server was reached. */
  security?: SiteSecurity;
}

/**
 * Reads the named commands from the site's server, over SSH, read-only. Off unless `WEBMASTER_SECURITY_SERVER=1`: then
 * nothing is read, not even the site file, and the reading says why. The server comes from the site file's `host`
 * block; a site with no site file is unmeasured. A cancelled run throws.
 */
export async function readServer(
  site: string,
  commands: readonly InspectCommand[],
  deps: ServerDeps,
  run: RunProcess,
  signal?: AbortSignal,
): Promise<ServerReading> {
  const environment = deps.environment ?? process.env;
  if (environment[SERVER_GATHER_ENVIRONMENT] !== "1") {
    return { inspect: { status: "unmeasured", reason: SERVER_OFF_REASON } };
  }
  const context = await siteContextForAddress(site, deps.sitesDirectory);
  const inspect = await measureWordpressInspect(context?.security?.server, run, {
    only: commands,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(signal === undefined ? {} : { signal }),
  });
  return { inspect, ...(context?.security === undefined ? {} : { security: context.security }) };
}

/** The sentence every server-reading tool's description carries about how and when it reaches the server. */
export const SERVER_RULES =
  "It reads the server over SSH (BatchMode, the SSH agent; no password or key is read; 15 s to connect, 5 min per command) on the host in the site's file (`host` block under `WEBMASTER_SITES_DIR`, default `~/Developer/Zysys/webmaster/sites`), and ONLY when `WEBMASTER_SECURITY_SERVER=1` is set in omp's environment; otherwise the result is `unmeasured` and no connection is made. A site with no site file or host block is `unmeasured`.";

type Update = (update: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** Sends a progress line every `everyMs` until the returned function is called (in `finally`). */
export function heartbeat(onUpdate: unknown, label: string, everyMs = 10_000): () => void {
  const began = Date.now();
  const beat = setInterval(() => {
    (onUpdate as Update | undefined)?.({
      content: [{ type: "text", text: `${label} (${Math.round((Date.now() - began) / 1000)} s)` }],
      details: { status: "running" },
    });
  }, everyMs);
  return () => clearInterval(beat);
}
