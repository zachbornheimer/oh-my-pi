/**
 * The unifi tool against the console's own words: the streaming verdict that separates a hung camera from a
 * recording one, the credential footguns the ticket paid for, and the one declared write. Ported from the Mastra
 * capability's bun tests. Nothing here touches a console: the fetch, the clock and the wait are all handed in (the one
 * run that uses the real fetch talks to a loopback server it starts itself), and the counter numbers are the
 * ticket's own capture (ZYS-1544).
 */
import { describe, expect, it } from "bun:test";
import { normalizeCredential, yamlValue } from "./credentials.ts";
import { DESCRIPTION, buildTool } from "./index.ts";
import {
  DEFAULT_THRESHOLD_KBIT,
  type Fetch,
  type UnifiEnv,
  type UnifiPort,
  inputIssues,
  listRows,
  portTraffic,
  runUnifi,
  unifiBaseUrl,
  unifiCredential,
  unifiPaths,
} from "./unifi_core.ts";

/** The console's own site and switches, as the classic stat reply and the integration API spell them. */
const SITE = { id: "88f7af54-98f8-306a-a1c7-c9349722b1f6", name: "Zach's House" };
const GARAGE = { name: "Garage Switch", mac: "f4:92:bf:aa:bb:01", id: "68f0aa01" };
const GAZEBO = { name: "Gazebo Switch", mac: "f4:92:bf:aa:bb:02", id: "68f0aa02" };
const GARAGE_INTEGRATION_ID = "07ba4fc8-6daf-3201-8994-d7b11ee02f6d";

const environment: UnifiEnv = { UNIFI_HOST: "192.168.5.1", UNIFI_API_KEY: "'console-key'", UNIFI_SITE: SITE.name };
/** The same console with no default site: `ports` and `traffic` read the classic `default` site without a lookup. */
const noSite: UnifiEnv = { UNIFI_HOST: "192.168.5.1", UNIFI_API_KEY: "'console-key'" };

interface PortSpec {
  readonly port: number;
  readonly rx: number;
  readonly up?: boolean;
  readonly linkDowns?: number;
  readonly poe?: string;
}

function switchTable(device: { name: string; mac: string; id: string }, ports: readonly PortSpec[]): unknown {
  return {
    _id: device.id,
    name: device.name,
    mac: device.mac,
    model: "US68P",
    port_table: ports.map((spec) => ({
      port_idx: spec.port,
      name: `Port ${spec.port}`,
      up: spec.up ?? true,
      speed: 100,
      full_duplex: true,
      poe_power: spec.poe ?? "3.40",
      rx_bytes: spec.rx,
      tx_bytes: spec.rx + 1,
      rx_errors: 0,
      tx_errors: 0,
      rx_dropped: 0,
      tx_dropped: 0,
      link_down_count: spec.linkDowns ?? 12,
    })),
  };
}

function statReply(devices: readonly unknown[]): unknown {
  return { meta: { rc: "ok" }, data: devices };
}

function integrationDevice(): unknown {
  return { id: GARAGE_INTEGRATION_ID, macAddress: GARAGE.mac, name: GARAGE.name, model: "US68P" };
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers `replies` in order (repeating the last) and records every call. */
function recordings(replies: readonly unknown[]): { readonly fetch: Fetch; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl: Fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(reply ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, calls };
}

function state(rx: number | null, overrides: Partial<UnifiPort> = {}): UnifiPort {
  return {
    device: GARAGE.name,
    port_idx: 5,
    port_name: "Garage Cam",
    up: true,
    speed_mbps: 100,
    full_duplex: true,
    poe_power_w: 3.4,
    rx_bytes: rx,
    tx_bytes: rx,
    rx_errors: 0,
    tx_errors: 0,
    rx_dropped: 0,
    tx_dropped: 0,
    link_down_count: 12,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("the streaming threshold", () => {
  it("calls a hung camera silent and a recording one streaming, on the capture's own numbers", () => {
    // 25 s on the hung port: rx +1152 B.
    const hang = portTraffic(state(373_542_745_324), state(373_542_746_476), 25, DEFAULT_THRESHOLD_KBIT);
    // 15 s on three ports that were sending media; the last is the same port 90 s after a power-cycle.
    const gazebo = portTraffic(state(100_000_000), state(108_380_917), 15, DEFAULT_THRESHOLD_KBIT);
    const shed = portTraffic(state(100_000_000), state(109_223_157), 15, DEFAULT_THRESHOLD_KBIT);
    const recovered = portTraffic(state(100_000_000), state(108_692_595), 15, DEFAULT_THRESHOLD_KBIT);

    expect(hang.rx_bytes_delta).toBe(1152);
    expect(hang.rx_kbit!).toBeCloseTo(0.36864, 5);
    expect(hang.verdict).toBe("silent");

    expect(gazebo.rx_bytes_delta).toBe(8_380_917);
    expect(gazebo.rx_kbit!).toBeCloseTo(4469.8224, 2);
    expect(shed.rx_kbit!).toBeCloseTo(4919.0171, 2);
    expect(recovered.rx_kbit!).toBeCloseTo(4636.0507, 2);
    expect([gazebo.verdict, shed.verdict, recovered.verdict]).toEqual(["streaming", "streaming", "streaming"]);

    expect(hang.rx_kbit!).toBeLessThan(DEFAULT_THRESHOLD_KBIT / 100);
    expect(Math.min(gazebo.rx_kbit!, shed.rx_kbit!, recovered.rx_kbit!)).toBeGreaterThan(DEFAULT_THRESHOLD_KBIT);
  });

  it("reads a down port as link_down whatever its counters say", () => {
    expect(portTraffic(state(1000), state(2000, { up: false }), 20, DEFAULT_THRESHOLD_KBIT).verdict).toBe("link_down");
  });

  it("answers unknown when a counter is missing, and says so when one went backwards", () => {
    const missing = portTraffic(state(null), state(null), 20, DEFAULT_THRESHOLD_KBIT);
    expect(missing.rx_bps).toBeNull();
    expect(missing.verdict).toBe("unknown");

    const reset = portTraffic(state(9_000), state(10), 20, DEFAULT_THRESHOLD_KBIT);
    expect(reset.rx_bytes_delta).toBeNull();
    expect(reset.counter_reset).toBe(true);
    expect(reset.verdict).toBe("unknown");
  });

  it("reads a port absent from the first sample as unknown rather than inventing a delta", () => {
    const appeared = portTraffic(null, state(5000), 20, DEFAULT_THRESHOLD_KBIT);
    expect(appeared.rx_bytes_delta).toBeNull();
    expect(appeared.verdict).toBe("unknown");
  });

  it("counts the link_down step and the PoE change that make a power-cycle visible", () => {
    const cycled = portTraffic(
      state(1000, { link_down_count: 12 }),
      state(2000, { link_down_count: 13, poe_power_w: 0 }),
      20,
      DEFAULT_THRESHOLD_KBIT,
    );
    expect(cycled.link_down_count_delta).toBe(1);
    expect(cycled.poe_power_w).toBe(0);
  });

  it("rates against the time that elapsed, not the window that was asked for", () => {
    expect(portTraffic(state(0), state(1152), 96, DEFAULT_THRESHOLD_KBIT).rx_bps).toBeCloseTo(12, 5);
  });
});

describe("the credential", () => {
  it("strips the YAML quotes the console 401s on, and only that pair", () => {
    expect(normalizeCredential("'abc123'")).toBe("abc123");
    expect(normalizeCredential('"abc123"')).toBe("abc123");
    expect(normalizeCredential("  abc123\n")).toBe("abc123");
    expect(normalizeCredential("ab'c123")).toBe("ab'c123");
    expect(normalizeCredential("'abc123")).toBe("'abc123");
    expect(normalizeCredential('""')).toBe("");
  });

  it("reads one line out of a secrets file, dropping a trailing comment", () => {
    const secrets = ["# home assistant secrets", "unifi_integration_api_key: 'k-123'  # rotated 2026-11-05", "empty:"].join("\n");
    expect(yamlValue(secrets, "unifi_integration_api_key")).toBe("'k-123'");
    expect(yamlValue(secrets, "absent")).toBeNull();
    expect(yamlValue(secrets, "empty")).toBeNull();
  });

  it("takes the key from the environment, else the file, else says what is missing", async () => {
    expect(await unifiCredential({ UNIFI_API_KEY: '"k"', UNIFI_API_KEY_FILE: "/nope" })).toBe("k");

    const paths: string[] = [];
    const reader = async (path: string): Promise<string> => {
      paths.push(path);
      return "unifi_integration_api_key: 'from-file'\n";
    };
    expect(await unifiCredential({ UNIFI_API_KEY_FILE: "/config/secrets.yaml#unifi_integration_api_key" }, reader)).toBe("from-file");
    expect(paths).toEqual(["/config/secrets.yaml"]);
    expect(await unifiCredential({ UNIFI_API_KEY_FILE: "/key.txt" }, async () => " bare \n")).toBe("bare");

    await expect(unifiCredential({}, async () => "")).rejects.toThrow("UNIFI_API_KEY");
    await expect(unifiCredential({ UNIFI_API_KEY_FILE: "/k.yaml#nope" }, async () => "a: b\n")).rejects.toThrow("states no `nope` line");
    await expect(
      unifiCredential({ UNIFI_API_KEY_FILE: "/missing" }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("could not be read");
    await expect(unifiCredential({ UNIFI_API_KEY_FILE: "/blank" }, async () => " \n")).rejects.toThrow("empty credential");
  });

  it("takes the console's base URL with or without a scheme", () => {
    expect(unifiBaseUrl({ UNIFI_HOST: "192.168.5.1" })).toBe("https://192.168.5.1");
    expect(unifiBaseUrl({ UNIFI_HOST: "https://udm.example/" })).toBe("https://udm.example");
    expect(unifiBaseUrl({ UNIFI_HOST: " http://console:8080 " })).toBe("http://console:8080");
    expect(() => unifiBaseUrl({})).toThrow("UNIFI_HOST");
  });
});

describe("the reply boundary", () => {
  it("reads both list envelopes and refuses anything else out loud", () => {
    expect(listRows([{ a: 1 }], "x")).toEqual([{ a: 1 }]);
    expect(listRows({ offset: 0, count: 1, data: [{ a: 1 }] }, "x")).toEqual([{ a: 1 }]);
    expect(() => listRows({ error: "unauthorized" }, "the sites reply")).toThrow(
      "the sites reply: expected a list or a { data: [] } envelope",
    );
  });
});

describe("the console calls", () => {
  it("samples the port table twice and names the hung port silent while a recording one streams", async () => {
    const before = statReply([
      switchTable(GARAGE, [{ port: 5, rx: 373_542_745_324 }]),
      switchTable(GAZEBO, [{ port: 4, rx: 100_000_000 }]),
    ]);
    const after = statReply([
      switchTable(GARAGE, [{ port: 5, rx: 373_542_746_476 }]),
      switchTable(GAZEBO, [{ port: 4, rx: 108_380_917 }]),
    ]);
    const { fetch: stub, calls } = recordings([before, after]);
    let clock = 0;
    const slept: number[] = [];
    const progress: string[] = [];

    const output = await runUnifi(
      { action: "traffic", window_seconds: 25 },
      {
        env: noSite,
        fetch: stub,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        progress: (message) => progress.push(message),
      },
    );

    if (output.action !== "traffic") throw new Error(`expected traffic, got ${JSON.stringify(output)}`);
    expect(output.window_seconds).toBe(25);
    expect(output.measured_seconds).toBe(25);
    expect(output.threshold_kbit).toBe(DEFAULT_THRESHOLD_KBIT);

    const hung = output.ports.find((port) => port.device === GARAGE.name && port.port_idx === 5)!;
    const recording = output.ports.find((port) => port.device === GAZEBO.name && port.port_idx === 4)!;
    expect(hung.rx_bytes_delta).toBe(1152);
    expect(hung.verdict).toBe("silent");
    expect(recording.rx_bytes_delta).toBe(8_380_917);
    expect(recording.verdict).toBe("streaming");

    expect(slept).toEqual([25_000]);
    expect(progress).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual([
      `https://192.168.5.1${unifiPaths.statDevice()}`,
      `https://192.168.5.1${unifiPaths.statDevice()}`,
    ]);
    expect(unifiPaths.statDevice()).toBe("/proxy/network/api/s/default/stat/device");
    expect(new Headers(calls[0]!.init?.headers).get("x-api-key")).toBe("console-key");
  });

  it("does not hand one switch's port index to another switch that shares its name", async () => {
    const twinA = { name: "Twin", mac: "f4:92:bf:aa:bb:0a", id: "a" };
    const twinB = { name: "Twin", mac: "f4:92:bf:aa:bb:0b", id: "b" };
    const before = statReply([switchTable(twinA, [{ port: 1, rx: 0 }]), switchTable(twinB, [{ port: 1, rx: 1_000_000 }])]);
    const after = statReply([switchTable(twinA, [{ port: 1, rx: 125_000 }]), switchTable(twinB, [{ port: 1, rx: 1_250_000 }])]);
    const { fetch: stub } = recordings([before, after]);
    let clock = 0;
    const output = await runUnifi(
      { action: "traffic", window_seconds: 10 },
      { env: noSite, fetch: stub, now: () => clock, sleep: async (ms) => void (clock += ms) },
    );
    if (output.action !== "traffic") throw new Error("expected traffic");
    expect(output.ports.map((port) => port.rx_bytes_delta)).toEqual([125_000, 250_000]);
  });

  it("reads the classic table of the site it was told, not always `default`", async () => {
    const { fetch: stub, calls } = recordings([
      { data: [{ id: SITE.id, name: SITE.name, internalReference: "site-two" }] },
      statReply([switchTable(GARAGE, [{ port: 5, rx: 1000 }])]),
    ]);
    const output = await runUnifi({ action: "ports", site: SITE.name }, { env: noSite, fetch: stub });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      unifiPaths.sites(),
      "/proxy/network/api/s/site-two/stat/device",
    ]);
    expect(output).toMatchObject({ action: "ports", ports: [{ device: GARAGE.name, port_idx: 5 }] });
  });

  it("falls back to the classic `default` site when the console states no internalReference", async () => {
    const { fetch: stub, calls } = recordings([
      { data: [SITE] },
      statReply([switchTable(GARAGE, [{ port: 5, rx: 1000 }])]),
    ]);
    await runUnifi({ action: "ports" }, { env: environment, fetch: stub });
    expect(new URL(calls[1]!.url).pathname).toBe("/proxy/network/api/s/default/stat/device");
  });

  it("filters ports by device and port, and treats null filters as absent", async () => {
    const reply = statReply([
      switchTable(GARAGE, [{ port: 5, rx: 1 }, { port: 6, rx: 2 }]),
      switchTable(GAZEBO, [{ port: 5, rx: 3 }]),
    ]);
    const one = recordings([reply]);
    const output = await runUnifi({ action: "ports", device: "F4:92:BF:AA:BB:01", port: 6 }, { env: noSite, fetch: one.fetch });
    expect(output).toMatchObject({ action: "ports", ports: [{ device: GARAGE.name, port_idx: 6, rx_bytes: 2 }] });
    const all = recordings([reply]);
    const everything = await runUnifi(
      { action: "ports", site: null, device: null, port: null },
      { env: noSite, fetch: all.fetch },
    );
    expect(everything).toMatchObject({ action: "ports" });
    if (everything.action === "ports") expect(everything.ports).toHaveLength(3);
  });

  it("power-cycles the index the console's own action takes, after checking it against the port table", async () => {
    const { fetch: stub, calls } = recordings([
      { offset: 0, count: 1, data: [SITE] },
      { offset: 0, count: 1, data: [integrationDevice()] },
      statReply([switchTable(GARAGE, [{ port: 5, rx: 1000 }, { port: 6, rx: 2000 }])]),
      {},
    ]);

    const output = await runUnifi({ action: "power_cycle_port", device: "Garage Switch", port: 5 }, { env: environment, fetch: stub });

    expect(output).toEqual({
      action: "power_cycle_port",
      site: SITE,
      device: { id: GARAGE_INTEGRATION_ID, mac: GARAGE.mac, name: GARAGE.name, model: "US68P", state: null },
      port: 5,
      status: 200,
    });
    const action = calls[3]!;
    expect(action.url).toBe(`https://192.168.5.1${unifiPaths.portActions(SITE.id, GARAGE_INTEGRATION_ID, 5)}`);
    expect(action.init?.method).toBe("POST");
    expect(String(action.init?.body)).toBe('{"action":"POWER_CYCLE"}');
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  it("refuses a power-cycle on an index the switch's own table does not carry, before writing", async () => {
    const { fetch: stub, calls } = recordings([
      { offset: 0, count: 1, data: [SITE] },
      { offset: 0, count: 1, data: [integrationDevice()] },
      statReply([switchTable(GARAGE, [{ port: 5, rx: 1000 }, { port: 6, rx: 2000 }])]),
    ]);

    const said = await failure(runUnifi({ action: "power_cycle_port", device: "Garage Switch", port: 9 }, { env: environment, fetch: stub }));

    expect(said).toContain("carries no port 9");
    expect(said).toContain("5, 6");
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  it("refuses a power-cycle whose switch cannot be matched to exactly one port table", async () => {
    const { fetch: stub, calls } = recordings([
      { data: [SITE] },
      { data: [integrationDevice()] },
      statReply([switchTable(GAZEBO, [{ port: 5, rx: 1 }])]),
    ]);
    const said = await failure(runUnifi({ action: "power_cycle_port", device: "Garage Switch", port: 5 }, { env: environment, fetch: stub }));
    expect(said).toContain("not unambiguous");
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  it("says a power-cycle that timed out may still have run, and never retries it", async () => {
    const calls: string[] = [];
    const answers = [{ data: [SITE] }, { data: [integrationDevice()] }, statReply([switchTable(GARAGE, [{ port: 5, rx: 1 }])])];
    const stub: Fetch = (url, init) => {
      calls.push(`${init?.method} ${url}`);
      const answer = answers.shift();
      if (answer !== undefined) return Promise.resolve(new Response(JSON.stringify(answer)));
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      return promise;
    };
    const said = await failure(
      runUnifi({ action: "power_cycle_port", device: "Garage Switch", port: 5 }, { env: environment, fetch: stub, timeoutMs: 20 }),
    );
    expect(said).toContain("no reply within 0.02 s");
    expect(said).toContain("may still have run");
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  it("refuses a device it cannot match, naming the switches it could have meant", async () => {
    const { fetch: stub } = recordings([statReply([switchTable(GARAGE, [{ port: 5, rx: 1000 }])])]);
    const said = await failure(runUnifi({ action: "ports", device: "Shed Switch" }, { env: noSite, fetch: stub }));
    expect(said).toContain('no switch matches `device` "Shed Switch"');
    expect(said).toContain("Garage Switch");
  });

  it("reads Protect's own camera state, and states nothing it was not told", async () => {
    const { fetch: stub } = recordings([
      [
        {
          id: "65baf44a01ea1603e40004b1",
          name: "Garage Cam",
          state: "DISCONNECTED",
          isConnected: false,
          lastSeen: 1793792454119,
          upSince: 1793779604364,
          firmwareVersion: "5.5.45",
          phyRate: 100,
        },
        { id: "65baf44a01ea1603e40004b2", name: "Firepit Cam", state: "CONNECTED" },
      ],
    ]);

    const output = await runUnifi({ action: "cameras" }, { env: environment, fetch: stub });

    expect(output).toEqual({
      action: "cameras",
      cameras: [
        {
          id: "65baf44a01ea1603e40004b1",
          name: "Garage Cam",
          state: "DISCONNECTED",
          connected: false,
          last_seen_ms: 1793792454119,
          up_since_ms: 1793779604364,
          firmware: "5.5.45",
          phy_rate_mbps: 100,
        },
        {
          id: "65baf44a01ea1603e40004b2",
          name: "Firepit Cam",
          state: "CONNECTED",
          connected: null,
          last_seen_ms: null,
          up_since_ms: null,
          firmware: null,
          phy_rate_mbps: null,
        },
      ],
    });
  });

  it("lists sites and devices without the console's internal site reference", async () => {
    const sites = recordings([{ data: [{ ...SITE, internalReference: "default" }] }]);
    expect(await runUnifi({ action: "sites" }, { env: environment, fetch: sites.fetch })).toEqual({ action: "sites", sites: [SITE] });
    const devices = recordings([{ data: [SITE] }, { data: [integrationDevice()] }]);
    const output = await runUnifi({ action: "devices" }, { env: environment, fetch: devices.fetch });
    expect(output).toMatchObject({ action: "devices", site: SITE, devices: [{ id: GARAGE_INTEGRATION_ID, name: GARAGE.name }] });
    expect(JSON.stringify(output)).not.toContain("internalReference");
  });

  it("refuses to guess the site when the console lists several and none is named", async () => {
    const { fetch: stub } = recordings([{ offset: 0, count: 2, data: [SITE, { id: "other", name: "Other" }] }]);
    const said = await failure(runUnifi({ action: "devices" }, { env: { UNIFI_HOST: "console", UNIFI_API_KEY: "k" }, fetch: stub }));
    expect(said).toContain("lists 2 sites");
    expect(said).toContain("UNIFI_SITE");
  });

  it("refuses an unknown site, naming the ones the console lists", async () => {
    const { fetch: stub } = recordings([{ data: [SITE] }]);
    const said = await failure(runUnifi({ action: "devices", site: "Nowhere" }, { env: environment, fetch: stub }));
    expect(said).toContain('no site matches "Nowhere"');
    expect(said).toContain(SITE.name);
  });

  it("fails a rejected key naming the header it sent, without echoing the key", async () => {
    const fetchImpl: Fetch = async () =>
      new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json" } });
    const said = await failure(runUnifi({ action: "sites" }, { env: environment, fetch: fetchImpl }));
    expect(said).toContain(unifiPaths.sites());
    expect(said).toContain("HTTP 401");
    expect(said).toContain("X-API-KEY");
    expect(said).not.toContain("console-key");
  });

  it("fails a reply that is not JSON, and a hung console by its timeout", async () => {
    const html = recordings([]);
    const notJson: Fetch = async () => new Response("<html>login</html>", { status: 200 });
    expect(await failure(runUnifi({ action: "sites" }, { env: environment, fetch: notJson }))).toContain("the reply is not JSON");
    expect(html.calls).toHaveLength(0);
    const hung: Fetch = (_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      return promise;
    };
    expect(await failure(runUnifi({ action: "sites" }, { env: environment, fetch: hung, timeoutMs: 20 }))).toBe(
      `${unifiPaths.sites()}: no reply within 0.02 s`,
    );
  });

  it("stops a traffic window when the caller cancels, before the second read", async () => {
    const controller = new AbortController();
    const { fetch: stub, calls } = recordings([statReply([switchTable(GARAGE, [{ port: 5, rx: 1 }])])]);
    const pending = failure(
      runUnifi(
        { action: "traffic" },
        {
          env: noSite,
          fetch: stub,
          signal: controller.signal,
          sleep: (_ms, signal) => {
            const { promise, reject } = Promise.withResolvers<void>();
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            controller.abort(new Error("cancelled by caller"));
            return promise;
          },
        },
      ),
    );
    expect(await pending).toBe("cancelled by caller");
    expect(calls).toHaveLength(1);
  });

  it("calls nothing when the host or the key is missing", async () => {
    const { fetch: stub, calls } = recordings([{}]);
    expect(await failure(runUnifi({ action: "sites" }, { env: {}, fetch: stub }))).toContain("UNIFI_HOST is not set");
    expect(await failure(runUnifi({ action: "sites" }, { env: { UNIFI_HOST: "c" }, fetch: stub }))).toContain("no UniFi credential");
    expect(calls).toHaveLength(0);
  });

  it("refuses a host that is not an http(s) URL or that carries credentials, before any call, without echoing it", async () => {
    const { fetch: stub, calls } = recordings([{}]);
    const run = (host: string) => failure(runUnifi({ action: "sites" }, { env: { UNIFI_HOST: host, UNIFI_API_KEY: "k" }, fetch: stub }));
    expect(await run("ftp://console")).toContain("must be an http or https URL, not ftp:");
    expect(await run("file:///etc/passwd")).toContain("must be an http or https URL, not file:");
    const withCredentials = await run("https://admin:hunter2@192.168.5.1");
    expect(withCredentials).toContain("must not carry credentials");
    expect(withCredentials).not.toContain("hunter2");
    expect(await run("admin:hunter2@192.168.5.1")).toContain("must not carry credentials");
    expect(await run("https://[bad")).toContain("not a valid URL");
    expect(calls).toHaveLength(0);
  });

  it("sends through the real fetch when none is injected: the console sees the path and the API key", async () => {
    const seen: { path: string; key: string | null }[] = [];
    const console_ = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push({ path: new URL(request.url).pathname, key: request.headers.get("x-api-key") });
        return Response.json({ data: [SITE] });
      },
    });
    try {
      const output = await runUnifi(
        { action: "sites" },
        { env: { UNIFI_HOST: `http://127.0.0.1:${console_.port}/`, UNIFI_API_KEY: "k3y" } },
      );
      expect(output).toEqual({ action: "sites", sites: [SITE] });
      expect(seen).toEqual([{ path: unifiPaths.sites(), key: "k3y" }]);
    } finally {
      await console_.stop(true);
    }
  });
});

describe("the input", () => {
  it("requires device and port to power-cycle", () => {
    expect(inputIssues({ action: "power_cycle_port", device: GARAGE.name })).toEqual(["power_cycle_port requires `port`"]);
    expect(inputIssues({ action: "power_cycle_port", port: 5 })).toEqual(["power_cycle_port requires `device`"]);
    expect(inputIssues({ action: "power_cycle_port", device: null, port: null })).toHaveLength(2);
    expect(inputIssues({ action: "power_cycle_port", device: GARAGE.name, port: 5 })).toEqual([]);
  });

  it("bounds port, window and threshold", () => {
    expect(inputIssues({ action: "ports", port: 0 })).toHaveLength(1);
    expect(inputIssues({ action: "ports", port: 65 })).toHaveLength(1);
    expect(inputIssues({ action: "traffic", window_seconds: 4 })).toHaveLength(1);
    expect(inputIssues({ action: "traffic", window_seconds: 121 })).toHaveLength(1);
    expect(inputIssues({ action: "traffic", threshold_kbit: 0 })).toHaveLength(1);
    expect(inputIssues({ action: "traffic", window_seconds: 5, threshold_kbit: 0.5, port: 64 })).toEqual([]);
  });

  it("refuses before any call is made", async () => {
    const { fetch: stub, calls } = recordings([{}]);
    expect(await failure(runUnifi({ action: "power_cycle_port" }, { env: environment, fetch: stub }))).toContain("invalid input for unifi");
    expect(calls).toHaveLength(0);
  });
});

function stubPi(): Parameters<typeof buildTool>[0] {
  const chain: unknown = new Proxy(function () {}, { get: () => chain, apply: () => chain });
  return { zod: new Proxy({}, { get: () => chain }) } as unknown as Parameters<typeof buildTool>[0];
}

describe("the tool", () => {
  it("runs through execute, returning JSON text and the typed details", async () => {
    const { fetch: stub } = recordings([{ data: [SITE] }]);
    const tool = buildTool(stubPi(), { env: environment, fetch: stub });
    expect(tool.name).toBe("unifi");
    const result = await tool.execute("id", { action: "sites" }, undefined, undefined, undefined);
    expect(result.details).toEqual({ action: "sites", sites: [SITE] });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("streams a progress update from a traffic window", async () => {
    const { fetch: stub } = recordings([statReply([switchTable(GARAGE, [{ port: 5, rx: 1 }])])]);
    const updates: string[] = [];
    let clock = 0;
    const tool = buildTool(stubPi(), { env: noSite, fetch: stub, now: () => clock, sleep: async (ms) => void (clock += ms) });
    await tool.execute("id", { action: "traffic", window_seconds: 5 }, (partial) => updates.push(partial.content[0]!.text), undefined, undefined);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("5 s");
  });

  it("fails by throwing, not by returning an error as a success", async () => {
    const tool = buildTool(stubPi(), { env: {} });
    await expect(tool.execute("id", { action: "sites" }, undefined, undefined, undefined)).rejects.toThrow("UNIFI_HOST");
  });

  it("describes itself in 80 to 250 words", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
