import {
  type CredentialReader,
  fieldText,
  isTruthy,
  readCredentialFile,
  resolveCredential,
} from "./credentials.ts";

/**
 * Home Assistant's HTTP surface: one base URL, one long-lived access token, and the four calls this tool makes,
 * all documented under `developers.home-assistant.io/docs/api/rest`:
 *
 *   GET  /api/config          the core configuration: version, time zone, location, core state
 *   GET  /api/states          every state the token's owner may read
 *   GET  /api/states/{id}     one entity, or 404
 *   POST /api/template        renders a Jinja template and answers plain text (needs an administrator)
 *
 * Every call is a read; `POST /api/template` renders, it does not act. Every failure throws: the tool wrapper turns
 * a throw into a failed tool result.
 */

/** How many rows `states` answers when the caller does not say. */
export const DEFAULT_STATE_LIMIT = 200;
/** How long one HTTP call may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 30_000;

export type HomeAssistantEnv = Readonly<Record<string, string | undefined>>;
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HomeAssistantInput {
  readonly action: "config" | "states" | "state" | "template";
  readonly entity_id?: string | null | undefined;
  readonly domain?: string | null | undefined;
  readonly search?: string | null | undefined;
  readonly limit?: number | null | undefined;
  readonly attributes?: boolean | null | undefined;
  readonly template?: string | null | undefined;
}

export interface HomeAssistantConfig {
  version: string | null;
  time_zone: string | null;
  location_name: string | null;
  state: string | null;
}

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  domain: string;
  last_changed: string | null;
  last_updated: string | null;
  attributes: Record<string, unknown> | null;
}

export type HomeAssistantOutput =
  | { action: "config"; config: HomeAssistantConfig }
  | { action: "states"; total: number; returned: number; truncated: boolean; states: HomeAssistantState[] }
  | { action: "state"; state: HomeAssistantState }
  | { action: "template"; rendered: string };

/** What a run reaches outside itself. Every one is a seam a test replaces; production passes nothing. */
export interface HomeAssistantDeps {
  readonly env?: HomeAssistantEnv | undefined;
  readonly fetch?: Fetch | undefined;
  readonly readFile?: CredentialReader | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

interface Call {
  readonly method?: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** `json` (the default) parses the reply; `text` keeps it raw, which is what `/api/template` answers. */
  readonly readAs?: "json" | "text";
}

interface Reply {
  readonly text: string;
  readonly body: unknown;
}

/** The paths, as functions, so a test can assert the call shape without repeating a string. */
export const homeAssistantPaths = {
  config: () => "/api/config",
  states: () => "/api/states",
  state: (entityId: string) => `/api/states/${encodeURIComponent(entityId)}`,
  template: () => "/api/template",
};

/** The fields each action reads. A field another action reads is refused rather than silently ignored. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  config: [],
  states: ["domain", "search", "limit", "attributes"],
  state: ["entity_id"],
  template: ["template"],
};
const READ_BY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALLOWED).flatMap(([action, fields]) => fields.map((name) => [name, action])),
);
const OPTIONAL_FIELDS = ["entity_id", "domain", "search", "limit", "attributes", "template"] as const;

/** The reasons an input is refused, or an empty list. `null` reads as absent: models send it for an optional field. */
export function inputIssues(input: HomeAssistantInput): string[] {
  const issues: string[] = [];
  const allowed = ALLOWED[input.action];
  if (allowed === undefined) return [`\`action\` must be one of ${Object.keys(ALLOWED).join(", ")}`];
  const record = input as unknown as Record<string, unknown>;
  for (const name of OPTIONAL_FIELDS) {
    const value = record[name];
    if (value === undefined || value === null) continue;
    if (!allowed.includes(name)) {
      issues.push(`\`${name}\` is read by \`${READ_BY[name]}\`; this action is \`${input.action}\``);
    }
  }
  if (input.action === "state" && (input.entity_id ?? null) === null) {
    issues.push("`state` needs `entity_id`: the entity to read");
  }
  if (input.action === "template" && (input.template ?? null) === null) {
    issues.push("`template` needs `template`: the template to render");
  }
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1)) {
    issues.push("`limit` must be a positive integer");
  }
  return issues;
}

/**
 * `text` when it is an http or https URL that carries no credentials, else a throw. Home Assistant is reached over
 * HTTP, and the token travels in a header, so another scheme is no endpoint of this tool and `user:password@` in the
 * URL is a misconfiguration. A refusal never repeats `text`: it may hold the password.
 */
function checkedHttpUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("HASS_HOST is not a valid URL: give Home Assistant's base URL, for example http://homeassistant.local:8123");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HASS_HOST must be an http or https URL, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("HASS_HOST must not carry credentials: the token is sent as a header, not in the URL");
  }
  return text;
}

/**
 * Home Assistant's base URL: `HASS_HOST`, else `HASS_URL`, with `http://` assumed when it carries no scheme and any
 * trailing slashes dropped. The assumed scheme is http: an instance answers plain HTTP on the LAN by default. Only
 * an http or https URL without credentials is a base URL; anything else is refused here, before any call.
 */
export function homeAssistantBaseUrl(env: HomeAssistantEnv): string {
  // An empty HASS_HOST must not shadow HASS_URL, so both are trimmed before choosing.
  const raw = env.HASS_HOST?.trim() || env.HASS_URL?.trim();
  if (!raw) {
    throw new Error("HASS_HOST is not set: give Home Assistant's base URL, for example http://homeassistant.local:8123");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return checkedHttpUrl(withScheme.replace(/\/+$/, ""));
}

/** The token a call uses: `HASS_TOKEN`, else the file `HASS_TOKEN_FILE` names (which may carry `#name`). */
export async function homeAssistantCredential(
  env: HomeAssistantEnv,
  readFileImpl: CredentialReader = readCredentialFile,
): Promise<string> {
  return resolveCredential({
    inline: env.HASS_TOKEN,
    file: env.HASS_TOKEN_FILE,
    fileVariable: "HASS_TOKEN_FILE",
    missing:
      "no Home Assistant token: set HASS_TOKEN to a long-lived access token, or HASS_TOKEN_FILE to a file holding "
      + "one (add `#name` to read one line of a YAML secrets file). Create the token on the account's profile "
      + "under Security; rendering a template needs an administrator's token.",
  }, readFileImpl);
}

/** A reply's first 200 characters on one line, for a message that has to fit in a tool result. */
function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function httpFailure(path: string, status: number, text: string): string {
  const detail = summarize(text);
  const hint = status === 401
    ? " — this tool sends `Authorization: Bearer`; the token must be a long-lived access token created on "
      + "the account's profile under Security, and HASS_HOST must be the instance"
    : status === 403
    ? " — Home Assistant refused this token's permissions; rendering a template needs an administrator's token"
    : status === 404
    ? " — Home Assistant answered 404; the entity id or the path is not one it serves"
    : "";
  return `${path}: HTTP ${status}: ${detail}${hint}`;
}

/**
 * One Home Assistant call: `Authorization: Bearer`, JSON in and JSON out, except `/api/template`, which answers
 * plain text. A non-2xx throws with the path, the status and the reply, so a caller can tell a bad token from a bad
 * template: Home Assistant answers a template error with 500 and the error text in the body.
 */
async function request(
  call: Call,
  baseUrl: string,
  credential: string,
  env: HomeAssistantEnv,
  deps: HomeAssistantDeps,
): Promise<Reply> {
  // `url` is `baseUrl` (checked by `homeAssistantBaseUrl`) plus one of `homeAssistantPaths`; the default sender
  // hands fetch a parsed `URL`, never the string.
  const send: Fetch = deps.fetch ?? ((url, init) => fetch(new URL(url), init));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
  const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    method: call.method ?? "GET",
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: "application/json",
      ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    signal,
    // An instance behind its own certificate fails verification; `HASS_INSECURE_TLS` is the operator's explicit
    // opt-in, the same decision `curl -k` makes. Unset, the certificate is verified.
    tls: { rejectUnauthorized: !isTruthy(env.HASS_INSECURE_TLS) },
  };
  let response: Response;
  let text: string;
  try {
    response = await send(`${baseUrl}${call.path}`, init);
    text = await response.text();
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    if (timeout.aborted) throw new Error(`${call.path}: no reply within ${timeoutMs / 1000} s`);
    throw new Error(`${call.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(httpFailure(call.path, response.status, text));
  if ((call.readAs ?? "json") === "text" || text.trim() === "") return { text, body: {} };
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    throw new Error(
      `${call.path}: the reply is not JSON (${summarize(text)}); check that HASS_HOST is Home Assistant itself`,
    );
  }
}

function isObject(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function describePayload(payload: unknown): string {
  return JSON.stringify(payload)?.slice(0, 200) ?? "nothing";
}

/** The rows of `/api/states`, which answers a bare array. Anything else is a wrong host, said out loud. */
export function stateRowsOf(payload: unknown, what: string): readonly Record<string, unknown>[] {
  if (Array.isArray(payload) && payload.every(isObject)) return payload;
  throw new Error(`${what}: expected a list of state objects, read ${describePayload(payload)}`);
}

/** One reply body as an object, or a failure naming what arrived instead. */
export function objectOf(payload: unknown, what: string): Record<string, unknown> {
  if (!isObject(payload)) throw new Error(`${what}: expected an object, read ${describePayload(payload)}`);
  return payload;
}

/**
 * One entity as this tool states it. `state` is Home Assistant's own word, never derived, and `attributes` comes
 * back only when the caller asked for it: an entity's attributes can be larger than the state it carries.
 */
export function stateRow(row: Record<string, unknown>, includeAttributes: boolean): HomeAssistantState {
  const entityId = fieldText(row, "entity_id", "entityId") ?? "";
  const state = row.state === undefined || row.state === null ? "" : String(row.state);
  const attributes = row.attributes;
  return {
    entity_id: entityId,
    state,
    domain: entityId.includes(".") ? entityId.slice(0, entityId.indexOf(".")) : "",
    last_changed: fieldText(row, "last_changed", "lastChanged"),
    last_updated: fieldText(row, "last_updated", "lastUpdated"),
    attributes: includeAttributes && isObject(attributes) ? attributes : null,
  };
}

/** The instance's configuration, cut to the fields an automation author asks about. */
export function configRow(row: Record<string, unknown>): HomeAssistantConfig {
  return {
    version: fieldText(row, "version"),
    time_zone: fieldText(row, "time_zone", "timeZone"),
    location_name: fieldText(row, "location_name", "locationName"),
    state: fieldText(row, "state"),
  };
}

/** Answer one question about the instance. Throws, with the reason as the message, when it cannot. */
export async function runHomeAssistant(
  input: HomeAssistantInput,
  deps: HomeAssistantDeps = {},
): Promise<HomeAssistantOutput> {
  const issues = inputIssues(input);
  if (issues.length > 0) throw new Error(`invalid input for home_assistant: ${issues.join("; ")}`);
  const env = deps.env ?? process.env;
  const baseUrl = homeAssistantBaseUrl(env);
  const credential = await homeAssistantCredential(env, deps.readFile);
  const call = (request_: Call): Promise<Reply> => request(request_, baseUrl, credential, env, deps);

  switch (input.action) {
    case "config": {
      const reply = await call({ path: homeAssistantPaths.config() });
      return { action: "config", config: configRow(objectOf(reply.body, "the config reply")) };
    }

    case "states": {
      const rows = stateRowsOf((await call({ path: homeAssistantPaths.states() })).body, "the states reply");
      const search = input.search?.toLowerCase();
      const domain = input.domain ?? undefined;
      const matched = rows.filter((row) => {
        const entityId = fieldText(row, "entity_id", "entityId") ?? "";
        if (domain !== undefined && !entityId.startsWith(`${domain}.`)) return false;
        return search === undefined || entityId.toLowerCase().includes(search);
      });
      const limit = input.limit ?? DEFAULT_STATE_LIMIT;
      const states = matched.slice(0, limit).map((row) => stateRow(row, input.attributes === true));
      return {
        action: "states",
        total: matched.length,
        returned: states.length,
        truncated: matched.length > states.length,
        states,
      };
    }

    case "state": {
      const entityId = input.entity_id!;
      const reply = await call({ path: homeAssistantPaths.state(entityId) });
      return { action: "state", state: stateRow(objectOf(reply.body, `the state reply for ${entityId}`), true) };
    }

    case "template": {
      const reply = await call({
        method: "POST",
        path: homeAssistantPaths.template(),
        body: { template: input.template },
        readAs: "text",
      });
      return { action: "template", rendered: reply.text };
    }
  }
}
