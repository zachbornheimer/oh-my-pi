/**
 * The sentry tool against a fake Sentry: call shapes, narrowing of replies, failure paths. Ported from the Mastra
 * capability's tests. Nothing here reaches Sentry: the fetch and the environment are handed in.
 */
import { describe, expect, it } from "bun:test";
import {
  type Fetch,
  type SentryEnv,
  inputIssues,
  runSentry,
  sentryOrg,
  sentryPaths,
} from "./sentry_core.ts";
import { DESCRIPTION, buildTool } from "./index.ts";

const ORG = "software-automation-holdings-l";
const ENV: SentryEnv = { SENTRY_AUTH_TOKEN: "tok" };

function okResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers by `answer(url, call number)` and records every call. */
function fake(answer: (url: string, n: number) => Response): { fetch: Fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, calls.length - 1);
  };
  return { fetch: fetchImpl, calls };
}

/** The JSON a recorded call sent. */
function sentJson(call: Recorded): unknown {
  const { body } = call.init ?? {};
  return JSON.parse(String(body));
}

const PROJECT = {
  id: "6758470122493650",
  slug: "isa-dashboard",
  name: "isa dashboard",
  platform: "javascript-nextjs",
  isMember: true,
  dateCreated: "2026-11-02T21:00:00.000000Z",
  // Dropped by the narrowing; toEqual below proves it never reaches the caller.
  hasAccess: true,
  features: ["custom-inbound-filters"],
};

const PROJECT_OUTPUT = {
  id: PROJECT.id,
  slug: PROJECT.slug,
  name: PROJECT.name,
  platform: PROJECT.platform,
  isMember: true,
  dateCreated: PROJECT.dateCreated,
};

const KEY = {
  id: "291523",
  label: "Default",
  dsn: { public: "https://abc@sentry.example/1", secret: "https://abc:shh@sentry.example/1", security: "old-browser" },
  isActive: true,
};

const KEY_OUTPUT = { id: KEY.id, label: KEY.label, dsn: { public: KEY.dsn.public } };

const ISSUE = {
  id: "3990182",
  shortId: "ISA-12",
  title: "AccessDeniedException from KMS",
  culprit: "usage-status.tsx",
  permalink: `https://sentry.example/organizations/${ORG}/issues/3990182/`,
  level: "error",
  status: "unresolved",
  count: "42",
  userCount: 7,
  firstSeen: "2026-11-01T18:02:41.000000Z",
  lastSeen: "2026-11-02T18:02:41.000000Z",
  project: { slug: "isa-dashboard", name: "isa dashboard", id: "2", platform: "javascript" },
  subscription: "2799985",
};

const ISSUE_OUTPUT = {
  id: ISSUE.id,
  shortId: ISSUE.shortId,
  title: ISSUE.title,
  culprit: ISSUE.culprit,
  permalink: ISSUE.permalink,
  level: ISSUE.level,
  status: ISSUE.status,
  count: ISSUE.count,
  userCount: ISSUE.userCount,
  firstSeen: ISSUE.firstSeen,
  lastSeen: ISSUE.lastSeen,
  project: { slug: "isa-dashboard", name: "isa dashboard" },
};

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("sentry", () => {
  it("fails naming the missing token and calls nothing", async () => {
    const { fetch, calls } = fake(() => okResponse([]));
    expect(await failure(runSentry({ action: "list_projects" }, { env: { SENTRY_AUTH_TOKEN: "  " }, fetch }))).toContain(
      "SENTRY_AUTH_TOKEN is not set",
    );
    expect(await failure(runSentry({ action: "list_projects" }, { env: {}, fetch }))).toContain("SENTRY_AUTH_TOKEN");
    expect(calls).toHaveLength(0);
  });

  it("lists projects against the SAH org with the bearer token, dropping unnamed fields", async () => {
    const { fetch, calls } = fake(() => okResponse([PROJECT]));
    const output = await runSentry({ action: "list_projects" }, { env: ENV, fetch });
    expect(output).toEqual({ action: "list_projects", org: ORG, projects: [PROJECT_OUTPUT], has_more: false });
    expect(calls[0]!.url).toBe(`https://sentry.io/api/0${sentryPaths.listProjects(ORG)}`);
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("says when Sentry has another page instead of passing a first page off as the whole answer", async () => {
    const link = '<https://sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", '
      + '<https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
    const more = fake(() => okResponse([PROJECT], { link }));
    expect(await runSentry({ action: "list_projects" }, { env: ENV, fetch: more.fetch })).toMatchObject({ has_more: true });
    const last = fake(() => okResponse([PROJECT], { link: link.replace('results="true"', 'results="false"') }));
    expect(await runSentry({ action: "list_projects" }, { env: ENV, fetch: last.fetch })).toMatchObject({ has_more: false });
  });

  it("targets SENTRY_ORG when set, escaping it into one path segment", async () => {
    const { fetch, calls } = fake(() => okResponse([]));
    const output = await runSentry({ action: "list_projects" }, { env: { ...ENV, SENTRY_ORG: "zysys" }, fetch });
    expect(output).toMatchObject({ action: "list_projects", org: "zysys" });
    expect(calls[0]!.url).toContain("/organizations/zysys/projects/");
    expect(sentryOrg({ SENTRY_ORG: "  " })).toBe(ORG);
    expect(sentryPaths.listKeys("o", "a/../b")).toBe("/projects/o/a%2F..%2Fb/keys/");
  });

  it("refuses an org that is a dot segment instead of climbing out of the API root", async () => {
    const { fetch, calls } = fake(() => okResponse([]));
    await expect(runSentry({ action: "list_projects" }, { env: { ...ENV, SENTRY_ORG: ".." }, fetch })).rejects.toThrow(
      "must stay under the API root",
    );
    expect(calls).toHaveLength(0);
  });

  it("creates a project, then fetches its keys so the answer carries the public DSN and no secret", async () => {
    const { fetch, calls } = fake((url) => (url.includes("/keys/") ? okResponse([KEY]) : okResponse(PROJECT)));
    const output = await runSentry(
      { action: "create_project", name: "isa dashboard", platform: "javascript-nextjs" },
      { env: ENV, fetch },
    );
    expect(output).toEqual({ action: "create_project", org: ORG, project: PROJECT_OUTPUT, keys: [KEY_OUTPUT] });
    expect(JSON.stringify(output)).not.toContain("shh");
    expect(calls[0]!.url).toBe(`https://sentry.io/api/0${sentryPaths.createProject(ORG)}`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(sentJson(calls[0]!)).toEqual({ name: "isa dashboard", platform: "javascript-nextjs" });
    expect(calls[1]!.url).toBe(`https://sentry.io/api/0${sentryPaths.listKeys(ORG, "isa-dashboard")}`);
  });

  it("omits platform from the create body when none is given", async () => {
    const { fetch, calls } = fake((url) => (url.includes("/keys/") ? okResponse([]) : okResponse(PROJECT)));
    await runSentry({ action: "create_project", name: "x", platform: null }, { env: ENV, fetch });
    expect(sentJson(calls[0]!)).toEqual({ name: "x" });
  });

  it("says the project exists when it was created but its keys could not be read", async () => {
    const { fetch } = fake((url) => (url.includes("/keys/") ? jsonResponse(500, "boom") : okResponse(PROJECT)));
    const said = await failure(runSentry({ action: "create_project", name: "isa dashboard" }, { env: ENV, fetch }));
    expect(said).toContain("`isa-dashboard` was created");
    expect(said).toContain("list_keys");
    expect(said).toContain("HTTP 500");
  });

  it("refuses a create reply without a slug instead of reading keys of nothing", async () => {
    const { fetch, calls } = fake(() => okResponse({ detail: "ok" }));
    expect(await failure(runSentry({ action: "create_project", name: "x" }, { env: ENV, fetch }))).toContain("no project slug");
    expect(calls).toHaveLength(1);
  });

  it("lists a project's keys", async () => {
    const { fetch, calls } = fake(() => okResponse([KEY]));
    const output = await runSentry({ action: "list_keys", project: "isa-dashboard" }, { env: ENV, fetch });
    expect(output).toEqual({ action: "list_keys", org: ORG, project: "isa-dashboard", keys: [KEY_OUTPUT] });
    expect(calls[0]!.url).toBe(`https://sentry.io/api/0${sentryPaths.listKeys(ORG, "isa-dashboard")}`);
  });

  it("lists issues with project, query and limit as query params, using Sentry's own `limit`", async () => {
    const { fetch, calls } = fake(() => okResponse([ISSUE]));
    const output = await runSentry(
      { action: "list_issues", project: "isa-dashboard", query: "is:unresolved", limit: 10 },
      { env: ENV, fetch },
    );
    expect(output).toEqual({ action: "list_issues", org: ORG, issues: [ISSUE_OUTPUT], has_more: false });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/api/0/organizations/${ORG}/issues/`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "10", project: "isa-dashboard", query: "is:unresolved" });
    expect(url.searchParams.has("perPage")).toBe(false);
  });

  it("defaults the limit to 20, leaves query off for Sentry's default, and forwards an empty query", async () => {
    const { fetch, calls } = fake(() => okResponse([]));
    await runSentry({ action: "list_issues", project: "p" }, { env: ENV, fetch });
    await runSentry({ action: "list_issues", project: "p", query: "" }, { env: ENV, fetch });
    const first = new URL(calls[0]!.url).searchParams;
    const second = new URL(calls[1]!.url).searchParams;
    expect(first.get("limit")).toBe("20");
    expect(first.has("query")).toBe(false);
    expect(second.has("query")).toBe(true);
    expect(second.get("query")).toBe("");
  });

  it("fails an HTTP error with the path, status and a capped body, never the token", async () => {
    const { fetch } = fake(() => jsonResponse(403, `{"detail": "${"no access ".repeat(200)}"}`));
    const said = await failure(runSentry({ action: "list_projects" }, { env: ENV, fetch }));
    expect(said).toContain("/organizations/");
    expect(said).toContain("HTTP 403");
    expect(said.length).toBeLessThan(700);
    expect(said).not.toContain("tok");
  });

  it("fails a reply of the wrong shape out loud", async () => {
    const wrong = fake(() => okResponse({ detail: "nope" }));
    expect(await failure(runSentry({ action: "list_projects" }, { env: ENV, fetch: wrong.fetch }))).toContain(
      "expected a list of objects",
    );
    const html = fake(() => okResponse("<html>"));
    expect(await failure(runSentry({ action: "list_projects" }, { env: ENV, fetch: html.fetch }))).toContain("not JSON");
  });

  it("names a network failure and a timeout, and rethrows the caller's cancellation", async () => {
    const refused: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await failure(runSentry({ action: "list_projects" }, { env: ENV, fetch: refused }))).toBe(
      "/organizations/software-automation-holdings-l/projects/: connect ECONNREFUSED",
    );

    const hanging: Fetch = (_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      return promise;
    };
    expect(await failure(runSentry({ action: "list_projects" }, { env: ENV, fetch: hanging, timeoutMs: 20 }))).toContain(
      "no reply within 0.02 s",
    );
    const controller = new AbortController();
    const pending = failure(runSentry({ action: "list_projects" }, { env: ENV, fetch: hanging, signal: controller.signal }));
    controller.abort(new Error("cancelled by caller"));
    expect(await pending).toBe("cancelled by caller");
  });
});

describe("the input", () => {
  it("rejects create_project without a name and list_keys / list_issues without a project", () => {
    expect(inputIssues({ action: "create_project" })).toEqual(["create_project requires `name`"]);
    expect(inputIssues({ action: "list_keys" })).toEqual(["list_keys requires `project`"]);
    expect(inputIssues({ action: "list_issues" })).toEqual(["list_issues requires `project`"]);
    expect(inputIssues({ action: "list_projects" })).toEqual([]);
  });

  it("treats null optional fields as absent and refuses a field the action does not read", () => {
    expect(
      inputIssues({ action: "list_projects", name: null, platform: null, project: null, query: null, limit: null }),
    ).toEqual([]);
    expect(inputIssues({ action: "list_projects", name: "x" })).toEqual(["`name` is read by `create_project`"]);
    expect(inputIssues({ action: "list_keys", project: "p", query: "is:unresolved" })).toEqual([
      "`query` is read by `list_issues`",
    ]);
  });

  it("bounds the limit at 1 to 100", () => {
    expect(inputIssues({ action: "list_issues", project: "p", limit: 100 })).toEqual([]);
    expect(inputIssues({ action: "list_issues", project: "p", limit: 101 })).toEqual(["`limit` must be an integer from 1 to 100"]);
    expect(inputIssues({ action: "list_issues", project: "p", limit: 0 })).toEqual(["`limit` must be an integer from 1 to 100"]);
  });

  it("refuses before any call is made", async () => {
    const { fetch, calls } = fake(() => okResponse([]));
    expect(await failure(runSentry({ action: "create_project" }, { env: ENV, fetch }))).toContain("invalid input for sentry");
    expect(calls).toHaveLength(0);
  });
});

function stubPi(): Parameters<typeof buildTool>[0] {
  const chain: unknown = new Proxy(function () {}, { get: () => chain, apply: () => chain });
  return { zod: new Proxy({}, { get: () => chain }) } as unknown as Parameters<typeof buildTool>[0];
}

describe("the tool", () => {
  it("runs through execute, returning JSON text and the typed details", async () => {
    const { fetch } = fake(() => okResponse([PROJECT]));
    const tool = buildTool(stubPi(), { env: ENV, fetch });
    expect(tool.name).toBe("sentry");
    const result = await tool.execute("id", { action: "list_projects" }, undefined, undefined, undefined);
    expect(result.details).toEqual({ action: "list_projects", org: ORG, projects: [PROJECT_OUTPUT], has_more: false });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("fails by throwing, not by returning an error as a success", async () => {
    const tool = buildTool(stubPi(), { env: {} });
    await expect(tool.execute("id", { action: "list_projects" }, undefined, undefined, undefined)).rejects.toThrow(
      "SENTRY_AUTH_TOKEN",
    );
  });

  it("describes itself in 80 to 250 words", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
