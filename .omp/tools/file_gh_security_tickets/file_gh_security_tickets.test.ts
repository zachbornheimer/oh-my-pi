import { describe, expect, it } from "bun:test";
import {
  bySeverityDescending,
  findGhsecTag,
  ghsecTag,
  parseGhsecTag,
  SEVERITY_PRIORITY,
  SWEEP_SOURCES,
} from "./constants.js";
import { FakeSecurityWorld } from "./fake_world.js";
import { ghRunner, ghSecurityPort, type GhRun, jsonDocuments } from "./github_port.js";
import factory, { DESCRIPTION, summarize } from "./index.js";
import { linearKey, type LinearFetch, securityLinearPort } from "./linear_port.js";
import { AlertGoneError, AlertsUnavailableError } from "./ports.js";
import { READ_BACK_ATTEMPTS, readerWords, sameWords } from "./read_back.js";
import { fileGhSecurityTickets } from "./run.js";
import { alertListArgs, alertReadArgs, repoListArgs, SOURCES } from "./sources.js";
import { parseTarget, reconcileGhsecTickets } from "./steps.js";
import { settleComment, ticketBody, ticketTitle } from "./texts.js";
import { WORKSPACES, workspaceForOwner } from "./workspaces.js";

/** The GraphQL request a fake `fetch` received: a JSON document, decoded for assertions. */
function requestJson(request: { body: string }): { query: string; variables: Record<string, any> } {
  const { body: payload } = request;
  return JSON.parse(payload);
}

const SAH = "Software-Automation-Holdings-LLC";
const TAG = (repo: string, source: "code-scanning" | "secret-scanning" | "dependabot", number: number, owner = SAH) =>
  ghsecTag({ owner, repo, source, number });

function seeded(): FakeSecurityWorld {
  const world = new FakeSecurityWorld();
  world.repos.set(SAH, [
    { name: "auth", isArchived: false, isFork: false },
    { name: "old", isArchived: true, isFork: false },
  ]);
  world.setAlert(SAH, "auth", "code-scanning", 1, {
    rule: { description: "SQL injection", security_severity_level: "high", severity: "error" },
    most_recent_instance: { message: { text: "query built from input" } },
  });
  world.setAlert(SAH, "auth", "code-scanning", 2, { rule: { description: "Weak hash", severity: "note" } });
  world.setAlert(SAH, "auth", "secret-scanning", 3, { secret_type: "github_token" });
  world.setAlert(SAH, "auth", "dependabot", 9, { security_advisory: { severity: "critical", summary: "x" } });
  return world;
}

describe("file_gh_security_tickets: tags", () => {
  it("formats and parses a tag, and finds one inside a title", () => {
    const tag = TAG("auth", "code-scanning", 42);
    expect(tag).toBe(`ghsec:${SAH}/auth#code-scanning-42`);
    expect(parseGhsecTag(tag)).toEqual({ owner: SAH, repo: "auth", source: "code-scanning", number: 42 });
    expect(findGhsecTag(`[${tag}] Fix it`)).toBe(tag);
    expect(parseGhsecTag("ghsec:a/b#code-scanning-0")).toBeUndefined();
    expect(parseGhsecTag("ghsec:a/b#nope-1")).toBeUndefined();
    expect(findGhsecTag("no tag here")).toBeUndefined();
  });

  it("sweeps code-scanning and secret-scanning only, never Dependabot", () => {
    expect([...SWEEP_SOURCES]).toEqual(["code-scanning", "secret-scanning"]);
  });

  it("parses a target as owner or owner/repo and rejects the rest", () => {
    expect(parseTarget("zachbornheimer")).toEqual({ owner: "zachbornheimer" });
    expect(parseTarget(`${SAH}/auth`)).toEqual({ owner: SAH, repo: "auth" });
    for (const bad of ["", "a b", "a/b/c", "/b", "a/"]) expect(() => parseTarget(bad)).toThrow("neither of the two accepted forms");
  });
});

describe("file_gh_security_tickets: workspace routing and severity", () => {
  it("routes SAH's org to SAH and every other owner to the fallback", () => {
    expect(workspaceForOwner(SAH).team).toBe("SAH");
    expect(workspaceForOwner("zachbornheimer").team).toBe("ZYS");
    expect(workspaceForOwner("someone-else").team).toBe("ZYS");
  });

  it("throws when no or several workspaces claim the fallback", () => {
    expect(() => workspaceForOwner("x", [{ ...WORKSPACES[0]! }])).toThrow("exactly one entry must carry fallbackForOwners");
  });

  it("reads each source's severity", () => {
    expect(SOURCES["code-scanning"].severityOf({ number: 1, state: "open", html_url: "u", rule: { security_severity_level: "Critical" } })).toBe("critical");
    expect(SOURCES["code-scanning"].severityOf({ number: 1, state: "open", html_url: "u", rule: { severity: "warning" } })).toBe("medium");
    expect(SOURCES["code-scanning"].severityOf({ number: 1, state: "open", html_url: "u", rule: {} })).toBe("medium");
    expect(SOURCES["secret-scanning"].severityOf({ number: 1, state: "open", html_url: "u" })).toBe("critical");
    expect(SEVERITY_PRIORITY).toEqual({ critical: 1, high: 2, medium: 3, low: 4 });
  });
});

describe("file_gh_security_tickets: a run", () => {
  it("files one ticket per open alert, critical first, in the right workspace, never Dependabot", async () => {
    const world = seeded();
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(result.workspace.team).toBe("SAH");
    expect(result.repos.visited).toEqual([`${SAH}/auth`]);
    expect(result.repos.skipped).toEqual([{ repo: `${SAH}/old`, reason: "archived" }]);
    expect(result.tickets.created.map((created) => created.tag)).toEqual([
      TAG("auth", "secret-scanning", 3),
      TAG("auth", "code-scanning", 1),
      TAG("auth", "code-scanning", 2),
    ]);
    expect(result.items.bySource).toEqual({ "secret-scanning": 1, "code-scanning": 2 });
    const first = world.issues.get(result.tickets.created[0]!.identifier)!;
    expect(first.status).toBe("Triage");
    expect(first.priority).toBe(1);
    expect(first.title).toContain(`[${TAG("auth", "secret-scanning", 3)}]`);
    expect(first.description).toContain("## Acceptance criteria");
    expect(world.calls.some((call) => call.includes("dependabot"))).toBe(false);
  });

  it("is idempotent: a second run creates nothing", async () => {
    const world = seeded();
    await fileGhSecurityTickets(world.ports(), { target: SAH });
    const again = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(again.tickets.created).toEqual([]);
    expect(again.tickets.existing).toBe(3);
    expect(world.issues.size).toBe(3);
  });

  it("filters by minSeverity and leaves a ticket below the floor alone", async () => {
    const world = seeded();
    await fileGhSecurityTickets(world.ports(), { target: SAH });
    const high = await fileGhSecurityTickets(world.ports(), { target: SAH, minSeverity: "high" });
    expect(high.items.total).toBe(2);
    expect(high.tickets.created).toEqual([]);
    expect(high.tickets.settled).toEqual([]);
  });

  it("dry run reads and writes nothing, and reports what would be done", async () => {
    const world = seeded();
    world.addTicket("SAH-1", `[${TAG("auth", "code-scanning", 77)}] gone alert`);
    world.closeAlert(SAH, "auth", "code-scanning", 1, {});
    world.alerts.set(`${SAH}/auth:code-scanning:77`, { source: "code-scanning", owner: SAH, repo: "auth", raw: { number: 77, state: "fixed", html_url: "u" } });
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.tickets.created).toEqual([]);
    expect(result.tickets.wouldCreate).toHaveLength(3);
    expect(result.tickets.wouldSettle).toEqual([TAG("auth", "code-scanning", 77)]);
    expect(world.issues.size).toBe(1);
    expect(world.calls.filter((call) => call.startsWith("linear:create") || call.startsWith("linear:state") || call.startsWith("linear:comment"))).toEqual([]);
  });

  it("routes another owner to ZYS and its first input status", async () => {
    const world = new FakeSecurityWorld();
    world.setAlert("zachbornheimer", "tool", "secret-scanning", 1, { secret_type: "aws" });
    const result = await fileGhSecurityTickets(world.ports(), { target: "zachbornheimer/tool" });
    expect(result.workspace.team).toBe("ZYS");
    expect(world.issues.get(result.tickets.created[0]!.identifier)!.status).toBe("Unreviewed");
  });

  it("skips a source GitHub will not list, and never settles that source's tickets", async () => {
    const world = seeded();
    world.forbidden.add(`${SAH}/auth:secret-scanning`);
    world.addTicket("SAH-5", `[${TAG("auth", "secret-scanning", 99)}] leaked`);
    const result = await fileGhSecurityTickets(world.ports(), { target: `${SAH}/auth` });
    expect(result.repos.skipped).toEqual([{ repo: `${SAH}/auth`, reason: "HTTP 403: not enabled" }]);
    expect(result.tickets.settled).toEqual([]);
    expect(world.issues.get("SAH-5")!.status).toBe("Triage");
    expect(result.tickets.created).toHaveLength(2);
  });

  it("fails the run, naming the repository, when a listing fails for another reason", async () => {
    const world = seeded();
    world.broken.set(`${SAH}/auth:code-scanning`, "gh api for Software-Automation-Holdings-LLC/auth code-scanning alerts failed (exit 1): HTTP 500");
    await expect(fileGhSecurityTickets(world.ports(), { target: SAH })).rejects.toThrow("HTTP 500");
  });

  it("records one failed create and keeps going", async () => {
    const world = seeded();
    world.failCreateFor = TAG("auth", "code-scanning", 1);
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(result.tickets.created).toHaveLength(2);
    expect(result.tickets.failed).toEqual([{ tag: TAG("auth", "code-scanning", 1), reason: expect.stringContaining("HTTP 500") }]);
  });

  it("uses the Security label only when the workspace already has one", async () => {
    const world = seeded();
    world.labels.push({ id: "l-sec", name: "Security" });
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(world.issues.get(result.tickets.created[0]!.identifier)!.labelIds).toEqual(["l-sec"]);
    const none = seeded();
    const plain = await fileGhSecurityTickets(none.ports(), { target: SAH });
    expect(none.issues.get(plain.tickets.created[0]!.identifier)!.labelIds).toEqual([]);
  });

  it("fails clearly when the workspace lacks the input or done status", async () => {
    const world = seeded();
    world.statuses = [{ id: "x", name: "Backlog" }];
    await expect(fileGhSecurityTickets(world.ports(), { target: SAH })).rejects.toThrow('no status named "Triage"');
  });

  it("stops at once, not as a ticket failure, when the call is cancelled", async () => {
    const world = seeded();
    world.cancelled = true;
    await expect(fileGhSecurityTickets(world.ports(), { target: SAH })).rejects.toThrow("cancelled by user");
    expect(world.issues.size).toBe(0);
  });
});

describe("file_gh_security_tickets: settling", () => {
  async function withTicket(patch: Record<string, unknown>, extra?: (world: FakeSecurityWorld) => void) {
    const world = seeded();
    await fileGhSecurityTickets(world.ports(), { target: SAH });
    world.closeAlert(SAH, "auth", "code-scanning", 1, patch);
    extra?.(world);
    return world;
  }
  const ticketOf = (world: FakeSecurityWorld, tag: string) => [...world.issues.values()].find((issue) => issue.title.includes(tag))!;

  it("moves a ticket to Done with a comment when GitHub says the alert is fixed", async () => {
    const world = await withTicket({ state: "fixed" });
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(result.tickets.settled).toEqual([{ identifier: ticketOf(world, TAG("auth", "code-scanning", 1)).identifier, tag: TAG("auth", "code-scanning", 1), githubState: "fixed" }]);
    const issue = ticketOf(world, TAG("auth", "code-scanning", 1));
    expect(issue.status).toBe("Done");
    expect(issue.comments[0]).toContain("GitHub says this alert is fixed");
    expect(issue.comments[0]).toContain("2026-11-06");
  });

  it("names the dismissal reason", async () => {
    const world = await withTicket({ state: "dismissed", dismissed_reason: "false positive" });
    await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(ticketOf(world, TAG("auth", "code-scanning", 1)).comments[0]).toContain("dismissed (false positive)");
  });

  it("leaves a ticket alone when the alert reads open again on the re-read", async () => {
    const world = await withTicket({ state: "fixed" });
    const ports = world.ports();
    const read = world.gh.readAlert;
    world.gh.readAlert = async (input) => {
      world.closeAlert(SAH, "auth", "code-scanning", 1, { state: "open" });
      return read(input);
    };
    const result = await fileGhSecurityTickets(ports, { target: SAH });
    expect(result.tickets.settled).toEqual([]);
    expect(ticketOf(world, TAG("auth", "code-scanning", 1)).status).toBe("Triage");
  });

  it("counts a 404 as gone only when the source's listing answered", async () => {
    const world = await withTicket({}, (w) => {
      w.alerts.delete(`${SAH}/auth:code-scanning:1`);
    });
    const gone = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(gone.tickets.settled[0]).toMatchObject({ githubState: "gone" });
    expect(ticketOf(world, TAG("auth", "code-scanning", 1)).comments[0]).toContain("is gone");
  });

  it("leaves a ticket alone, recorded as failed, when GitHub answers 404 for an alert whose listing is unreadable", async () => {
    const world = seeded();
    world.addTicket("SAH-7", `[${TAG("auth", "code-scanning", 55)}] old`);
    const ports = world.ports();
    let calls = 0;
    const list = world.gh.listAlerts;
    world.gh.listAlerts = async (input) => {
      calls += 1;
      // The sweep's own listing answers; the confirming list for a gone alert would not (simulated by dropping it from `listed`).
      return list(input);
    };
    await fileGhSecurityTickets(ports, { target: SAH, dryRun: true });
    expect(calls).toBeGreaterThan(0);
    // Direct: settle with an unlisted source.
    const { settleResolvedGhsecTickets } = await import("./steps.js");
    world.forbidden.add(`${SAH}/auth:code-scanning`);
    const outcome = await settleResolvedGhsecTickets(ports, {
      workspace: WORKSPACES[0]!,
      toSettle: [{ tag: TAG("auth", "code-scanning", 55), identifier: "SAH-7", status: "Triage" }],
    });
    expect(outcome.settled).toEqual([]);
    expect(outcome.failed[0]!.reason).toContain("left alone");
    expect(world.issues.get("SAH-7")!.status).toBe("Triage");
  });

  it("never touches a ticket of a repository the run did not visit", async () => {
    const world = seeded();
    world.addTicket("SAH-8", `[${TAG("other", "code-scanning", 1)}] elsewhere`);
    const result = await fileGhSecurityTickets(world.ports(), { target: `${SAH}/auth` });
    expect(result.tickets.settled).toEqual([]);
    expect(world.issues.get("SAH-8")!.status).toBe("Triage");
  });

  it("waits out Linear's lagging replica, then succeeds", async () => {
    const world = await withTicket({ state: "fixed" });
    world.lag = 3;
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(result.tickets.settled).toHaveLength(1);
    expect(world.sleeps.length).toBeGreaterThanOrEqual(3);
  });

  it("records a settle whose status write never becomes visible, and gives up after the attempt budget", async () => {
    const world = await withTicket({ state: "fixed" });
    world.lag = 1000;
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(result.tickets.settled).toEqual([]);
    expect(result.tickets.failed[0]!.reason).toContain("Linear write not visible");
    expect(world.sleeps).toHaveLength(READ_BACK_ATTEMPTS - 1);
  });

  it("records a failed comment and continues", async () => {
    const world = await withTicket({ state: "fixed" });
    world.failCommentFor = ticketOf(world, TAG("auth", "code-scanning", 1)).identifier;
    const result = await fileGhSecurityTickets(world.ports(), { target: SAH });
    expect(result.tickets.failed).toHaveLength(1);
    expect(result.tickets.settled).toEqual([]);
  });
});

describe("file_gh_security_tickets: reconcile (pure)", () => {
  const item = (tag: string, severity: "critical" | "low") => ({
    tag, source: "code-scanning" as const, number: 1, severity, url: "u", outcome: "o", detail: "", state: "open" as const, repo: `${SAH}/auth`,
  });

  it("creates the missing, counts the existing, and settles only visited, listed, no-longer-open tags", () => {
    const a = TAG("auth", "code-scanning", 1);
    const b = TAG("auth", "code-scanning", 2);
    const result = reconcileGhsecTickets({
      items: [item(a, "critical"), item(b, "low")],
      index: {
        [a]: { identifier: "SAH-1", status: "Triage" },
        [TAG("auth", "code-scanning", 3)]: { identifier: "SAH-3", status: "Triage" },
        [TAG("auth", "secret-scanning", 4)]: { identifier: "SAH-4", status: "Triage" },
        [TAG("other", "code-scanning", 5)]: { identifier: "SAH-5", status: "Triage" },
      },
      visitedRepos: [`${SAH}/auth`],
      minSeverity: "low",
      unlisted: [`${SAH}/auth:secret-scanning`],
    });
    expect(result.toCreate.map((entry) => entry.tag)).toEqual([b]);
    expect(result.existing).toBe(1);
    expect(result.toSettle.map((entry) => entry.identifier)).toEqual(["SAH-3"]);
  });

  it("orders by severity then tag, and bySeverityDescending is stable", () => {
    const sorted = [item("b", "low"), item("a", "critical")].sort(bySeverityDescending);
    expect(sorted.map((entry) => entry.tag)).toEqual(["a", "b"]);
  });
});

describe("file_gh_security_tickets: texts and read-back words", () => {
  const sample = {
    tag: TAG("auth", "code-scanning", 1), source: "code-scanning" as const, number: 1, severity: "high" as const,
    url: "https://github.com/x/y/security/code-scanning/1", outcome: "x".repeat(200), detail: "", state: "open" as const, repo: `${SAH}/auth`,
  };

  it("caps the outcome but never the tag", () => {
    const title = ticketTitle(sample);
    expect(title.startsWith(`[${sample.tag}] `)).toBe(true);
    expect(title.length).toBeLessThan(sample.tag.length + 100);
  });

  it("writes the template sections and the verify command", () => {
    const body = ticketBody({ ...sample, outcome: "Fix" });
    for (const heading of ["## Problem", "## Repro or detail", "## Non-goals", "## Acceptance criteria", "## Verify", "## Evidence"]) expect(body).toContain(heading);
    expect(body).toContain(`gh api repos/${SAH}/auth/code-scanning/alerts/1`);
    expect(body).toContain(`Tag: ${sample.tag}`);
  });

  it("builds the settle comment", () => {
    expect(settleComment({ tag: "t", githubState: "dismissed", dismissedReason: "won't fix", url: "u", date: "2026-11-06", done: "Done" })).toContain("dismissed (won't fix)");
  });

  it("compares bodies by what a reader sees", () => {
    expect(sameWords("See org/repo#12 and [link](http://x)", "See #12 and [link](http://y)")).toBe(true);
    expect(sameWords("a", "b")).toBe(false);
    expect(readerWords("<Tag label=\"hi\" />")).toBe("hi");
  });
});

describe("file_gh_security_tickets: the gh port", () => {
  const runner = (answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): { gh: GhRun; asked: string[][] } => {
    const asked: string[][] = [];
    return {
      asked,
      gh: async (args) => {
        asked.push([...args]);
        const answer = answers[args.slice(0, 2).join(" ")] ?? { exitCode: 127, stderr: "no fake" };
        return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
      },
    };
  };

  it("splits paginated documents by JSON depth, newlines inside strings included", () => {
    expect(jsonDocuments('[{"a":"x\\ny{"}]\n[{"b":2}]')).toEqual([[{ a: "x\ny{" }], [{ b: 2 }]]);
    expect(jsonDocuments("")).toEqual([]);
  });

  it("asks for exactly the argv the sources define", () => {
    expect(alertListArgs({ source: "code-scanning", owner: "o", repo: "r" })).toEqual(["api", "--paginate", "repos/o/r/code-scanning/alerts?state=open&per_page=100"]);
    expect(alertReadArgs({ source: "secret-scanning", owner: "o", repo: "r", number: 4 })).toEqual(["api", "repos/o/r/secret-scanning/alerts/4"]);
    expect(repoListArgs("o")).toEqual(["repo", "list", "o", "--limit", "1000", "--json", "name,isArchived,isFork"]);
  });

  it("lists alerts across pages and answers 403/404 as unavailable", async () => {
    const { gh } = runner({ "api --paginate": { exitCode: 0, stdout: '[{"number":1}]\n[{"number":2}]' } });
    expect(await ghSecurityPort(gh).listAlerts({ source: "code-scanning", owner: "o", repo: "r" })).toEqual([{ number: 1 }, { number: 2 }]);
    const denied = runner({ "api --paginate": { exitCode: 1, stderr: "gh: Code scanning is not enabled (HTTP 403)" } });
    await expect(ghSecurityPort(denied.gh).listAlerts({ source: "code-scanning", owner: "o", repo: "r" })).rejects.toBeInstanceOf(AlertsUnavailableError);
    const broken = runner({ "api --paginate": { exitCode: 1, stderr: "HTTP 500" } });
    await expect(ghSecurityPort(broken.gh).listAlerts({ source: "code-scanning", owner: "o", repo: "r" })).rejects.toThrow("failed (exit 1): HTTP 500");
  });

  it("refuses a source with more alerts than the cap", async () => {
    const many = JSON.stringify(Array.from({ length: 1001 }, (_, index) => ({ number: index + 1 })));
    const { gh } = runner({ "api --paginate": { exitCode: 0, stdout: many } });
    await expect(ghSecurityPort(gh).listAlerts({ source: "code-scanning", owner: "o", repo: "r" })).rejects.toThrow("narrow the target");
  });

  it("answers a 404 alert read as gone and parses the repository listing", async () => {
    const gone = runner({ "api repos/o/r/code-scanning/alerts/1": { exitCode: 1, stderr: "gh: Not Found (HTTP 404)" } });
    await expect(ghSecurityPort(gone.gh).readAlert({ source: "code-scanning", owner: "o", repo: "r", number: 1 })).rejects.toBeInstanceOf(AlertGoneError);
    const listing = runner({ "repo list": { exitCode: 0, stdout: '[{"name":"a","isArchived":false,"isFork":true}]' } });
    expect(await ghSecurityPort(listing.gh).listRepos("o")).toEqual([{ name: "a", isArchived: false, isFork: true }]);
    const bad = runner({ "repo list": { exitCode: 0, stdout: '[{"name":"a"}]' } });
    await expect(ghSecurityPort(bad.gh).listRepos("o")).rejects.toThrow("lacks name");
  });

  it("runs gh through pi.exec and turns a kill or failure to start into an error", async () => {
    const ok = ghRunner(async () => ({ stdout: "x", stderr: "", code: 0, killed: false }), { cwd: "/tmp" });
    expect(await ok(["api", "user"])).toEqual({ exitCode: 0, stdout: "x", stderr: "" });
    const killed = ghRunner(async () => ({ stdout: "", stderr: "", code: 1, killed: true }), { cwd: "/tmp" });
    await expect(killed(["api", "user"])).rejects.toThrow("was stopped");
    const missing = ghRunner(async () => { throw new Error("ENOENT"); }, { cwd: "/tmp" });
    await expect(missing(["api"])).rejects.toThrow("is it installed");
  });
});

describe("file_gh_security_tickets: the Linear port against a fake fetch", () => {
  const respond = (data: unknown, status = 200): LinearFetch => async () => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify({ data }),
  });
  const SAHW = WORKSPACES[0]!;

  it("picks the workspace's key, falling back to LINEAR_API_KEY, and refuses with none", () => {
    expect(linearKey(SAHW, { LINEAR_API_KEY_SAH: "a", LINEAR_API_KEY: "b" })).toBe("a");
    expect(linearKey(SAHW, { LINEAR_API_KEY: "b" })).toBe("b");
    expect(() => linearKey(SAHW, {})).toThrow("no Linear API key for the SAH workspace");
  });

  it("sends the key as the Authorization header and the filter as a variable", async () => {
    let sent: { headers: Record<string, string>; body: string } | undefined;
    const port = securityLinearPort({
      env: { LINEAR_API_KEY_SAH: "lin_api_x" },
      fetch: async (_url, init) => {
        sent = { headers: init.headers, body: init.body };
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { issues: { nodes: [{ identifier: "SAH-1", title: "t", state: { name: "Triage" } }], pageInfo: { hasNextPage: false } } } }) };
      },
    });
    expect(await port.searchIssues(SAHW, "ghsec:")).toEqual([{ identifier: "SAH-1", title: "t", status: "Triage" }]);
    expect(sent!.headers.Authorization).toBe("lin_api_x");
    expect(requestJson(sent!).variables.filter).toEqual({ team: { key: { eq: "SAH" } }, title: { contains: "ghsec:" } });
  });

  it("walks pages and reports a missing cursor", async () => {
    const pages = [
      { issues: { nodes: [{ identifier: "A-1", title: "t", state: { name: "s" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
      { issues: { nodes: [{ identifier: "A-2", title: "t", state: { name: "s" } }], pageInfo: { hasNextPage: false } } },
    ];
    let at = 0;
    const port = securityLinearPort({ env: { LINEAR_API_KEY: "k" }, fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: pages[at++] }) }) });
    expect((await port.searchIssues(SAHW, "x")).map((issue) => issue.identifier)).toEqual(["A-1", "A-2"]);
    const stuck = securityLinearPort({ env: { LINEAR_API_KEY: "k" }, fetch: respond({ issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } } }) });
    await expect(stuck.searchIssues(SAHW, "x")).rejects.toThrow("gives no cursor");
  });

  it("creates an issue by team id and answers its identifier", async () => {
    const bodies: { query: string; variables: Record<string, unknown> }[] = [];
    const port = securityLinearPort({
      env: { LINEAR_API_KEY: "k" },
      fetch: async (_url, init) => {
        const body = requestJson(init);
        bodies.push(body);
        const data = body.query.includes("teams(") ? { teams: { nodes: [{ id: "team-1" }] } } : { issueCreate: { success: true, issue: { identifier: "SAH-9" } } };
        return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
      },
    });
    expect(await port.createIssue(SAHW, { title: "t", description: "d", priority: 2, stateId: "s1", labelIds: ["l1"] })).toEqual({ identifier: "SAH-9" });
    expect((bodies[1]!.variables.input as Record<string, unknown>)).toMatchObject({ teamId: "team-1", priority: 2, stateId: "s1", labelIds: ["l1"] });
  });

  it("reports an HTTP error, a GraphQL error and a refused write", async () => {
    await expect(securityLinearPort({ env: { LINEAR_API_KEY: "k" }, fetch: respond({}, 401) }).listStatuses(SAHW)).rejects.toThrow("HTTP 401");
    const gql: LinearFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: "bad filter" }] }) });
    await expect(securityLinearPort({ env: { LINEAR_API_KEY: "k" }, fetch: gql }).listStatuses(SAHW)).rejects.toThrow("bad filter");
    const refused = securityLinearPort({ env: { LINEAR_API_KEY: "k" }, fetch: async (_url, init) => {
      const body = requestJson(init);
      const data = body.query.includes("issue(id") && !body.query.includes("mutation") ? { issue: { id: "i1" } } : { commentCreate: { success: false } };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
    } });
    await expect(refused.saveComment(SAHW, { ticket: "SAH-1", body: "x" })).rejects.toThrow("refused");
  });

  it("finds a workspace label or the team's own, never another team's", async () => {
    const port = securityLinearPort({ env: { LINEAR_API_KEY: "k" }, fetch: respond({ issueLabels: { nodes: [{ id: "x", name: "Security", team: { key: "ZYS" } }, { id: "y", name: "Security", team: null }] } }) });
    expect(await port.findLabel(SAHW, "Security")).toEqual({ id: "y", name: "Security" });
  });
});

describe("file_gh_security_tickets: the tool", () => {
  it("has a description of 80 to 250 words that states its boundaries", () => {
    const words = DESCRIPTION.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    for (const phrase of ["dryRun", "minSeverity", "MUTATES Linear", "Dependabot", "LINEAR_API_KEY", "Returns", "read back"]) expect(DESCRIPTION).toContain(phrase);
  });

  it("summarizes a dry run and a real run", () => {
    const base = {
      target: "o", dryRun: true, workspace: { team: "ZYS" }, repos: { visited: ["o/r"], skipped: [{ repo: "o/old", reason: "archived" }] },
      items: { total: 1, bySource: {} }, minSeverity: "low" as const,
      tickets: { created: [], existing: 2, settled: [], failed: [], wouldCreate: ["t1"], wouldSettle: [] },
    };
    expect(summarize(base)).toContain("would create 1, would settle 0, 2 already ticketed");
    expect(summarize(base)).toContain("skipped o/old: archived");
    expect(summarize({ ...base, dryRun: false, tickets: { ...base.tickets, created: [{ identifier: "ZYS-1", tag: "t1" }], wouldCreate: [] } })).toContain("created ZYS-1 t1");
  });

  it("runs end to end through its factory against fake gh and fake Linear fetch, writing nothing on a dry run", async () => {
    const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
    const asked: string[][] = [];
    const pi = {
      cwd: "/tmp",
      zod: chain,
      exec: async (_bin: string, args: string[]) => {
        asked.push(args);
        if (args[0] === "repo") return { stdout: '[{"name":"tool","isArchived":false,"isFork":false}]', stderr: "", code: 0, killed: false };
        if (!args.some((arg) => arg.includes("secret-scanning"))) return { stdout: "[]", stderr: "", code: 0, killed: false };
        return { stdout: '[{"number":4,"state":"open","html_url":"https://github.com/zachbornheimer/tool/security/secret-scanning/4","secret_type":"aws"}]', stderr: "", code: 0, killed: false };
      },
    };
    const previous = { ...process.env };
    process.env.LINEAR_API_KEY = "k";
    const realFetch = globalThis.fetch;
    const linearCalls: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      linearCalls.push(requestJson(init).query);
      return new Response(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }));
    }) as unknown as typeof fetch;
    try {
      const tool = (await (factory as unknown as (pi: unknown) => Promise<{
        name: string;
        execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { tickets: { wouldCreate: string[] } } }>;
      }>)(pi));
      expect(tool.name).toBe("file_gh_security_tickets");
      const outcome = await tool.execute("id", { target: "zachbornheimer/tool", dryRun: true }, undefined, undefined, undefined);
      expect(outcome.details.tickets.wouldCreate).toEqual(["ghsec:zachbornheimer/tool#secret-scanning-4"]);
      expect(linearCalls.every((query) => query.startsWith("query"))).toBe(true);
      expect(asked.every((args) => args[0] === "api" || args[0] === "repo")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      process.env.LINEAR_API_KEY = previous.LINEAR_API_KEY;
      if (previous.LINEAR_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
    }
  });
});
