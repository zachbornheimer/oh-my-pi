import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import { DECISIONS_DIR_ENV, DuplicateDecisionError, pinDecision, pinnedDecisions } from "./store.js";

let directory = "";
let previous: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "resolve-decision-"));
  previous = process.env[DECISIONS_DIR_ENV];
  process.env[DECISIONS_DIR_ENV] = directory;
});

afterEach(async () => {
  if (previous === undefined) delete process.env[DECISIONS_DIR_ENV];
  else process.env[DECISIONS_DIR_ENV] = previous;
  await rm(directory, { recursive: true, force: true });
});

interface Output {
  id: number;
  status: "unpinned" | "not_pinned";
  session: string;
  text: string;
}

interface Tool {
  name: string;
  description: string;
  loadMode?: string;
  execute: (id: string, params: Record<string, unknown>, onUpdate: undefined, ctx: unknown, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: Output }>;
}

function tool(): Tool {
  // The load check against omp's own zod lives outside the suite; here a tiny builder records the schema shape.
  const schema = (kind: string) => {
    const node: Record<string, unknown> = { kind };
    const chain = new Proxy(node, { get: (_t, key) => (key === "kind" ? kind : () => chain) });
    return chain;
  };
  const zod = new Proxy({}, { get: (_t, kind) => (..._a: unknown[]) => schema(String(kind)) });
  return factory({ zod, exec: async () => ({}), cwd: "/", logger: {} } as never) as unknown as Tool;
}

const ctx = { sessionManager: { getSessionId: () => "omp-session-7" } };

describe("resolve_decision", () => {
  it("is essential and describes itself in 80 to 250 words, naming pin_decision", () => {
    const resolve = tool();
    expect(resolve.name).toBe("resolve_decision");
    expect(resolve.loadMode).toBe("essential");
    const words = resolve.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(resolve.description).toContain("pin_decision");
  });

  it("unpins a pin from this omp session by default and returns the envelope the decision band reads", async () => {
    await pinDecision(directory, "omp-session-7", "Which database?", ["SQLite", "Postgres"]);
    const result = await tool().execute("t1", { id: 1, session: null }, undefined, ctx);
    expect(result.details).toEqual({ id: 1, status: "unpinned", session: "omp-session-7", text: "Unpinned decision 1." });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ capability: "resolve_decision", output: result.details });
    expect(await pinnedDecisions(directory, "omp-session-7")).toEqual([]);
  });

  it("remembers the question as resolved, so the same question cannot be pinned again", async () => {
    await pinDecision(directory, "s1", "Ship it?", ["Yes"]);
    await tool().execute("t2", { id: 1, session: "s1" }, undefined, ctx);
    const repeat = pinDecision(directory, "s1", "ship it?", ["Yes"]);
    await expect(repeat).rejects.toBeInstanceOf(DuplicateDecisionError);
    await expect(repeat).rejects.toThrow(/decision 1 was already answered or dismissed/);
  });

  it("reports not_pinned, never an error, for an unknown id, a repeat, or another session's pin", async () => {
    await pinDecision(directory, "s1", "Q?", ["a"]);
    const resolve = tool();
    expect((await resolve.execute("t3", { id: 99, session: "s1" }, undefined, ctx)).details).toEqual({ id: 99, status: "not_pinned", session: "s1", text: "No pinned decision 99." });
    expect((await resolve.execute("t4", { id: 1, session: "other" }, undefined, ctx)).details.status).toBe("not_pinned");
    expect((await resolve.execute("t5", { id: 1, session: "s1" }, undefined, ctx)).details.status).toBe("unpinned");
    expect((await resolve.execute("t6", { id: 1, session: "s1" }, undefined, ctx)).details.status).toBe("not_pinned");
  });

  it("falls back to the `default` session without an omp session", async () => {
    await pinDecision(directory, "default", "Q?", ["a"]);
    const result = await resolve_default();
    expect(result.details).toMatchObject({ id: 1, status: "unpinned", session: "default" });
  });

  it("fails when the session file is corrupt, naming the file", async () => {
    await Bun.write(join(directory, "bad.json"), "{nope");
    await expect(tool().execute("t8", { id: 1, session: "bad" }, undefined, ctx)).rejects.toThrow(/bad\.json is not valid JSON/);
  });

  it("refuses a call that is already cancelled, writing nothing", async () => {
    await pinDecision(directory, "s1", "Q?", ["a"]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    await expect(tool().execute("t9", { id: 1, session: "s1" }, undefined, ctx, controller.signal)).rejects.toThrow("cancelled by user");
    expect(await pinnedDecisions(directory, "s1")).toHaveLength(1);
  });
});

async function resolve_default() {
  return tool().execute("t7", { id: 1 }, undefined, undefined);
}
