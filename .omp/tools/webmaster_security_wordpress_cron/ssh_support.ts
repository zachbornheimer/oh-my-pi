import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectCommand, InspectOutput, ProcessResult } from "./inspect.ts";
import { ReplayServer } from "./replay_server.ts";
import type { ServerDeps } from "./server_reading.ts";
import type { MeasuredInspect } from "./wp_cli.ts";

/** Test helpers for the tools that read a server: recorded inspections, a site-file directory, the switch. */

export const NOW = () => "2026-10-27T15:00:00.000Z";
export const SERVER_ON = { WEBMASTER_SECURITY_SERVER: "1" } as const;

export function inspectFixture(name: "clean" | "compromised"): MeasuredInspect {
  const parsed = JSON.parse(readFileSync(new URL(`./fixtures/inspect_${name}.json`, import.meta.url), "utf8"));
  if (parsed.status !== "measured") throw new Error("the fixture is not a measurement");
  return parsed as MeasuredInspect;
}

/** The inspection with some commands' recorded output replaced. */
export function inspectWith(
  inspect: MeasuredInspect,
  replaced: Partial<Record<InspectCommand, Partial<InspectOutput>>>,
): MeasuredInspect {
  return {
    ...inspect,
    outputs: inspect.outputs.map((output) => ({ ...output, ...replaced[output.command] })),
  };
}

/** A recorded server for a fixture, with some commands' answers replaced. */
export const replay = (
  name: "clean" | "compromised",
  replaced: Partial<Record<InspectCommand, Partial<ProcessResult>>> = {},
) => new ReplayServer(inspectFixture(name).outputs, replaced);

/** A directory of site files; `host` is the host block, `extra` more top-level YAML. */
export function siteDirectory(options: { host?: string | null; extra?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wm3-sites-"));
  const host = options.host === undefined
    ? "host:\n  transport: ssh\n  target: example-host\n  wp_root: /var/www/example/httpdocs\n"
    : options.host ?? "";
  writeFileSync(join(directory, "example.yaml"), `name: example\nurl: https://example.org\n${host}${options.extra ?? ""}`);
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export const depsFor = (
  server: { run: ServerDeps["run"] },
  sitesDirectory: string,
  environment: ServerDeps["environment"] = SERVER_ON,
): ServerDeps => ({ ...(server.run === undefined ? {} : { run: server.run }), sitesDirectory, environment, now: NOW });

/** Words that, in a command sent to a production server, could change it. */
export const WRITE_WORDS =
  /(^|\s)(rm|mv|cp|chmod|chown|tee|dd|truncate|sed\s+-i|update|install|activate|deactivate|delete|create|set|-delete|-exec)(\s|$)|>/;
