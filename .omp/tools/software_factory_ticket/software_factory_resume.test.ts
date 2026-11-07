/**
 * What the omp port adds to the Mastra twin: the per-step checkpoint a rerun resumes from, cancellation by the tool's
 * signal, the run ledger's lease, the tool's heartbeats and parameters, and the Linear GraphQL port over a fake `fetch`.
 * Nothing here reaches Linear, GitHub or a model.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CHECKPOINT_MAX_AGE_MS, RUN_LEASE_MS } from "./constants.js";
import { fileCheckpoints } from "./checkpoint.js";
import { blocking, clean, FakeFactory, implemented } from "./fake_world.js";
import { linearKey, linearPort, type LinearFetch } from "./linear_port.js";
import { FactoryRunLedger } from "./run_ledger.js";
import { initialState } from "./schemas.js";
import { arr, int, obj, oneOf, opt, safeParse, str } from "./shape.js";
import { resultDetails, resultText, ticketTool } from "./ticket_tool.js";
import { runTicket } from "./workflow.js";
import { workspaceOfTeam } from "./workspaces.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "software-factory-resume-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function world(ticket = "SAH-1"): FakeFactory {
  const fake = new FakeFactory();
  fake.addIssue(ticket);
  return fake;
}

describe("a rerun skips the steps an earlier run finished", () => {
  it("resumes after the step that failed: the finished steps are not redone, and the writes before them are not repeated", async () => {
    const fake = world();
    fake.implementations.push(implemented());
    fake.changeReviews.push(clean);
    fake.failOnce = "implement";

    await expect(runTicket(fake.ports(), { ticket: "SAH-1", merge: false })).rejects.toThrow("the fake implement failed");
    const saved = fake.checkpointStore.get("SAH-1")!;
    expect(saved.finished).toBe(false);
    expect(saved.steps).toEqual([
      "get_linear_ticket",
      "analyze_ticket",
      "identify_ticket_repository",
      "open_ticket_worktree",
      "review_root_cause",
      "mark_in_progress",
    ]);
    const writesBefore = fake.linearWrites.filter((write) => write.includes("saveIssue")).length;
    const reviewsBefore = fake.reviewPrompts.length;

    const second = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });

    expect(second.resumed).toBe(true);
    expect(second.skipped).toEqual([...saved.steps]);
    expect(second.state.outcome).toBe("pr_ready");
    // The root-cause review ran once in all, and the settle writes the Pull Request status once.
    expect(fake.reviewPrompts.length - reviewsBefore).toBe(1);
    expect(fake.linearWrites.filter((write) => write.includes("saveIssue")).length - writesBefore).toBe(1);
    expect(fake.checkpointStore.get("SAH-1")!.finished).toBe(true);
    expect(fake.lockHolder).toBeUndefined();
  });

  it("opens the worktree again when the earlier run's is gone", async () => {
    const fake = world();
    fake.implementations.push(implemented());
    fake.changeReviews.push(clean);
    fake.failOnce = "implement";
    await expect(runTicket(fake.ports(), { ticket: "SAH-1", merge: false })).rejects.toThrow();
    const gone = fake.checkpointStore.get("SAH-1")!.state.worktree!.path;
    fake.removedWorktrees.add(gone);
    const opened = fake.worktrees.length;

    const second = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });

    expect(second.state.outcome).toBe("pr_ready");
    expect(fake.worktrees.length - opened).toBe(1);
  });

  it("starts over when the checkpoint is older than the limit, and never resumes a finished run", async () => {
    const fake = world();
    fake.implementations.push(implemented(), implemented());
    fake.changeReviews.push(clean, clean);
    fake.failOnce = "implement";
    await expect(runTicket(fake.ports(), { ticket: "SAH-1", merge: false })).rejects.toThrow();
    fake.clockMs += CHECKPOINT_MAX_AGE_MS + 1;

    const stale = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });
    expect(stale.resumed).toBe(false);
    expect(stale.skipped).toEqual([]);
    expect(stale.state.outcome).toBe("pr_ready");

    // The run above finished: a third run of the same ticket starts fresh instead of replaying a settled run.
    fake.issue("SAH-1").status = "Triage";
    const third = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });
    expect(third.resumed).toBe(false);
  });

  it("an early end (an undecipherable ticket) is a finished checkpoint, so a rerun asks the questions again", async () => {
    const fake = world();
    fake.rewrite = () => ({ decipherable: false, description: "", questions: ["Which product?"] });

    const first = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });

    expect(first.state.outcome).toBe("undecipherable");
    expect(fake.checkpointStore.get("SAH-1")!.finished).toBe(true);
    expect((await runTicket(fake.ports(), { ticket: "SAH-1", merge: false })).resumed).toBe(false);
  });

  it("a resumed fix round continues in the round the earlier run had reached", async () => {
    const fake = world();
    fake.implementations.push(implemented(), implemented());
    fake.changeReviews.push(blocking("The total is wrong."), clean);
    fake.failOnce = undefined;
    // Fail the second implementation round only.
    let implementCalls = 0;
    const ports = fake.ports();
    const implement = ports.implement;
    ports.implement = async (input) => {
      implementCalls += 1;
      if (implementCalls === 2) throw new Error("the second round was interrupted");
      return implement(input);
    };
    await expect(runTicket(ports, { ticket: "SAH-1", merge: false })).rejects.toThrow("interrupted");
    expect(fake.checkpointStore.get("SAH-1")!.steps).toContain("review_change#1");
    expect(fake.checkpointStore.get("SAH-1")!.steps).not.toContain("implement_ticket#2");

    const second = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });

    expect(second.state.outcome).toBe("pr_ready");
    expect(second.state.rounds).toBe(2);
    expect(second.skipped).toContain("implement_ticket#1");
    expect(second.skipped).toContain("review_change#1");
  });
});

describe("cancelling and failing a run", () => {
  it("a cancelled run keeps its checkpoint, writes no failure comment, frees the lock and records the failure", async () => {
    const fake = world();
    const controller = new AbortController();
    const ports = fake.ports();
    const implement = ports.implement;
    ports.implement = async (input) => {
      controller.abort();
      return implement(input);
    };
    fake.implementations.push(implemented());

    await expect(runTicket(ports, { ticket: "SAH-1", merge: false }, { signal: controller.signal })).rejects.toThrow();

    expect(fake.checkpointStore.get("SAH-1")?.finished).toBe(false);
    expect(fake.commentsOn("SAH-1")).toEqual([]);
    expect(fake.lockHolder).toBeUndefined();
    const [run] = await fake.ledger.listRuns({ ticket: "SAH-1" });
    expect(run?.status).toBe("failed");
  });

  it("a failed run leaves one comment on the ticket and the ledger's per-step timeline", async () => {
    const fake = world();
    fake.failOnce = "implement";

    await expect(runTicket(fake.ports(), { ticket: "SAH-1", merge: false }, { runId: "run-1" })).rejects.toThrow();

    expect(fake.commentsOn("SAH-1")).toHaveLength(1);
    const timeline = await fake.ledger.timeline("run-1");
    expect(timeline.at(-1)).toMatchObject({ step: "implement_ticket#1", status: "failed" });
    expect(timeline.filter((event) => event.status === "succeeded").map((event) => event.step)).toContain("review_root_cause");
  });

  it("a busy run reports the holder and writes no checkpoint", async () => {
    const fake = world();
    fake.lockHolder = "someone-else";

    const result = await runTicket(fake.ports(), { ticket: "SAH-1", merge: false });

    expect(result.state.outcome).toBe("busy");
    expect(result.state.busyHeldBy).toEqual({ runId: "someone-else", ticket: fake.lockHolderTicket });
    expect(fake.checkpointSaves).toEqual([]);
  });
});

describe("the checkpoint file", () => {
  const checkpointFor = (ticket: string, updatedAt = 5) => ({
    version: 1 as const,
    ticket,
    runId: "r",
    startedAt: 1,
    updatedAt,
    steps: ["get_linear_ticket"],
    state: initialState({ ticket, merge: false, runId: "r" }),
    finished: false,
  });

  it("round-trips, replaces atomically, and is discarded on request", async () => {
    const files = fileCheckpoints(join(dir, "checkpoints"));
    expect(await files.load("SAH-1")).toBeUndefined();
    await files.save(checkpointFor("SAH-1"));
    await files.save(checkpointFor("SAH-1", 9));
    expect((await files.load("SAH-1"))?.updatedAt).toBe(9);
    await files.discard("SAH-1");
    expect(await files.load("SAH-1")).toBeUndefined();
  });

  it("reads a file nobody can parse, or one of another ticket, as no checkpoint", async () => {
    const files = fileCheckpoints(dir);
    await writeFile(join(dir, "SAH-2.json"), "{ not json");
    await writeFile(join(dir, "SAH-3.json"), JSON.stringify(checkpointFor("SAH-4")));
    await writeFile(join(dir, "SAH-5.json"), JSON.stringify({ ...checkpointFor("SAH-5"), steps: "no" }));
    expect(await files.load("SAH-2")).toBeUndefined();
    expect(await files.load("SAH-3")).toBeUndefined();
    expect(await files.load("SAH-5")).toBeUndefined();
  });
});

describe("the run ledger's lease", () => {
  const NOW = new Date("2026-11-04T05:00:00.000Z");
  const ledgerAtNow = (file: string) => new FactoryRunLedger(file, { now: () => NOW });
  const deadOpening = (file: string, runId: string, ticket: string, ageMs: number) =>
    writeFile(
      file,
      `${JSON.stringify({ kind: "run", runId, workflow: "software_factory_ticket", ticket, status: "running", startedAt: new Date(NOW.getTime() - ageMs).toISOString() })}\n`,
    );

  it("stops counting an opening record with no closure as live once the lease has passed", async () => {
    const file = join(dir, "runs.jsonl");
    await deadOpening(file, "b6d5f348", "ZYS-2378", RUN_LEASE_MS + 1);
    const ledger = ledgerAtNow(file);
    expect((await ledger.listRuns())[0]?.status).toBe("stale");
    expect(await ledger.listRuns({ status: "running" })).toEqual([]);
  });

  it("keeps a run live while its steps are still being recorded within the lease", async () => {
    const file = join(dir, "runs.jsonl");
    await deadOpening(file, "live", "ZYS-1691", RUN_LEASE_MS * 4);
    const ledger = ledgerAtNow(file);
    await ledger.startStep("live", "implement_ticket");
    expect((await ledger.listRuns())[0]?.status).toBe("running");
  });

  it("heals the stale records on disk once, when the next run opens, and a run's own ending still wins", async () => {
    const file = join(dir, "runs.jsonl");
    await deadOpening(file, "b6d5f348", "ZYS-2378", RUN_LEASE_MS + 1);
    const ledger = ledgerAtNow(file);
    await ledger.startRun({ runId: "new-run", workflow: "software_factory_ticket", ticket: "ZYS-1690" });
    await ledger.startRun({ runId: "another", workflow: "software_factory_ticket", ticket: "ZYS-1691" });
    expect((await readFile(file, "utf8")).match(/"status":"stale"/g)).toHaveLength(1);
    await ledger.finishRun("b6d5f348", { status: "success", outcome: "pr_ready" });
    const [run] = await ledger.listRuns({ ticket: "ZYS-2378" });
    expect(run?.status).toBe("success");
  });

  it("never throws into the run when the file cannot be written, and says so", async () => {
    const ledger = new FactoryRunLedger(join(dir, "a-file", "x", "runs.jsonl"));
    await writeFile(join(dir, "a-file"), "this is a file, not a directory");
    await ledger.startRun({ runId: "r", workflow: "software_factory_ticket", ticket: "SAH-1" });
    expect(ledger.warnings[0]).toContain("factory run ledger unavailable");
  });
});

describe("the tool", () => {
  type Updates = { text: string }[];
  const SAH_HOME = {} as never;

  it("validates the ticket parameter, runs the ticket, sends progress updates and returns the outcome", async () => {
    const fake = world();
    fake.implementations.push(implemented());
    fake.changeReviews.push(clean);
    // omp's own zod is not installed beside the tools; a chainable recorder stands in and keeps the ticket regex it was given.
    const regexes: RegExp[] = [];
    const chain: unknown = new Proxy(function () {}, {
      get: (_target, name) => (name === "regex" ? (pattern: RegExp) => (regexes.push(pattern), chain) : () => chain),
      apply: () => chain,
    });
    // The implementer takes a moment, so heartbeats (every 5 ms here) arrive while a step is in flight.
    const slow = () => {
      const ports = fake.ports();
      const implement = ports.implement;
      ports.implement = async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return implement(input);
      };
      return ports;
    };
    const tool = ticketTool(slow, 5)({ zod: chain } as never) as unknown as {
      name: string;
      description: string;
      execute(id: string, params: unknown, onUpdate: (update: { content: { text: string }[] }) => void, ctx: unknown, signal: AbortSignal | undefined): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
    };
    expect(tool.name).toBe("software_factory_ticket");
    expect(tool.description).toContain("Mutates Linear, GitHub");
    expect(regexes[0]!.test("SAH-1")).toBe(true);
    expect(regexes[0]!.test("sah-1")).toBe(false);
    const updates: Updates = [];

    const result = await tool.execute("call", { ticket: "SAH-1" }, (update) => updates.push({ text: update.content[0]!.text }), SAH_HOME, undefined);

    expect(updates.length).toBeGreaterThan(2);
    expect(updates.some((update) => update.text.includes("implement_ticket#1"))).toBe(true);
    const settledAt = updates.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The heartbeat stops with the run.
    expect(updates.length).toBe(settledAt);
    expect(result.content[0]!.text).toContain("SAH-1: pr_ready, Linear status Pull Request");
    expect(result.details).toMatchObject({ ticket: "SAH-1", outcome: "pr_ready", resumed: false, skippedSteps: [] });
  });

  it("describes a busy run by its holder, and a resumed one by the steps it skipped", () => {
    const state = { ...initialState({ ticket: "SAH-1", merge: false, runId: "r" }), outcome: "busy" as const, busyHeldBy: { runId: "abc", ticket: "SAH-9" } };
    expect(resultText({ state, skipped: [], resumed: false })).toContain("held by run abc on SAH-9");
    expect(resultText({ state: { ...state, outcome: "pr_ready" }, skipped: ["get_linear_ticket"], resumed: true })).toContain("skipped: get_linear_ticket");
    expect(resultDetails({ state, skipped: [], resumed: false }, 3)).toMatchObject({ outcome: "busy", busyHeldBy: { runId: "abc" }, seconds: 3 });
  });
});

describe("the schema shapes", () => {
  const shape = obj({ name: str({ min: 1 }), kind: oneOf(["a", "b"] as const), tags: arr(str()), n: opt(int({ min: 0 })) });

  it("parse, drop unknown keys, leave an absent optional out, and name the path that broke", () => {
    expect(shape.parse({ name: "x", kind: "a", tags: ["t"], extra: 1 })).toEqual({ name: "x", kind: "a", tags: ["t"] });
    expect(shape.parse({ name: "x", kind: "a", tags: [], n: null })).toEqual({ name: "x", kind: "a", tags: [] });
    const bad = safeParse(shape, { name: "x", kind: "c", tags: [] });
    expect(bad).toEqual({ ok: false, error: "kind: expected one of a, b, got \"c\"" });
    const nested = safeParse(shape, { name: "x", kind: "a", tags: ["ok", 3] });
    expect(nested).toEqual({ ok: false, error: "tags[1]: expected a string, got number" });
  });

  it("render the JSON Schema a prompt shows a model, with defaults not required", () => {
    expect(shape.json).toMatchObject({ type: "object", required: ["name", "kind", "tags"], additionalProperties: false });
  });
});

describe("the Linear GraphQL port", () => {
  const ZYS = workspaceOfTeam("ZYS");
  const SAH = workspaceOfTeam("SAH");

  /** A fake `fetch` that answers each request from `answer` and records what was sent. */
  function fakeLinear(answer: (query: string, variables: Record<string, unknown>) => unknown) {
    const sent: { authorization: string; query: string; variables: Record<string, unknown> }[] = [];
    const fetch: LinearFetch = async (_url, init) => {
      const { body: payload } = init;
      const { query, variables } = JSON.parse(payload) as { query: string; variables: Record<string, unknown> };
      sent.push({ authorization: init.headers.Authorization!, query, variables });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: answer(query, variables) }) };
    };
    return { fetch, sent };
  }
  const env = { LINEAR_API_KEY_SAH: "key-sah", LINEAR_API_KEY_ZYS: "lin_oauth_zys" };

  it("reads an issue: identifier, status name, priority, attachments, a null description as empty", async () => {
    const { fetch, sent } = fakeLinear(() => ({
      issue: {
        identifier: "SAH-1",
        title: "T",
        description: null,
        priority: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        url: "https://linear.app/x/SAH-1",
        branchName: "sah-1",
        state: { name: "Triage" },
        attachments: { nodes: [{ title: "PR", url: "https://github.com/o/r/pull/1" }, { title: null, url: "https://x" }] },
      },
    }));
    const issue = await linearPort({ env, fetch }).getIssue(SAH, "SAH-1");
    expect(issue).toEqual({
      identifier: "SAH-1",
      title: "T",
      description: "",
      status: "Triage",
      priority: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      url: "https://linear.app/x/SAH-1",
      gitBranchName: "sah-1",
      attachments: [{ title: "PR", url: "https://github.com/o/r/pull/1" }, { url: "https://x" }],
    });
    // A personal key goes as is; the OAuth token of the other workspace goes as a bearer.
    expect(sent[0]!.authorization).toBe("key-sah");
  });

  it("sends an OAuth token as a bearer, and a workspace's own key rather than another's", async () => {
    const { fetch, sent } = fakeLinear(() => ({ teams: { nodes: [{ states: { nodes: [{ id: "s1", name: "Done" }] } }] } }));
    expect(await linearPort({ env, fetch }).listStatuses(ZYS)).toEqual([{ id: "s1", name: "Done" }]);
    expect(sent[0]!.authorization).toBe("Bearer lin_oauth_zys");
    expect(sent[0]!.variables).toEqual({ team: "ZYS" });
  });

  it("lists every comment across pages, oldest first, and refuses a next page with no cursor", async () => {
    const pages = [
      { nodes: [{ id: "c2", body: "b", createdAt: "2026-02-01" }], pageInfo: { hasNextPage: true, endCursor: "cur" } },
      { nodes: [{ id: "c1", body: "a", createdAt: "2026-01-01" }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    let page = 0;
    const { fetch, sent } = fakeLinear(() => ({ issue: { comments: pages[page++] } }));
    const comments = await linearPort({ env, fetch }).listComments(SAH, "SAH-1");
    expect(comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
    expect(sent[1]!.variables.after).toBe("cur");

    const broken = fakeLinear(() => ({ issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } } } }));
    await expect(linearPort({ env, fetch: broken.fetch }).listComments(SAH, "SAH-1")).rejects.toThrow(/gives no cursor/);
  });

  it("pages through every issue of a status, filtering by team, status and project", async () => {
    const pages = [
      { nodes: [{ identifier: "ZYS-1", priority: 1, createdAt: "2026-01-01", state: { name: "Unreviewed" } }], pageInfo: { hasNextPage: true, endCursor: "p1" } },
      { nodes: [{ identifier: "ZYS-2", priority: 0, createdAt: "2026-01-02", state: { name: "Unreviewed" } }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    let page = 0;
    const { fetch, sent } = fakeLinear(() => ({ issues: pages[page++] }));
    const issues = await linearPort({ env, fetch }).listIssues(ZYS, "Unreviewed", "AI Tooling");
    expect(issues.map((issue) => issue.identifier)).toEqual(["ZYS-1", "ZYS-2"]);
    expect(sent[0]!.variables.filter).toEqual({
      team: { key: { eq: "ZYS" } },
      state: { name: { eq: "Unreviewed" } },
      project: { name: { eq: "AI Tooling" } },
    });
  });

  it("saves a status by id, a description and a duplicate relation, and a comment, naming the issue by its uuid", async () => {
    const { fetch, sent } = fakeLinear((query) =>
      query.includes("issue(id:") && query.includes("{ id }")
        ? { issue: { id: "uuid-1" } }
        : query.includes("issueUpdate")
        ? { issueUpdate: { success: true } }
        : query.includes("issueRelationCreate")
        ? { issueRelationCreate: { success: true } }
        : { commentCreate: { success: true } }
    );
    const port = linearPort({ env, fetch });
    await port.saveIssue(SAH, { ticket: "SAH-1", description: "d", stateId: "s1", duplicateOf: "SAH-2" });
    await port.saveComment(SAH, { ticket: "SAH-1", body: "hello" });
    const update = sent.find((request) => request.query.includes("issueUpdate"))!;
    expect(update.variables).toEqual({ id: "uuid-1", input: { description: "d", stateId: "s1" } });
    expect(sent.find((request) => request.query.includes("issueRelationCreate"))!.variables).toEqual({
      input: { issueId: "uuid-1", relatedIssueId: "uuid-1", type: "duplicate" },
    });
    expect(sent.find((request) => request.query.includes("commentCreate"))!.variables).toEqual({ input: { issueId: "uuid-1", body: "hello" } });
  });

  it("refuses a write Linear answers success false, an HTTP error, a GraphQL error and a workspace with no key", async () => {
    const refused = fakeLinear((query) => (query.includes("{ id }") ? { issue: { id: "u" } } : { commentCreate: { success: false } }));
    await expect(linearPort({ env, fetch: refused.fetch }).saveComment(SAH, { ticket: "SAH-1", body: "x" })).rejects.toThrow(/refused/);

    const http: LinearFetch = async () => ({ ok: false, status: 401, text: async () => "no" });
    await expect(linearPort({ env, fetch: http }).getIssue(SAH, "SAH-1")).rejects.toThrow(/HTTP 401/);

    const graphqlError: LinearFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: "Could not find project" }] }) });
    await expect(linearPort({ env, fetch: graphqlError }).listIssues(SAH, "Triage", "P")).rejects.toThrow(/Could not find project/);

    await expect(linearKey(ZYS, {}, async () => undefined)).rejects.toThrow(/LINEAR_API_KEY_ZYS/);
    expect(await linearKey(ZYS, {}, async (service, account) => (account === "linear.zys_access_token" ? `kc-${service}` : undefined))).toBe("kc-capability-gateway");
  });
});
