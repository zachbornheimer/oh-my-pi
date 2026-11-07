import { type Item, parseItem, type SourceRef } from "./schemas.js";

/**
 * Reads one source into the normalized item shape. Every kind lands on the same fields. A failed read throws: a run
 * may not research an empty body.
 */

export type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
export type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type SourceDeps = {
  exec: Exec;
  fetch: FetchLike;
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  cwd: string;
};

const HTTP_TIMEOUT_MS = 30_000;
const ATASK_TIMEOUT_MS = 60_000;
const BODY_LIMIT = 40_000;
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const OPIK_DEFAULT_BASE = "https://www.comet.com/opik/api";
const OPIK_DEFAULT_WORKSPACE = "zachbornheimer";
/** Where the capability gateway keeps the Opik key, for a machine that has not exported it. */
const KEYCHAIN_SERVICE = "capability-gateway";
const KEYCHAIN_ACCOUNT = "opik_api_key";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const timeoutSignal = (deps: SourceDeps): AbortSignal =>
  deps.signal === undefined ? AbortSignal.timeout(HTTP_TIMEOUT_MS) : AbortSignal.any([deps.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]);

/** `atask --json <argv>`: the envelope's result, or a thrown reason. */
async function ataskJson(deps: SourceDeps, argv: readonly string[]): Promise<unknown> {
  let ran: ExecResult;
  try {
    ran = await deps.exec("atask", ["--json", ...argv], { signal: deps.signal, timeout: ATASK_TIMEOUT_MS, cwd: deps.cwd });
  } catch (error) {
    deps.signal?.throwIfAborted();
    throw new Error(`atask is not runnable: ${(error as Error).message}`);
  }
  if (ran.killed) {
    deps.signal?.throwIfAborted();
    throw new Error(`atask ${argv.join(" ")} was stopped after ${ATASK_TIMEOUT_MS / 1000} s`);
  }
  if (ran.code !== 0) throw new Error(`atask ${argv.join(" ")} failed (exit ${ran.code}): ${ran.stderr.trim()}`);
  let envelope: unknown;
  try {
    envelope = JSON.parse(ran.stdout);
  } catch (error) {
    throw new Error(`atask ${argv.join(" ")} answered no JSON: ${(error as Error).message}`);
  }
  if (!isObject(envelope)) throw new Error(`atask ${argv.join(" ")} answered an unexpected shape`);
  if (envelope.ok === false) {
    const reason = isObject(envelope.error) ? text(envelope.error.message) : undefined;
    throw new Error(`atask ${argv.join(" ")}: ${reason ?? "failed"}`);
  }
  return envelope.result;
}

/** `atask show <id>`: the outcome and acceptance lines are the body the research needs. */
async function ataskItem(deps: SourceDeps, ref: string): Promise<Item> {
  const result = await ataskJson(deps, ["show", ref]);
  if (!isObject(result)) throw new Error(`atask show ${ref} answered no task`);
  const acceptance = (Array.isArray(result.acceptance) ? result.acceptance : [])
    .map((line) => `- ${isObject(line) ? (text(line.description) ?? "") : ""}`)
    .join("\n");
  const constraints = (Array.isArray(result.constraints) ? result.constraints : [])
    .map((line) => `- ${String(line)}`)
    .join("\n");
  return parseItem({
    kind: "atask",
    id: ref,
    title: text(result.title) ?? ref,
    body: [
      text(result.outcome) ?? "",
      acceptance === "" ? "" : `Acceptance:\n${acceptance}`,
      constraints === "" ? "" : `Constraints:\n${constraints}`,
    ].filter((part) => part !== "").join("\n\n"),
    status: text(result.status) ?? "unknown",
  });
}

const LINEAR_IDENTIFIER = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;
/** The Linear workspaces by identifier prefix; an unknown prefix is an error, never a default. */
const LINEAR_KEY_ENV: Readonly<Record<string, string>> = { ZYS: "LINEAR_API_KEY_ZYS", SAH: "LINEAR_API_KEY_SAH" };

/** The key a Linear identifier's workspace is read with: its own variable, else `LINEAR_API_KEY`. */
export function linearKeyFor(identifier: string, env: Readonly<Record<string, string | undefined>>): string {
  const prefix = LINEAR_IDENTIFIER.exec(identifier)?.[1]?.toUpperCase();
  if (prefix === undefined) throw new Error(`linear: not a Linear identifier (TEAM-123): ${identifier}`);
  const variable = LINEAR_KEY_ENV[prefix];
  if (variable === undefined) {
    throw new Error(`linear: unknown prefix ${prefix} on ${identifier}; known: ${Object.keys(LINEAR_KEY_ENV).join(", ")}`);
  }
  const key = env[variable]?.trim() || env.LINEAR_API_KEY?.trim();
  if (key === undefined || key === "") {
    throw new Error(`no Linear API key for ${prefix}: set ${variable} (or LINEAR_API_KEY) in the omp process environment`);
  }
  return key;
}

/** A personal API key goes as is; an OAuth token or an explicit `Bearer …` goes as a bearer. */
const linearAuthorization = (key: string): string =>
  /^bearer\s/i.test(key) ? key : key.startsWith("lin_oauth_") ? `Bearer ${key}` : key;

async function linearItem(deps: SourceDeps, ref: string): Promise<Item> {
  const key = linearKeyFor(ref, deps.env);
  const response = await deps.fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: linearAuthorization(key) },
    body: JSON.stringify({
      query: "query($id: String!) { issue(id: $id) { identifier title description updatedAt url state { name } } }",
      variables: { id: ref },
    }),
    signal: timeoutSignal(deps),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Linear get_issue ${ref} answered HTTP ${response.status}: ${body.slice(0, 400)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`Linear get_issue ${ref} answered no JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`Linear get_issue ${ref} answered an unexpected shape`);
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const messages = parsed.errors.map((entry) => (isObject(entry) ? text(entry.message) : undefined)).filter(Boolean);
    throw new Error(`Linear get_issue ${ref} failed: ${messages.join("; ") || JSON.stringify(parsed.errors).slice(0, 400)}`);
  }
  const issue = isObject(parsed.data) ? parsed.data.issue : undefined;
  if (!isObject(issue)) throw new Error(`Linear has no issue ${ref}`);
  const state = isObject(issue.state) ? text(issue.state.name) : undefined;
  return parseItem({
    kind: "linear",
    id: ref,
    title: text(issue.title) ?? ref,
    body: text(issue.description) ?? "",
    status: state ?? "unknown",
    ...(text(issue.url) === undefined ? {} : { url: text(issue.url) }),
    ...(text(issue.updatedAt) === undefined ? {} : { updated_at: text(issue.updatedAt) }),
  });
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The project and issue an Opik reference names: `<project id>/<issue id>`, a Diagnostics URL, or an `opik://` URI. */
export function parseOpikRef(ref: string): { projectId: string; issueId: string } {
  const trimmed = ref.trim();
  const scoped = new RegExp(`^(${UUID})/(${UUID})$`, "i").exec(trimmed);
  if (scoped) return { projectId: scoped[1]!, issueId: scoped[2]! };
  const uri = new RegExp(`^opik://projects/(${UUID})/agent-insights-issues/(${UUID})$`, "i").exec(trimmed);
  if (uri) return { projectId: uri[1]!, issueId: uri[2]! };
  const link = new RegExp(`/projects/(${UUID})/diagnostics[^?#]*\\?(?:[^#]*&)?issue=(${UUID})`, "i").exec(trimmed);
  if (link) return { projectId: link[1]!, issueId: link[2]! };
  throw new Error(
    `opik: "${ref}" names no project. Issues are project-scoped: pass "<project id>/<issue id>", a Diagnostics URL (…/projects/<project id>/diagnostics?issue=<issue id>) or opik://projects/<project id>/agent-insights-issues/<issue id>`,
  );
}

/** The Opik API key: `OPIK_API_KEY`, else the capability gateway's Keychain entry on macOS. */
async function opikKey(deps: SourceDeps): Promise<string> {
  const fromEnv = deps.env.OPIK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    try {
      const ran = await deps.exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], {
        signal: deps.signal,
        timeout: 10_000,
        cwd: deps.cwd,
      });
      if (ran.code === 0 && ran.stdout.trim() !== "") return ran.stdout.trim();
    } catch {
      deps.signal?.throwIfAborted();
    }
  }
  throw new Error(`no Opik API key: set OPIK_API_KEY in the omp process environment (or store it in the Keychain as service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT})`);
}

async function opikItem(deps: SourceDeps, ref: string): Promise<Item> {
  const { projectId, issueId } = parseOpikRef(ref);
  const base = (deps.env.OPIK_URL?.trim() || OPIK_DEFAULT_BASE).replace(/\/+$/, "");
  const workspace = deps.env.OPIK_WORKSPACE?.trim() || deps.env.COMET_WORKSPACE?.trim() || OPIK_DEFAULT_WORKSPACE;
  const response = await deps.fetch(
    `${base}/v1/private/agent-insights/issues/${issueId}?project_id=${encodeURIComponent(projectId)}`,
    {
      method: "GET",
      headers: { Authorization: await opikKey(deps), "Comet-Workspace": workspace, Accept: "application/json" },
      signal: timeoutSignal(deps),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`opik issue ${issueId} answered HTTP ${response.status}: ${body.slice(0, 400)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`opik issue ${issueId} answered no JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`opik issue ${issueId} answered an unexpected shape`);
  // An answer for another issue must never be researched and cached under this one's id.
  if (parsed.id !== undefined && parsed.id !== issueId) throw new Error(`opik read for issue ${issueId} answered with issue ${String(parsed.id)}`);
  const status = text(parsed.status) ?? "unknown";
  const ui = base.endsWith("/api") ? base.slice(0, -"/api".length) : base;
  const area = status === "open" ? "diagnostics" : "diagnostics/resolved";
  return parseItem({
    kind: "opik",
    id: ref,
    title: text(parsed.name) ?? ref,
    body: [
      text(parsed.description) ?? "",
      text(parsed.cause) === undefined ? "" : `Cause: ${text(parsed.cause)}`,
      text(parsed.suggested_fix) === undefined ? "" : `Suggested fix: ${text(parsed.suggested_fix)}`,
    ].filter((part) => part !== "").join("\n\n"),
    status,
    url: `${ui}/${workspace}/projects/${projectId}/${area}?issue=${issueId}`,
  });
}

/** Strips a page to its readable text. HTML loses its scripts, styles and tags; anything else is kept. */
export function readableText(raw: string, contentType: string): string {
  if (!contentType.includes("html")) return raw;
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The parsed `text` when it is an http or https URL that carries no credentials, else a throw saying which rule it
 * broke. This is the one gate on what a source read may fetch: a page the caller names, and the Linear and Opik
 * endpoints an API key travels to. A refusal never repeats `text`, which may hold a password.
 */
export function checkedHttpUrl(text: string): URL {
  let target: URL;
  try {
    target = new URL(text);
  } catch {
    throw new Error("the address is not a URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`only http and https URLs are fetched, not ${target.protocol}`);
  }
  if (target.username !== "" || target.password !== "") {
    throw new Error("a URL carrying credentials is not fetched");
  }
  return target;
}

async function urlItem(deps: SourceDeps, ref: string): Promise<Item> {
  let target: URL;
  try {
    target = checkedHttpUrl(ref);
  } catch (error) {
    throw new Error(`url: ${(error as Error).message}`);
  }
  const response = await deps.fetch(target.href, { signal: timeoutSignal(deps) });
  if (!response.ok) throw new Error(`fetch ${ref} answered ${response.status}`);
  const body = readableText(await response.text(), response.headers.get("content-type") ?? "");
  return parseItem({ kind: "url", id: ref, title: ref, body: body.slice(0, BODY_LIMIT), status: "reference", url: ref });
}

/** The item a reference names. */
export async function readSource(deps: SourceDeps, source: SourceRef): Promise<Item> {
  switch (source.kind) {
    case "atask":
      return ataskItem(deps, source.ref);
    case "linear":
      return linearItem(deps, source.ref);
    case "opik":
      return opikItem(deps, source.ref);
    case "url":
      return urlItem(deps, source.ref);
  }
}
