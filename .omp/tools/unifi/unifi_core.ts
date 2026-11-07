import {
  type CredentialReader,
  fieldBool,
  fieldNumber,
  fieldText,
  isTruthy,
  readCredentialFile,
  resolveCredential,
} from "./credentials.ts";

/**
 * The UniFi console's HTTP surface: one base URL, one API key, and the five calls this tool makes. One place owns the
 * tolerant reading of replies whose envelope and field spelling differ between the console's APIs.
 *
 * Every path below answered 200 on the console on 2026-11-05 (ZYS-1544) with the Integration API key sent as
 * `X-API-KEY`:
 *
 *   GET  /proxy/network/integration/v1/sites                          the sites
 *   GET  /proxy/network/integration/v1/sites/{site}/devices           the devices
 *   POST /proxy/network/integration/v1/sites/{site}/devices/{device}/interfaces/ports/{idx}/actions
 *                                                                    {"action":"POWER_CYCLE"}, the only documented write
 *   GET  /proxy/protect/integration/v1/cameras                        Protect's own per-camera state
 *   GET  /proxy/network/api/s/{site}/stat/device                      the classic switch port tables
 *
 * Two paths the same ticket proved useless are deliberately absent: `POST /proxy/protect/api/cameras/{id}/reboot`
 * (403 to the Protect user) and `POST /proxy/network/api/s/default/cmd/devmgr` (403 to the read-only Network user).
 * Every failure throws: the tool wrapper turns a throw into a failed tool result.
 */

/** The kbit/s at or above which an up port reads `streaming`: the homelab's own declared line (a camera sending media sits at 4.6 Mbit/s, a hung one at 0.37 kbit/s). */
export const DEFAULT_THRESHOLD_KBIT = 1000;
/** How long `traffic` watches the counters when the caller does not say. */
export const DEFAULT_WINDOW_SECONDS = 20;
/** How long one HTTP call may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The classic site name used when the caller names no site and the console states none. */
export const CLASSIC_DEFAULT_SITE = "default";

export type UnifiEnv = Readonly<Record<string, string | undefined>>;
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface UnifiInput {
  readonly action: "sites" | "devices" | "cameras" | "ports" | "traffic" | "power_cycle_port";
  readonly site?: string | null | undefined;
  readonly device?: string | null | undefined;
  readonly port?: number | null | undefined;
  readonly window_seconds?: number | null | undefined;
  readonly threshold_kbit?: number | null | undefined;
}

export interface UnifiSite {
  id: string;
  name: string;
}
export interface UnifiDevice {
  id: string;
  mac: string | null;
  name: string;
  model: string | null;
  state: string | null;
}
export interface UnifiCamera {
  id: string;
  name: string;
  state: string | null;
  connected: boolean | null;
  last_seen_ms: number | null;
  up_since_ms: number | null;
  firmware: string | null;
  phy_rate_mbps: number | null;
}
export interface UnifiPort {
  device: string;
  port_idx: number;
  port_name: string | null;
  up: boolean | null;
  speed_mbps: number | null;
  full_duplex: boolean | null;
  poe_power_w: number | null;
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_errors: number | null;
  tx_errors: number | null;
  rx_dropped: number | null;
  tx_dropped: number | null;
  link_down_count: number | null;
}
export type UnifiPortVerdict = "streaming" | "silent" | "link_down" | "unknown";
export interface UnifiPortTraffic extends UnifiPort {
  rx_bytes_delta: number | null;
  tx_bytes_delta: number | null;
  link_down_count_delta: number | null;
  rx_bps: number | null;
  rx_kbit: number | null;
  counter_reset: boolean;
  verdict: UnifiPortVerdict;
}

export type UnifiOutput =
  | { action: "sites"; sites: UnifiSite[] }
  | { action: "devices"; site: UnifiSite; devices: UnifiDevice[] }
  | { action: "cameras"; cameras: UnifiCamera[] }
  | { action: "ports"; ports: UnifiPort[] }
  | {
    action: "traffic";
    window_seconds: number;
    measured_seconds: number;
    threshold_kbit: number;
    ports: UnifiPortTraffic[];
  }
  | { action: "power_cycle_port"; site: UnifiSite; device: UnifiDevice; port: number; status: number };

/** What a run reaches outside itself. Every one is a seam a test replaces; production passes nothing. */
export interface UnifiDeps {
  readonly env?: UnifiEnv | undefined;
  readonly fetch?: Fetch | undefined;
  readonly readFile?: CredentialReader | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  /** Told what a long step is doing (the `traffic` window), so the tool can stream a heartbeat. */
  readonly progress?: ((message: string) => void) | undefined;
}

/** The paths, as functions, so a test can assert the call shape without repeating a string. */
export const unifiPaths = {
  sites: () => "/proxy/network/integration/v1/sites",
  devices: (siteId: string) => `/proxy/network/integration/v1/sites/${encodeURIComponent(siteId)}/devices`,
  portActions: (siteId: string, deviceId: string, port: number) =>
    `/proxy/network/integration/v1/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}`
    + `/interfaces/ports/${port}/actions`,
  cameras: () => "/proxy/protect/integration/v1/cameras",
  statDevice: (classicSite: string = CLASSIC_DEFAULT_SITE) =>
    `/proxy/network/api/s/${encodeURIComponent(classicSite)}/stat/device`,
};

/** The reasons an input is refused, or an empty list. `null` reads as absent: models send it for an optional field. */
export function inputIssues(input: UnifiInput): string[] {
  const issues: string[] = [];
  if (!["sites", "devices", "cameras", "ports", "traffic", "power_cycle_port"].includes(input.action)) {
    return ["`action` must be one of sites, devices, cameras, ports, traffic, power_cycle_port"];
  }
  if (input.port != null && (!Number.isInteger(input.port) || input.port < 1 || input.port > 64)) {
    issues.push("`port` must be an integer from 1 to 64");
  }
  if (input.window_seconds != null && (!Number.isInteger(input.window_seconds) || input.window_seconds < 5 || input.window_seconds > 120)) {
    issues.push("`window_seconds` must be an integer from 5 to 120");
  }
  if (input.threshold_kbit != null && !(input.threshold_kbit > 0)) issues.push("`threshold_kbit` must be positive");
  if (input.action === "power_cycle_port") {
    if ((input.device ?? "") === "") issues.push("power_cycle_port requires `device`");
    if (input.port == null) issues.push("power_cycle_port requires `port`");
  }
  return issues;
}

/**
 * `text` when it is an http or https URL that carries no credentials, else a throw. The console is reached over HTTP,
 * and the API key travels in a header, so another scheme is no endpoint of this tool and `user:password@` in the URL
 * is a misconfiguration. A refusal never repeats `text`: it may hold the password.
 */
function checkedHttpUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("UNIFI_HOST is not a valid URL: give the console's base URL, for example https://192.168.5.1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`UNIFI_HOST must be an http or https URL, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("UNIFI_HOST must not carry credentials: the API key is sent as a header, not in the URL");
  }
  return text;
}

/**
 * The console's base URL: `UNIFI_HOST`, with `https://` assumed when it carries no scheme and any trailing slashes
 * dropped, so `192.168.5.1` and `https://192.168.5.1/` are the same console. Only an http or https URL without
 * credentials is a base URL; anything else is refused here, before any call.
 */
export function unifiBaseUrl(env: UnifiEnv): string {
  const raw = env.UNIFI_HOST?.trim();
  if (!raw) throw new Error("UNIFI_HOST is not set: give the console's base URL, for example https://192.168.5.1");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return checkedHttpUrl(withScheme.replace(/\/+$/, ""));
}

/**
 * The credential a call uses: `UNIFI_API_KEY`, else the file `UNIFI_API_KEY_FILE` names. That path may carry `#name`
 * to pick one line out of a file of secrets, such as `/config/secrets.yaml#unifi_integration_api_key`.
 */
export async function unifiCredential(
  env: UnifiEnv,
  readFileImpl: CredentialReader = readCredentialFile,
): Promise<string> {
  return resolveCredential({
    inline: env.UNIFI_API_KEY,
    file: env.UNIFI_API_KEY_FILE,
    fileVariable: "UNIFI_API_KEY_FILE",
    missing:
      "no UniFi credential: set UNIFI_API_KEY, or UNIFI_API_KEY_FILE to a file holding one (add `#name` to read "
      + "one line of a YAML secrets file). The key must be an Integration API key created on the console under "
      + "Control Plane -> Integrations.",
  }, readFileImpl);
}

interface Call {
  readonly method?: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

function httpFailure(path: string, status: number, text: string): string {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const hint = status === 401 || status === 403
    ? " — this tool sends X-API-KEY; the key must be an Integration API key from the console (Control Plane"
      + " -> Integrations), and UNIFI_HOST must be the console"
    : "";
  return `${path}: HTTP ${status}: ${detail}${hint}`;
}

/**
 * One console call: `X-API-KEY`, JSON in and JSON out. A non-2xx throws with the path and the status, so a caller
 * can tell a wrong key from a wrong host. Nothing is retried: the one write is a physical power-cycle.
 */
async function request(
  call: Call,
  baseUrl: string,
  credential: string,
  env: UnifiEnv,
  deps: UnifiDeps,
): Promise<Reply> {
  // `url` is `baseUrl` (checked by `unifiBaseUrl`) plus one of `unifiPaths`; the default sender hands fetch a parsed
  // `URL`, never the string.
  const send: Fetch = deps.fetch ?? ((url, init) => fetch(new URL(url), init));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
  const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    method: call.method ?? "GET",
    headers: {
      "X-API-KEY": credential,
      Accept: "application/json",
      ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    signal,
    // The console serves its own certificate, so https to it fails verification. `UNIFI_INSECURE_TLS` is the
    // operator's explicit opt-in, the same decision `curl -k` makes; unset, the certificate is verified.
    tls: { rejectUnauthorized: !isTruthy(env.UNIFI_INSECURE_TLS) },
  };
  let response: Response;
  let text: string;
  try {
    response = await send(`${baseUrl}${call.path}`, init);
    text = await response.text();
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    const maybeRan = call.method === "POST"
      ? " (the action may still have run: sample `traffic` for the port to check)"
      : "";
    if (timeout.aborted) throw new Error(`${call.path}: no reply within ${timeoutMs / 1000} s${maybeRan}`);
    throw new Error(`${call.path}: ${error instanceof Error ? error.message : String(error)}${maybeRan}`);
  }
  if (!response.ok) throw new Error(httpFailure(call.path, response.status, text));
  if (text.trim() === "") return { status: response.status, body: {} };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    throw new Error(
      `${call.path}: the reply is not JSON (${text.replace(/\s+/g, " ").slice(0, 120)}); check that UNIFI_HOST is `
        + "the console itself",
    );
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowArray(value: unknown): Row[] | undefined {
  return Array.isArray(value) && value.every(isRow) ? value : undefined;
}

/**
 * The rows of a UniFi list: a bare array (the Protect integration API), or the `{ data: [] }` envelope the Network
 * integration and classic APIs use. Anything else is a wrong host or a wrong path, said out loud.
 */
export function listRows(payload: unknown, what: string): readonly Row[] {
  const bare = rowArray(payload);
  if (bare !== undefined) return bare;
  const enveloped = isRow(payload) ? rowArray(payload.data) : undefined;
  if (enveloped !== undefined) return enveloped;
  throw new Error(
    `${what}: expected a list or a { data: [] } envelope, read ${JSON.stringify(payload)?.slice(0, 200) ?? "nothing"}`,
  );
}

/** The rows of one list-valued field (a port table), or none when the console did not state one. */
export function listOf(payload: unknown): readonly Row[] {
  return rowArray(payload) ?? [];
}

/** A site with the name the classic API addresses it by, when the console states one. */
interface ResolvedSite extends UnifiSite {
  readonly internalReference: string | null;
}

function siteRow(row: Row): ResolvedSite {
  const id = fieldText(row, "id", "_id") ?? "";
  return { id, name: fieldText(row, "name", "desc", "hostname") ?? id, internalReference: fieldText(row, "internalReference") };
}

export function deviceRow(row: Row): UnifiDevice {
  const id = fieldText(row, "id", "_id") ?? "";
  return {
    id,
    mac: fieldText(row, "macAddress", "mac"),
    name: fieldText(row, "name", "hostname", "displayName") ?? id,
    model: fieldText(row, "model", "modelKey", "shortname"),
    state: fieldText(row, "state", "status", "adopted"),
  };
}

/** One camera as Protect states it; `state` is Protect's own word and is never derived from `connected`. */
export function cameraRow(row: Row): UnifiCamera {
  return {
    id: fieldText(row, "id", "_id") ?? "",
    name: fieldText(row, "name") ?? "",
    state: fieldText(row, "state"),
    connected: fieldBool(row, "isConnected", "connected"),
    last_seen_ms: fieldNumber(row, "lastSeen", "lastSeenAt", "lastSeenMs"),
    up_since_ms: fieldNumber(row, "upSince", "upSinceMs"),
    firmware: fieldText(row, "firmwareVersion", "firmware", "version"),
    phy_rate_mbps: fieldNumber(row, "phyRate", "phyRateMbps"),
  };
}

/** One switch out of the classic `/stat/device` payload: its names, and the port table `ports`/`traffic` read. */
export interface SwitchPorts {
  readonly id: string | null;
  readonly mac: string | null;
  readonly name: string;
  readonly ports: readonly Row[];
}

/** Every switch in a classic `/stat/device` payload that reports a port table; access points and gateways have none. */
export function switchesOf(payload: unknown): readonly SwitchPorts[] {
  return listRows(payload, "the classic /stat/device reply")
    .map((row) => ({
      id: fieldText(row, "_id", "id"),
      mac: fieldText(row, "mac"),
      name: fieldText(row, "name", "hostname") ?? "",
      ports: listOf(row.port_table),
    }))
    .filter((switched) => switched.ports.length > 0);
}

/** One port table row as this tool states it: the console's own field names, null where it carries none. */
export function portState(device: string, port: Row): UnifiPort {
  return {
    device,
    port_idx: fieldNumber(port, "port_idx", "idx") ?? 0,
    port_name: fieldText(port, "name"),
    up: fieldBool(port, "up"),
    speed_mbps: fieldNumber(port, "speed"),
    full_duplex: fieldBool(port, "full_duplex"),
    poe_power_w: fieldNumber(port, "poe_power"),
    rx_bytes: fieldNumber(port, "rx_bytes"),
    tx_bytes: fieldNumber(port, "tx_bytes"),
    rx_errors: fieldNumber(port, "rx_errors"),
    tx_errors: fieldNumber(port, "tx_errors"),
    rx_dropped: fieldNumber(port, "rx_dropped"),
    tx_dropped: fieldNumber(port, "tx_dropped"),
    link_down_count: fieldNumber(port, "link_down_count"),
  };
}

/** A port read, with the identity of its switch: two switches may share a name, and one must not lend its index to another. */
export interface PortRead {
  readonly key: string;
  readonly port: UnifiPort;
}

/** The ports matching `port` (when given) of the chosen switches, in the console's order. */
export function selectPortReads(switches: readonly SwitchPorts[], port: number | undefined): readonly PortRead[] {
  return switches
    .flatMap((switched) =>
      switched.ports.map((row) => {
        const state = portState(switched.name, row);
        return { key: `${switched.id ?? switched.mac ?? switched.name}\u0000${state.port_idx}`, port: state };
      })
    )
    .filter((read) => port === undefined || read.port.port_idx === port);
}

/** True when `ref` reads as one of `candidates`: the same text ignoring case and surrounding space, or the same MAC. */
export function matchesRef(ref: string, ...candidates: readonly (string | null)[]): boolean {
  const wanted = ref.trim().toLowerCase();
  const wantedMac = normalizeMac(ref);
  return candidates.some((candidate) => {
    if (candidate === null || candidate === "") return false;
    if (candidate.trim().toLowerCase() === wanted) return true;
    const mac = normalizeMac(candidate);
    return mac.length >= 12 && mac === wantedMac;
  });
}

/** A MAC without its separators, lower-cased, so `F4:92:BF:11:22:33` and `f492bf112233` compare equal. */
export function normalizeMac(value: string): string {
  return value.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

interface CounterDelta {
  readonly delta: number | null;
  readonly reset: boolean;
}

function counterDelta(before: number | null, after: number | null): CounterDelta {
  if (before === null || after === null) return { delta: null, reset: false };
  if (after < before) return { delta: null, reset: true };
  return { delta: after - before, reset: false };
}

/**
 * The verdict for one port: `link_down` when it is down, `unknown` when no usable counter delta exists, else
 * `streaming` at or above the threshold and `silent` below it. `silent` on an up port is what a camera that answers
 * the network but sends no media looks like.
 */
export function verdictOf(up: boolean | null, rxKbit: number | null, thresholdKbit: number): UnifiPortVerdict {
  if (up === false) return "link_down";
  if (rxKbit === null) return "unknown";
  return rxKbit >= thresholdKbit ? "streaming" : "silent";
}

/**
 * The two reads of one port, differenced. Rates use the time that actually elapsed between the reads, not the window
 * the caller asked for. A port absent from the first read keeps its state and reads `unknown`: there is no delta.
 */
export function portTraffic(
  before: UnifiPort | null,
  after: UnifiPort,
  measuredSeconds: number,
  thresholdKbit: number,
): UnifiPortTraffic {
  const rx = counterDelta(before?.rx_bytes ?? null, after.rx_bytes);
  const tx = counterDelta(before?.tx_bytes ?? null, after.tx_bytes);
  const linkDowns = counterDelta(before?.link_down_count ?? null, after.link_down_count);
  const rxBps = rx.delta === null || measuredSeconds <= 0 ? null : rx.delta / measuredSeconds;
  const rxKbit = rxBps === null ? null : (rxBps * 8) / 1000;
  return {
    ...after,
    rx_bytes_delta: rx.delta,
    tx_bytes_delta: tx.delta,
    link_down_count_delta: linkDowns.delta,
    rx_bps: rxBps,
    rx_kbit: rxKbit,
    counter_reset: rx.reset,
    verdict: verdictOf(after.up, rxKbit, thresholdKbit),
  };
}

type Run = (request_: Call) => Promise<Reply>;

/** `Name (id)` per row: what every refusal lists so a caller can fix it in one step. */
function named(rows: readonly { readonly id: string; readonly name: string }[]): string {
  return rows.map((row) => `${row.name} (${row.id})`).join(", ");
}

async function listSites(call: Run): Promise<readonly ResolvedSite[]> {
  const reply = await call({ path: unifiPaths.sites() });
  return listRows(reply.body, "the sites reply").map(siteRow).filter((site) => site.id !== "");
}

/**
 * The site of the console a run addresses. `site` (or `UNIFI_SITE`) names it; a console with several sites and no
 * name refuses rather than guessing, so a power-cycle never lands on the wrong site.
 */
async function resolveSite(call: Run, env: UnifiEnv, requested: string | null | undefined): Promise<ResolvedSite> {
  const sites = await listSites(call);
  if (sites.length === 0) throw new Error("the console lists no sites for this credential");
  const ref = requested ?? env.UNIFI_SITE?.trim();
  if (ref === undefined || ref === null || ref === "") {
    if (sites.length === 1) return sites[0]!;
    throw new Error(`the console lists ${sites.length} sites (${named(sites)}); pass \`site\` or set UNIFI_SITE`);
  }
  const matched = sites.filter((site) => matchesRef(ref, site.name, site.id));
  if (matched.length === 1) return matched[0]!;
  if (matched.length === 0) throw new Error(`no site matches ${JSON.stringify(ref)}; the console lists ${named(sites)}`);
  throw new Error(`${JSON.stringify(ref)} matches ${matched.length} sites (${named(matched)}); pass the site id`);
}

/**
 * The classic API's name for the site `ports` and `traffic` read. With no `site` and no `UNIFI_SITE` it is `default`,
 * as before; with one, the console's own `internalReference` for that site (`default` when it states none).
 */
async function classicSiteOf(call: Run, env: UnifiEnv, requested: string | null | undefined): Promise<string> {
  const ref = requested ?? env.UNIFI_SITE?.trim();
  if (ref === undefined || ref === null || ref === "") return CLASSIC_DEFAULT_SITE;
  return (await resolveSite(call, env, ref)).internalReference ?? CLASSIC_DEFAULT_SITE;
}

async function listDevices(call: Run, siteId: string): Promise<readonly UnifiDevice[]> {
  const reply = await call({ path: unifiPaths.devices(siteId) });
  return listRows(reply.body, `the devices reply for site ${siteId}`).map(deviceRow).filter((device) => device.id !== "");
}

/** One device of the site, by id, MAC or name. An ambiguous reference is refused with the candidates. */
async function resolveDevice(call: Run, siteId: string, ref: string): Promise<UnifiDevice> {
  const devices = await listDevices(call, siteId);
  const matched = devices.filter((device) => matchesRef(ref, device.name, device.mac, device.id));
  if (matched.length === 1) return matched[0]!;
  const listed = devices.map((device) => `${device.name}${device.mac === null ? "" : ` ${device.mac}`}`).join(", ")
    || "no device at all";
  if (matched.length === 0) {
    throw new Error(`no device on site ${siteId} matches ${JSON.stringify(ref)}; the console lists ${listed}`);
  }
  throw new Error(`${JSON.stringify(ref)} matches ${matched.length} devices on site ${siteId} (${listed}); pass the device id`);
}

async function listCameras(call: Run): Promise<readonly UnifiCamera[]> {
  const reply = await call({ path: unifiPaths.cameras() });
  return listRows(reply.body, "the Protect cameras reply").map(cameraRow).filter((camera) => camera.id !== "");
}

/**
 * The switches whose port tables this run may read. `device` filters them by name, MAC or id; a reference that
 * matches nothing is refused with the switch names, because an empty port list would read as "nothing wrong".
 */
async function portTables(call: Run, classicSite: string, device: string | null | undefined): Promise<readonly SwitchPorts[]> {
  const switches = switchesOf((await call({ path: unifiPaths.statDevice(classicSite) })).body);
  if (device === undefined || device === null) return switches;
  const matched = switches.filter((switched) => matchesRef(device, switched.name, switched.mac, switched.id));
  if (matched.length === 0) {
    const listed = switches.map((switched) => switched.name || switched.mac || "unnamed").join(", ")
      || "no switch reports a port table";
    throw new Error(`no switch matches \`device\` ${JSON.stringify(device)}; the port tables carry ${listed}`);
  }
  return matched;
}

/**
 * The port indexes the switch's own table carries. `power_cycle_port` checks the index against these before it
 * writes: a power-cycle lands on a physical port, so an index that cannot be confirmed is one that could take down
 * whatever else is plugged in beside the device the caller meant.
 */
async function portIndexesOf(call: Run, classicSite: string, device: UnifiDevice): Promise<readonly number[]> {
  const switches = switchesOf((await call({ path: unifiPaths.statDevice(classicSite) })).body);
  const matched = switches.filter((switched) =>
    matchesRef(device.name, switched.name) || (device.mac === null ? false : matchesRef(device.mac, switched.mac))
  );
  if (matched.length !== 1) {
    const listed = switches.map((switched) => `${switched.name}${switched.mac === null ? "" : ` ${switched.mac}`}`)
      .join(", ") || "none";
    throw new Error(
      `the port table of ${device.name} is not unambiguous (${matched.length} of ${listed} match); refusing to `
        + "power-cycle an index that cannot be checked",
    );
  }
  return matched[0]!.ports.map((row) => fieldNumber(row, "port_idx", "idx") ?? 0).filter((index) => index > 0);
}

const systemSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const stop = (): void => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", stop);
    resolve();
  }, ms);
  signal?.addEventListener("abort", stop, { once: true });
  return promise;
};

/** Answer one console question. Throws, with the reason as the message, when it cannot. */
export async function runUnifi(input: UnifiInput, deps: UnifiDeps = {}): Promise<UnifiOutput> {
  const issues = inputIssues(input);
  if (issues.length > 0) throw new Error(`invalid input for unifi: ${issues.join("; ")}`);
  const env = deps.env ?? process.env;
  const baseUrl = unifiBaseUrl(env);
  const credential = await unifiCredential(env, deps.readFile);
  const call: Run = (request_) => request(request_, baseUrl, credential, env, deps);
  const publicSite = (site: ResolvedSite): UnifiSite => ({ id: site.id, name: site.name });

  switch (input.action) {
    case "sites":
      return { action: "sites", sites: (await listSites(call)).map(publicSite) };

    case "devices": {
      const site = await resolveSite(call, env, input.site);
      return { action: "devices", site: publicSite(site), devices: [...await listDevices(call, site.id)] };
    }

    case "cameras":
      return { action: "cameras", cameras: [...await listCameras(call)] };

    case "ports": {
      const classicSite = await classicSiteOf(call, env, input.site);
      const switches = await portTables(call, classicSite, input.device);
      return { action: "ports", ports: selectPortReads(switches, input.port ?? undefined).map((read) => read.port) };
    }

    case "traffic": {
      const windowSeconds = input.window_seconds ?? DEFAULT_WINDOW_SECONDS;
      const thresholdKbit = input.threshold_kbit ?? DEFAULT_THRESHOLD_KBIT;
      const now = deps.now ?? Date.now;
      const sleep = deps.sleep ?? systemSleep;
      const classicSite = await classicSiteOf(call, env, input.site);
      const before = selectPortReads(await portTables(call, classicSite, input.device), input.port ?? undefined);
      const startedAt = now();
      deps.progress?.(`traffic: first read taken, watching the counters for ${windowSeconds} s`);
      await sleep(windowSeconds * 1000, deps.signal);
      const after = selectPortReads(await portTables(call, classicSite, input.device), input.port ?? undefined);
      // The measured window, not the requested one: an HTTP read on either side can stretch it, and a rate computed
      // against the wrong denominator is the kind of number this tool exists to replace.
      const measuredSeconds = Math.max(now() - startedAt, 1) / 1000;
      const first = new Map(before.map((read) => [read.key, read.port]));
      return {
        action: "traffic",
        window_seconds: windowSeconds,
        measured_seconds: measuredSeconds,
        threshold_kbit: thresholdKbit,
        ports: after.map((read) => portTraffic(first.get(read.key) ?? null, read.port, measuredSeconds, thresholdKbit)),
      };
    }

    case "power_cycle_port": {
      const site = await resolveSite(call, env, input.site);
      const device = await resolveDevice(call, site.id, input.device!);
      const port = input.port!;
      const indexes = await portIndexesOf(call, site.internalReference ?? CLASSIC_DEFAULT_SITE, device);
      if (!indexes.includes(port)) {
        throw new Error(
          `${device.name} carries no port ${port}; its port table has ${indexes.join(", ")}. Refusing the power-cycle.`,
        );
      }
      const reply = await call({
        method: "POST",
        path: unifiPaths.portActions(site.id, device.id, port),
        body: { action: "POWER_CYCLE" },
      });
      return { action: "power_cycle_port", site: publicSite(site), device, port, status: reply.status };
    }
  }
}
