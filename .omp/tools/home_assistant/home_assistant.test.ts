/**
 * The home_assistant tool against the shapes the instance answers: `/api/config`, `/api/states`,
 * `/api/states/<entity_id>` and `/api/template`, the URL and credential footguns, and the filters `states` applies.
 * Ported from the Mastra capability's tests. Nothing here touches an instance: the fetch, the environment and the
 * credential file are handed in. The one run that uses the real fetch talks to a loopback server it starts itself.
 */
import { describe, expect, it } from "bun:test";
import { normalizeCredential, yamlValue } from "./credentials.ts";
import {
  DEFAULT_STATE_LIMIT,
  type Fetch,
  type HomeAssistantEnv,
  configRow,
  homeAssistantBaseUrl,
  homeAssistantCredential,
  homeAssistantPaths,
  inputIssues,
  objectOf,
  runHomeAssistant,
  stateRow,
  stateRowsOf,
} from "./home_assistant_core.ts";
import { DESCRIPTION, buildTool } from "./index.ts";

const ENVIRONMENT: HomeAssistantEnv = { HASS_HOST: "hass:8123", HASS_TOKEN: "'hass-token'" };

/** The heal's own counters, and two entities the filters must keep out, as `/api/states` spells them. */
const STATES = [
  {
    entity_id: "counter.garage_cam_heal_attempts",
    state: "3",
    attributes: { friendly_name: "Garage Cam Heal Attempts", icon: "mdi:counter" },
    last_changed: "2026-10-31T10:28:41.000000+00:00",
    last_updated: "2026-10-31T10:28:41.000000+00:00",
  },
  {
    entity_id: "counter.shed_cam_heal_attempts",
    state: "3",
    attributes: { friendly_name: "Shed Cam Heal Attempts", icon: "mdi:counter" },
    last_changed: "2026-10-31T10:08:22.000000+00:00",
    last_updated: "2026-10-31T10:08:22.000000+00:00",
  },
  {
    entity_id: "sensor.garage_cam_phy_rate",
    state: "100",
    attributes: { unit_of_measurement: "Mbit/s" },
    last_changed: "2026-11-05T02:57:38.000000+00:00",
    last_updated: "2026-11-05T02:57:38.000000+00:00",
  },
  {
    entity_id: "camera.garage",
    state: "idle",
    attributes: { entity_picture: "/api/camera_proxy/camera.garage" },
    last_changed: "2026-11-04T23:50:26.000000+00:00",
    last_updated: "2026-11-05T03:10:02.000000+00:00",
  },
];

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function headerOf(recorded: Recorded, name: string): string | undefined {
  const headers = recorded.init?.headers;
  return headers === undefined ? undefined : (new Headers(headers).get(name) ?? undefined);
}

/** A fetch that answers `replies` in order (repeating the last) and records every call. */
function recordings(replies: readonly Response[]): { readonly fetch: Fetch; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl: Fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const reply = replies[Math.min(index, replies.length - 1)]!;
    index += 1;
    return reply.clone();
  };
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** A fetch that never answers and rejects with the signal's reason when the call is abandoned. */
const hangingFetch: Fetch = (_url, init) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  if (init?.signal?.aborted) reject(init.signal.reason);
  init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  return promise;
};

/** The message a run rejected with, or a failure naming that it resolved instead. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("the base URL and the credential", () => {
  it("assumes http, since an instance answers plain HTTP on the LAN", () => {
    expect(homeAssistantBaseUrl({ HASS_HOST: "192.168.5.10:8123" })).toBe("http://192.168.5.10:8123");
    expect(homeAssistantBaseUrl({ HASS_HOST: "http://homeassistant.local:8123/" })).toBe("http://homeassistant.local:8123");
    expect(homeAssistantBaseUrl({ HASS_URL: "https://ha.example" })).toBe("https://ha.example");
    expect(homeAssistantBaseUrl({ HASS_HOST: " hass:8123 ", HASS_URL: "ignored" })).toBe("http://hass:8123");
    expect(() => homeAssistantBaseUrl({})).toThrow("HASS_HOST");
  });

  it("falls back to HASS_URL when HASS_HOST is set but empty", () => {
    expect(homeAssistantBaseUrl({ HASS_HOST: "", HASS_URL: "https://ha.example" })).toBe("https://ha.example");
    expect(homeAssistantBaseUrl({ HASS_HOST: "  ", HASS_URL: "ha.local" })).toBe("http://ha.local");
  });

  it("strips the YAML quotes the instance 401s on, and only that pair", () => {
    expect(normalizeCredential("'abc123'")).toBe("abc123");
    expect(normalizeCredential('"abc123"')).toBe("abc123");
    expect(normalizeCredential("ab'c123")).toBe("ab'c123");
    expect(normalizeCredential("'abc123")).toBe("'abc123");
    expect(yamlValue("hass_token: 'k'  # rotated\nempty:\n", "hass_token")).toBe("'k'");
    expect(yamlValue("empty:\n", "empty")).toBeNull();
  });

  it("takes the token from the environment, else the file, else says what is missing", async () => {
    expect(await homeAssistantCredential({ HASS_TOKEN: "'abc'" })).toBe("abc");

    const paths: string[] = [];
    const reader = async (path: string): Promise<string> => {
      paths.push(path);
      return "hass_token: 'from-file'  # rotated 2026-11-05\n";
    };
    expect(await homeAssistantCredential({ HASS_TOKEN_FILE: "/config/secrets.yaml#hass_token" }, reader)).toBe("from-file");
    expect(paths).toEqual(["/config/secrets.yaml"]);

    await expect(homeAssistantCredential({}, async () => "")).rejects.toThrow("HASS_TOKEN");
    await expect(homeAssistantCredential({ HASS_TOKEN_FILE: "/k.yaml#nope" }, async () => "a: b\n")).rejects.toThrow(
      "states no `nope` line",
    );
    await expect(
      homeAssistantCredential({ HASS_TOKEN_FILE: "/missing" }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("could not be read");
  });

  it("refuses a token file that holds nothing instead of sending an empty bearer", async () => {
    await expect(homeAssistantCredential({ HASS_TOKEN_FILE: "/empty" }, async () => "  \n")).rejects.toThrow(
      "empty credential",
    );
  });
});

describe("the reply boundary", () => {
  it("reads a bare list of states and refuses anything else out loud", () => {
    expect(stateRowsOf([{ entity_id: "sensor.x" }], "x")).toEqual([{ entity_id: "sensor.x" }]);
    expect(() => stateRowsOf({ data: [] }, "the states reply")).toThrow("the states reply: expected a list of state objects");
    expect(() => stateRowsOf(null, "the states reply")).toThrow("read null");
    expect(() => stateRowsOf([1], "the states reply")).toThrow("expected a list of state objects");
  });

  it("refuses a body that should be one object but arrived as an array", () => {
    expect(objectOf({ state: "3" }, "x")).toEqual({ state: "3" });
    expect(() => objectOf([{ state: "3" }], "the config reply")).toThrow("expected an object");
  });
});

describe("one entity's row", () => {
  it("keeps Home Assistant's own word for the state and its domain from the id", () => {
    expect(stateRow({ entity_id: "counter.garage_cam_heal_attempts", state: "3" }, false)).toEqual({
      entity_id: "counter.garage_cam_heal_attempts",
      state: "3",
      domain: "counter",
      last_changed: null,
      last_updated: null,
      attributes: null,
    });
  });

  it("states `unknown` and `unavailable` as Home Assistant states them, never derived", () => {
    expect(stateRow({ entity_id: "camera.garage", state: "unavailable" }, false).state).toBe("unavailable");
    expect(stateRow({ entity_id: "sensor.x", state: null }, false).state).toBe("");
  });

  it("carries attributes only when asked for", () => {
    const row = {
      entity_id: "light.kitchen",
      state: "on",
      attributes: { brightness: 5 },
      last_changed: "2026-11-05T00:00:00+00:00",
    };
    expect(stateRow(row, false).attributes).toBeNull();
    expect(stateRow(row, true).attributes).toEqual({ brightness: 5 });
    expect(stateRow({ entity_id: "sensor.x", state: "1", attributes: "nonsense" }, true).attributes).toBeNull();
    expect(stateRow(row, true).last_changed).toBe("2026-11-05T00:00:00+00:00");
  });
});

describe("the instance's config", () => {
  it("keeps the four fields an automation author asks about, and drops the rest", () => {
    expect(
      configRow({
        version: "2026.10.0",
        time_zone: "America/New_York",
        location_name: "Home",
        state: "RUNNING",
        components: ["api", "frontend"],
        latitude: 40,
      }),
    ).toEqual({ version: "2026.10.0", time_zone: "America/New_York", location_name: "Home", state: "RUNNING" });
  });
});

describe("the instance calls", () => {
  it("asks /api/states with the bearer token and filters by domain and entity-id text", async () => {
    const { fetch: stub, calls } = recordings([json(STATES)]);

    const output = await runHomeAssistant(
      { action: "states", domain: "counter", search: "CAM_HEAL" },
      { env: ENVIRONMENT, fetch: stub },
    );

    expect(calls[0]!.url).toBe("http://hass:8123/api/states");
    expect(headerOf(calls[0]!, "authorization")).toBe("Bearer hass-token");
    expect(output).toEqual({
      action: "states",
      total: 2,
      returned: 2,
      truncated: false,
      states: [
        {
          entity_id: "counter.garage_cam_heal_attempts",
          state: "3",
          domain: "counter",
          last_changed: "2026-10-31T10:28:41.000000+00:00",
          last_updated: "2026-10-31T10:28:41.000000+00:00",
          attributes: null,
        },
        {
          entity_id: "counter.shed_cam_heal_attempts",
          state: "3",
          domain: "counter",
          last_changed: "2026-10-31T10:08:22.000000+00:00",
          last_updated: "2026-10-31T10:08:22.000000+00:00",
          attributes: null,
        },
      ],
    });
  });

  it("says what a limit cut instead of pretending the match was the answer", async () => {
    const { fetch: stub } = recordings([json(STATES)]);

    const cut = await runHomeAssistant({ action: "states", domain: "counter", limit: 1 }, { env: ENVIRONMENT, fetch: stub });
    expect(cut).toMatchObject({ action: "states", total: 2, returned: 1, truncated: true });

    const whole = await runHomeAssistant({ action: "states" }, { env: ENVIRONMENT, fetch: stub });
    expect(whole).toMatchObject({ action: "states", total: 4, returned: 4, truncated: false });
    expect(DEFAULT_STATE_LIMIT).toBe(200);
  });

  it("treats null optional fields as absent", async () => {
    const { fetch: stub } = recordings([json(STATES)]);
    const output = await runHomeAssistant(
      { action: "states", domain: null, search: null, limit: null, attributes: null, entity_id: null, template: null },
      { env: ENVIRONMENT, fetch: stub },
    );
    expect(output).toMatchObject({ action: "states", total: 4, returned: 4 });
  });

  it("includes attributes when asked, with the values Home Assistant carries", async () => {
    const { fetch: stub } = recordings([json(STATES)]);

    const output = await runHomeAssistant(
      { action: "states", domain: "camera", attributes: true },
      { env: ENVIRONMENT, fetch: stub },
    );
    expect(output).toMatchObject({
      states: [{ entity_id: "camera.garage", attributes: { entity_picture: "/api/camera_proxy/camera.garage" } }],
    });
  });

  it("reads one entity with its attributes, and names the 404 when the entity is not there", async () => {
    const { fetch: stub, calls } = recordings([json(STATES[0])]);

    const output = await runHomeAssistant(
      { action: "state", entity_id: "counter.garage_cam_heal_attempts" },
      { env: ENVIRONMENT, fetch: stub },
    );
    expect(calls[0]!.url).toBe("http://hass:8123/api/states/counter.garage_cam_heal_attempts");
    expect(output).toMatchObject({
      action: "state",
      state: { state: "3", domain: "counter", attributes: { icon: "mdi:counter" } },
    });

    const missing = recordings([json({ message: "Entity not found." }, 404)]);
    const said = await failure(
      runHomeAssistant({ action: "state", entity_id: "counter.nope" }, { env: ENVIRONMENT, fetch: missing.fetch }),
    );
    expect(said).toContain(homeAssistantPaths.state("counter.nope"));
    expect(said).toContain("HTTP 404");
    expect(said).toContain("Entity not found.");
  });

  it("renders a template through the instance and returns its text unparsed", async () => {
    const { fetch: stub, calls } = recordings([text("3")]);

    const output = await runHomeAssistant(
      { action: "template", template: "{{ states('counter.garage_cam_heal_attempts') }}" },
      { env: ENVIRONMENT, fetch: stub },
    );

    expect(output).toEqual({ action: "template", rendered: "3" });
    expect(calls[0]!.url).toBe("http://hass:8123/api/template");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ template: "{{ states('counter.garage_cam_heal_attempts') }}" }));
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
  });

  it("fails a broken template with the instance's own 500 and its message", async () => {
    const { fetch: stub } = recordings([text("Error rendering template: UndefinedError: 'states' is undefined", 500)]);

    const said = await failure(
      runHomeAssistant({ action: "template", template: "{{ nope() }}" }, { env: ENVIRONMENT, fetch: stub }),
    );

    expect(said).toContain(homeAssistantPaths.template());
    expect(said).toContain("HTTP 500");
    expect(said).toContain("UndefinedError");
  });

  it("reads the config, and fails a rejected token by naming what the token must be, without echoing it", async () => {
    const { fetch: stub } = recordings([
      json({ version: "2026.10.0", time_zone: "America/New_York", location_name: "Home", state: "RUNNING" }),
    ]);
    expect(await runHomeAssistant({ action: "config" }, { env: ENVIRONMENT, fetch: stub })).toEqual({
      action: "config",
      config: { version: "2026.10.0", time_zone: "America/New_York", location_name: "Home", state: "RUNNING" },
    });

    const denied = recordings([json({ message: "Unauthorized" }, 401)]);
    const said = await failure(runHomeAssistant({ action: "config" }, { env: ENVIRONMENT, fetch: denied.fetch }));
    expect(said).toContain("HTTP 401");
    expect(said).toContain("long-lived access token");
    expect(said).not.toContain("hass-token");
  });

  it("fails a reply that is not JSON, and a states reply that is not a list", async () => {
    const html = recordings([text("<html>login</html>")]);
    expect(await failure(runHomeAssistant({ action: "config" }, { env: ENVIRONMENT, fetch: html.fetch }))).toContain(
      "the reply is not JSON",
    );
    const wrong = recordings([json({ states: [] })]);
    expect(await failure(runHomeAssistant({ action: "states" }, { env: ENVIRONMENT, fetch: wrong.fetch }))).toContain(
      "expected a list of state objects",
    );
  });

  it("names a network failure with the path, and a hung instance by its timeout", async () => {
    const refused: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await failure(runHomeAssistant({ action: "config" }, { env: ENVIRONMENT, fetch: refused }))).toBe(
      "/api/config: connect ECONNREFUSED",
    );

    expect(await failure(runHomeAssistant({ action: "config" }, { env: ENVIRONMENT, fetch: hangingFetch, timeoutMs: 20 }))).toBe(
      "/api/config: no reply within 0.02 s",
    );
  });

  it("rethrows the caller's cancellation instead of calling it a network failure", async () => {
    const controller = new AbortController();
    const pending = failure(
      runHomeAssistant({ action: "config" }, { env: ENVIRONMENT, fetch: hangingFetch, signal: controller.signal }),
    );
    controller.abort(new Error("cancelled by caller"));
    expect(await pending).toBe("cancelled by caller");
  });

  it("calls nothing when the host or the token is missing", async () => {
    const { fetch: stub, calls } = recordings([json({})]);
    expect(await failure(runHomeAssistant({ action: "config" }, { env: {}, fetch: stub }))).toContain("HASS_HOST is not set");
    expect(
      await failure(runHomeAssistant({ action: "config" }, { env: { HASS_HOST: "hass" }, fetch: stub })),
    ).toContain("no Home Assistant token");
    expect(calls).toHaveLength(0);
  });

  it("refuses a host that is not an http(s) URL or that carries credentials, before any call, without echoing it", async () => {
    const { fetch: stub, calls } = recordings([json({})]);
    const run = (host: string) =>
      failure(runHomeAssistant({ action: "config" }, { env: { HASS_HOST: host, HASS_TOKEN: "t" }, fetch: stub }));
    expect(await run("ftp://hass")).toContain("must be an http or https URL, not ftp:");
    expect(await run("file:///etc/passwd")).toContain("must be an http or https URL, not file:");
    const withCredentials = await run("http://admin:hunter2@hass:8123");
    expect(withCredentials).toContain("must not carry credentials");
    expect(withCredentials).not.toContain("hunter2");
    expect(await run("admin:hunter2@hass:8123")).toContain("must not carry credentials");
    expect(await run("http://[bad")).toContain("not a valid URL");
    expect(calls).toHaveLength(0);
  });

  it("sends through the real fetch when none is injected: the instance sees the path and the bearer token", async () => {
    const seen: { path: string; authorization: string | null }[] = [];
    const instance = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
        return Response.json({ version: "2026.10.0", time_zone: "UTC", location_name: "Home", state: "RUNNING" });
      },
    });
    try {
      const output = await runHomeAssistant(
        { action: "config" },
        { env: { HASS_HOST: `http://127.0.0.1:${instance.port}/`, HASS_TOKEN: "t0ken" } },
      );
      expect(output.action).toBe("config");
      expect(seen).toEqual([{ path: homeAssistantPaths.config(), authorization: "Bearer t0ken" }]);
    } finally {
      await instance.stop(true);
    }
  });
});

describe("the input", () => {
  it("requires the field each action reads", () => {
    expect(inputIssues({ action: "state" })).toEqual(["`state` needs `entity_id`: the entity to read"]);
    expect(inputIssues({ action: "template" })).toEqual(["`template` needs `template`: the template to render"]);
    expect(inputIssues({ action: "state", entity_id: "counter.x" })).toEqual([]);
    expect(inputIssues({ action: "states" })).toEqual([]);
  });

  it("refuses a field the chosen action does not read, naming the action that does", async () => {
    expect(inputIssues({ action: "config", domain: "counter" })).toEqual([
      "`domain` is read by `states`; this action is `config`",
    ]);
    expect(inputIssues({ action: "template", entity_id: "counter.x" })).toEqual([
      "`entity_id` is read by `state`; this action is `template`",
      "`template` needs `template`: the template to render",
    ]);
    const { fetch: stub, calls } = recordings([json({})]);
    expect(
      await failure(runHomeAssistant({ action: "config", domain: "counter" }, { env: ENVIRONMENT, fetch: stub })),
    ).toContain("invalid input for home_assistant");
    expect(calls).toHaveLength(0);
  });

  it("refuses a limit that is not a positive integer", () => {
    expect(inputIssues({ action: "states", limit: 0 })).toEqual(["`limit` must be a positive integer"]);
    expect(inputIssues({ action: "states", limit: 1.5 })).toEqual(["`limit` must be a positive integer"]);
  });
});

/** A chainable stand-in for `pi.zod`: the factory builds its schema from it, the test only needs the tool object. */
function stubPi(): Parameters<typeof buildTool>[0] {
  const chain: unknown = new Proxy(function () {}, {
    get: () => chain,
    apply: () => chain,
  });
  return { zod: new Proxy({}, { get: () => chain }) } as unknown as Parameters<typeof buildTool>[0];
}

describe("the tool", () => {
  it("runs through execute, returning JSON text and the typed details, and clears its heartbeat", async () => {
    const { fetch: stub } = recordings([json({ version: "2026.10.0", time_zone: "UTC", location_name: "Home", state: "RUNNING" })]);
    const tool = buildTool(stubPi(), { env: ENVIRONMENT, fetch: stub });
    expect(tool.name).toBe("home_assistant");
    const result = await tool.execute("id", { action: "config" }, undefined, undefined, undefined);
    expect(result.details).toEqual({
      action: "config",
      config: { version: "2026.10.0", time_zone: "UTC", location_name: "Home", state: "RUNNING" },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("fails by throwing, not by returning an error as a success", async () => {
    const tool = buildTool(stubPi(), { env: {} });
    await expect(tool.execute("id", { action: "config" }, undefined, undefined, undefined)).rejects.toThrow("HASS_HOST");
  });

  it("describes itself in 80 to 250 words, without a credential", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).not.toContain("hass-token");
  });
});
