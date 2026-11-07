import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQuotaCensus, queryLowWeeklyQuotas } from "./census.js";
import { FileClaimStore, quotaPeriodKey } from "./claims.js";
import type { Exec } from "./omp_model.js";
import { loadPromptSpec, ompFilePort, parseFilingReply, validateReviewAnswer, type FilePort, type PromptSpec } from "./review.js";
import { runQuotaBurnReview, type Ports } from "./workflow.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const RESET = Date.parse("2026-11-09T00:00:00Z");
let dir = "";
let dbPath = "";

function makeDb(rows: Array<Record<string, unknown>>): void {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE usage_history (id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL, account_key TEXT NOT NULL, email TEXT, account_id TEXT, limit_id TEXT NOT NULL, label TEXT NOT NULL, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER)`);
  for (const r of rows) {
    db.run(
      "INSERT INTO usage_history (recorded_at, provider, account_key, email, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [1, r.provider ?? "anthropic", r.account_key ?? "acct", r.email ?? "me@example.com", r.limit_id ?? "weekly", r.label ?? "Weekly", r.window_label ?? "Weekly", r.used_fraction ?? 0.95, r.status ?? "warning", r.resets_at ?? RESET],
    );
  }
  db.close();
}

const GOOD = {
  summary: "Subagent fan-out re-read the same file.",
  root_causes: [{ category: "inefficient_tool_calls", why: "re-reads", evidence: { session_ids: ["omp:abc"], detail: "40 re-reads" }, estimated_share: 0.5 }],
  recommendations: [{ change: "read once", saving: "30%" }],
  linear_issues: [{ action: "create", title: "Stop re-reads", summary: "cache the file" }],
};

let spec: PromptSpec;
let prompts: string[];
let filed: number;

function ports(over: Partial<Ports> = {}, replies: string[] = [JSON.stringify(GOOD)]): Ports {
  prompts = [];
  filed = 0;
  let call = 0;
  const filer: FilePort = async (answer) => {
    filed += 1;
    return answer.linear_issues.map((i) => ({ ...i, link: "https://linear.app/zysys/issue/AI-1" }));
  };
  return {
    queryQuotas: (t) => queryLowWeeklyQuotas(t, dbPath),
    census: async () => "## CENSUS",
    claims: new FileClaimStore(join(dir, "claims")),
    step: async (prompt) => {
      prompts.push(prompt);
      return replies[Math.min(call++, replies.length - 1)]!;
    },
    spec,
    filer,
    reportDir: join(dir, "reports"),
    now: () => NOW,
    ...over,
  };
}

const INPUT = { threshold_used_fraction: 0.9, days: 7, re_review: false };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qbr-"));
  dbPath = join(dir, "agent.db");
  spec = await loadPromptSpec();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("queryLowWeeklyQuotas", () => {
  it("returns only the latest weekly rows at or over the threshold, skipping short windows", () => {
    makeDb([
      { limit_id: "weekly", used_fraction: 0.5 }, // superseded by the later row below
      { limit_id: "weekly", used_fraction: 0.95 },
      { limit_id: "5h", window_label: "5 hour", used_fraction: 0.99 },
      { provider: "openai", limit_id: "codex-1w", window_label: "", used_fraction: 0.91, email: "" },
      { provider: "google", limit_id: "weekly", used_fraction: 0.2 },
    ]);
    const rows = queryLowWeeklyQuotas(0.9, dbPath);
    expect(rows.map((r) => `${r.provider}:${r.limit_id}`)).toEqual(["anthropic:weekly", "openai:codex-1w"]);
    expect(rows[0]!.remaining_pct).toBe(5);
    expect(rows[1]!.email).toBeUndefined();
  });

  it("throws for a missing database instead of reporting no quotas", () => {
    expect(() => queryLowWeeklyQuotas(0.9, join(dir, "missing.db"))).toThrow();
  });
});

describe("census", () => {
  it("attributes tokens by model, purpose and session, counting nested subagent files and skipping old files", async () => {
    const root = join(dir, "sessions");
    const sid = "11111111-2222-3333-4444-555555555555";
    await mkdir(join(root, "proj", sid), { recursive: true });
    const msg = (model: string, input: number) =>
      JSON.stringify({ type: "message", message: { provider: "anthropic", model, usage: { input, output: 10, cacheRead: 100, cacheWrite: 5, cost: { total: 1.5 } } } });
    await writeFile(
      join(root, "proj", `2026-11-06_${sid}.jsonl`),
      [JSON.stringify({ type: "model_change", model: "a" }), JSON.stringify({ type: "model_change", model: "b" }), msg("b", 1_000_000), "not json"].join("\n"),
    );
    await writeFile(join(root, "proj", sid, "Sub.jsonl"), msg("b", 2_000_000));
    const old = join(root, "proj", "old_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    await writeFile(old, msg("b", 9_000_000));
    await utimes(old, new Date(NOW - 30 * 86_400_000), new Date(NOW - 30 * 86_400_000));
    await utimes(join(root, "proj", `2026-11-06_${sid}.jsonl`), new Date(NOW), new Date(NOW));
    await utimes(join(root, "proj", sid, "Sub.jsonl"), new Date(NOW), new Date(NOW));

    const text = await buildQuotaCensus(root, 7, NOW + 1000);
    expect(text).toContain("(2 session/subagent files analyzed)");
    expect(text).toContain("Total Mid-Session Model Switches:** 1 (direct post-switch turn cost: $1.50)");
    expect(text).toContain("`anthropic/b` | 2 | 3.00M");
    expect(text).toContain("`anthropic:subagent` | 1 | 2.00M");
    expect(text).toContain("`anthropic:main-turn` | 1 | 1.00M");
    expect(text).toContain(`omp:${sid}\` | 2 | 1 (50.0%)`);
    // Every table row has as many cells as its header.
    const rows = text.split("\n").filter((l) => l.startsWith("|"));
    const purposeHeader = rows.findIndex((l) => l.startsWith("| Provider : Purpose"));
    expect(rows[purposeHeader]!.split("|").length).toBe(rows[purposeHeader + 1]!.split("|").length);
  });

  it("returns an empty census for a missing sessions dir", async () => {
    expect(await buildQuotaCensus(join(dir, "none"), 7, NOW)).toContain("(0 session/subagent files analyzed)");
  });
});

describe("claims", () => {
  it("claims once atomically, allows one retry after failure, and releases", async () => {
    const store = new FileClaimStore(join(dir, "c"));
    const [a, b] = await Promise.all([store.claim(["p:1"]), store.claim(["p:1"])]);
    expect([...a, ...b]).toEqual(["p:1"]);
    await store.markFailed(["p:1"], "boom");
    expect(await store.claim(["p:1"])).toEqual(["p:1"]);
    await store.markFailed(["p:1"], "boom again");
    expect(await store.claim(["p:1"])).toEqual([]);
    await store.release(["p:1"]);
    expect(await store.claim(["p:1"])).toEqual(["p:1"]);
    await store.markReviewed(["p:1"], "/r.md");
    expect(await store.claim(["p:1"])).toEqual([]);
  });

  it("falls back to a week bucket when a limit has no reset time", () => {
    expect(quotaPeriodKey({ provider: "x", resets_at: 5 }, NOW)).toBe("x:5");
    expect(quotaPeriodKey({ provider: "x" }, NOW)).toBe(quotaPeriodKey({ provider: "x" }, NOW + 1000));
    expect(quotaPeriodKey({ provider: "x" }, NOW)).not.toBe(quotaPeriodKey({ provider: "x" }, NOW + 8 * 86_400_000));
  });
});

describe("runQuotaBurnReview", () => {
  it("no_low_quotas: touches nothing", async () => {
    makeDb([{ used_fraction: 0.1 }]);
    const p = ports();
    const out = await runQuotaBurnReview(INPUT, p);
    expect(out.status).toBe("no_low_quotas");
    expect(prompts).toHaveLength(0);
    expect(await existsDir(join(dir, "reports"))).toBe(false);
  });

  it("reviewed path: claims, asks, files, writes the report and marks it reviewed; second run is already_reviewed", async () => {
    makeDb([{}]);
    const out = await runQuotaBurnReview(INPUT, ports());
    expect(out.status).toBe("reviewed");
    expect(out.linear_issues[0]!.link).toBe("https://linear.app/zysys/issue/AI-1");
    expect(prompts[0]).toContain("## CENSUS");
    expect(prompts[0]).toContain("`me@example.com`");
    expect(prompts[0]).toContain("JSON Schema");
    const report = await readFile(out.report_path!, "utf8");
    expect(report).toContain("## Quota Burn Review");
    expect(report).toContain("https://linear.app/zysys/issue/AI-1");
    expect(filed).toBe(1);

    const again = await runQuotaBurnReview(INPUT, ports());
    expect(again.status).toBe("already_reviewed");
    expect(prompts).toHaveLength(0);
    expect(filed).toBe(0);
  });

  it("re_review releases the claim and reviews again", async () => {
    makeDb([{}]);
    await runQuotaBurnReview(INPUT, ports());
    const out = await runQuotaBurnReview({ ...INPUT, re_review: true }, ports());
    expect(out.status).toBe("reviewed");
    expect(prompts).toHaveLength(1);
  });

  it("retries invalid model JSON with the reason, then succeeds", async () => {
    makeDb([{}]);
    const out = await runQuotaBurnReview(INPUT, ports({}, ["not json", JSON.stringify({ ...GOOD, root_causes: [] }), JSON.stringify(GOOD)]));
    expect(out.status).toBe("reviewed");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("root_causes must have at least 1");
  });

  it("fails after three invalid replies, files nothing, writes no report and leaves the period retryable once", async () => {
    makeDb([{}]);
    await expect(runQuotaBurnReview(INPUT, ports({}, ["nope"]))).rejects.toThrow(/no valid reply after 3 attempts/);
    expect(filed).toBe(0);
    expect(await existsDir(join(dir, "reports"))).toBe(false);
    const retry = await runQuotaBurnReview(INPUT, ports());
    expect(retry.status).toBe("reviewed");
  });

  it("surfaces a filing failure, saves the unfiled review and marks the period failed", async () => {
    makeDb([{}]);
    const failing = ports({ filer: async () => { throw new Error("Linear is down"); } });
    await expect(runQuotaBurnReview(INPUT, failing)).rejects.toThrow(/Linear filing failed: Linear is down.*UNFILED/s);
    const files = await readdir(join(dir, "reports"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("UNFILED");
    expect(await readFile(join(dir, "reports", files[0]!), "utf8")).toContain("Linear filing failed: Linear is down");
    // not marked reviewed: one retry is allowed, a third attempt is not
    expect((await runQuotaBurnReview(INPUT, ports())).status).toBe("reviewed");
  });

  it("skips filing when the model proposes no issues", async () => {
    makeDb([{}]);
    const out = await runQuotaBurnReview(INPUT, ports({}, [JSON.stringify({ ...GOOD, linear_issues: [] })]));
    expect(out.status).toBe("reviewed");
    expect(filed).toBe(0);
  });

  it("propagates an abort", async () => {
    makeDb([{}]);
    const controller = new AbortController();
    controller.abort();
    await expect(runQuotaBurnReview(INPUT, ports(), controller.signal)).rejects.toThrow();
  });
});

describe("validation and filing", () => {
  it("rejects bad shapes with a path", () => {
    expect(() => validateReviewAnswer({ ...GOOD, root_causes: [{ ...GOOD.root_causes[0], estimated_share: 2 }] })).toThrow(/estimated_share/);
    expect(() => validateReviewAnswer({ ...GOOD, extra: 1 })).toThrow(/unexpected property/);
    expect(() => validateReviewAnswer({ ...GOOD, linear_issues: [{ action: "x", title: "t", summary: "s" }] })).toThrow(/action/);
  });

  it("parseFilingReply requires one Linear URL per issue", () => {
    const issues = GOOD.linear_issues as never[];
    expect(parseFilingReply('{"filed":[{"title":"t","url":"https://linear.app/a/issue/B-1"}]}', issues)[0]!.link).toBe("https://linear.app/a/issue/B-1");
    expect(() => parseFilingReply('{"filed":[]}', issues)).toThrow(/0 issue/);
    expect(() => parseFilingReply('{"filed":[{"title":"t","url":"http://x"}]}', issues)).toThrow(/not a https:\/\/linear.app URL/);
    expect(() => parseFilingReply("I filed it", issues)).toThrow(/not JSON/);
  });

  it("ompFilePort runs one full omp session (no --no-tools) and fails on a bad exit", async () => {
    const calls: string[][] = [];
    const ok: Exec = async (_c, args) => {
      calls.push(args);
      return { stdout: '{"filed":[{"title":"t","url":"https://linear.app/z/issue/A-1"}]}', stderr: "", code: 0, killed: false };
    };
    const result = await ompFilePort(ok, spec)(GOOD as never, { limits_table: "T", census: "C" });
    expect(result[0]!.link).toBe("https://linear.app/z/issue/A-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--no-tools");
    const bad: Exec = async () => ({ stdout: "", stderr: "mcp missing", code: 2, killed: false });
    await expect(ompFilePort(bad, spec)(GOOD as never, { limits_table: "T", census: "C" })).rejects.toThrow(/exited 2: mcp missing/);
  });
});

async function existsDir(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}
