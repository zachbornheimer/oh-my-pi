import { Database } from "bun:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface QuotaLimitRow {
  provider: string;
  account_key: string;
  email?: string;
  limit_id: string;
  label: string;
  window_label?: string;
  used_fraction: number;
  remaining_pct: number;
  status?: string;
  resets_at?: number;
  ledger_key: string;
}

const SQL = `
  SELECT provider, account_key, COALESCE(email, '') AS email, limit_id, label,
         COALESCE(window_label, '') AS window_label, COALESCE(used_fraction, 0) AS used_fraction,
         COALESCE(status, '') AS status, COALESCE(resets_at, 0) AS resets_at
  FROM usage_history
  WHERE id IN (SELECT MAX(id) FROM usage_history GROUP BY provider, account_key, limit_id)
    AND COALESCE(used_fraction, 0) >= ?
    AND (
      LOWER(COALESCE(window_label, '')) LIKE '%week%'
      OR LOWER(COALESCE(window_label, '')) LIKE '%7 day%'
      OR LOWER(limit_id) LIKE '%1w%'
      OR LOWER(limit_id) LIKE '%7d%'
      OR LOWER(limit_id) LIKE '%weekly%'
    )
    AND LOWER(COALESCE(window_label, '')) NOT LIKE '%5h%'
    AND LOWER(COALESCE(window_label, '')) NOT LIKE '%5 hour%'
    AND LOWER(COALESCE(window_label, '')) NOT LIKE '%session%'
    AND LOWER(COALESCE(limit_id, '')) NOT LIKE '%5h%'
  ORDER BY provider, account_key, limit_id
`;

/**
 * Latest usage_history row per provider/account/limit whose weekly window is at least `threshold` used.
 * The database is opened read-only. A missing file, missing table or bad query THROWS: it is never reported as
 * "no low quotas".
 */
export function queryLowWeeklyQuotas(threshold: number, dbPath: string): QuotaLimitRow[] {
  if (!Number.isFinite(threshold)) throw new Error(`threshold_used_fraction is not a finite number: ${threshold}`);
  const database = new Database(dbPath, { readonly: true });
  try {
    const rows = database.query(SQL).all(threshold) as Array<{
      provider: string;
      account_key: string;
      email: string;
      limit_id: string;
      label: string;
      window_label: string;
      used_fraction: number;
      status: string;
      resets_at: number;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      account_key: row.account_key,
      email: row.email || undefined,
      limit_id: row.limit_id,
      label: row.label,
      window_label: row.window_label || undefined,
      used_fraction: row.used_fraction,
      remaining_pct: Math.max(0, Math.round((1 - row.used_fraction) * 1000) / 10),
      status: row.status || undefined,
      resets_at: row.resets_at || undefined,
      ledger_key: `${row.provider}:${row.account_key}:${row.limit_id}:${row.resets_at || 0}`,
    }));
  } finally {
    database.close();
  }
}

interface Bucket {
  calls: number;
  inp: number;
  out: number;
  cr: number;
  cw: number;
  cost: number;
  switchCalls: number;
  switchUncachedIn: number;
}

const blank = (): Bucket => ({ calls: 0, inp: 0, out: 0, cr: 0, cw: 0, cost: 0, switchCalls: 0, switchUncachedIn: 0 });

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}
interface Entry {
  type?: string;
  model?: string;
  purpose?: string;
  provider?: string;
  usage?: Usage;
  message?: { provider?: string; model?: string; usage?: Usage };
}

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of names) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

const SESSION_FILE = /_[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/;
const SESSION_ID = /([0-9a-f]{8}-[0-9a-f-]{27})/;

/**
 * The 7-day (or `days`) token and quota attribution census over the local omp session JSONL files under
 * `sessionsDir` (searched recursively, so subagent files in per-session subdirectories are counted), as markdown.
 */
export async function buildQuotaCensus(sessionsDir: string, days: number, now: number): Promise<string> {
  const sinceMs = now - days * 86_400_000;
  const byProviderModel = new Map<string, Bucket>();
  const byPurpose = new Map<string, Bucket>();
  const bySession = new Map<string, Bucket & { subagentCalls: number }>();
  let files = 0;
  let totalModelSwitches = 0;
  let totalSwitchCost = 0;

  for await (const path of jsonlFiles(sessionsDir)) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || info.mtimeMs < sinceMs) continue;
    const content = await readFile(path, "utf8").catch(() => "");
    if (!content) continue;
    files += 1;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const isSubagent = !SESSION_FILE.test(base);
    const sessId = SESSION_ID.exec(path)?.[1] ?? base;
    let lastModel: string | undefined;
    let prevWasSwitch = false;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (entry.type === "model_change") {
        if (lastModel && entry.model && entry.model !== lastModel) {
          totalModelSwitches += 1;
          prevWasSwitch = true;
        }
        if (entry.model) lastModel = entry.model;
        continue;
      }
      const msg = entry.type === "message" ? entry.message : entry.type === "model_usage" ? entry : undefined;
      if (!msg?.usage) continue;
      const provider = msg.provider || "unknown";
      const model = msg.model || "unknown";
      const purpose = entry.type === "model_usage" ? entry.purpose || "auxiliary" : isSubagent ? "subagent" : "main-turn";
      const u = msg.usage;
      const inp = u.input || 0;
      const out = u.output || 0;
      const cr = u.cacheRead || 0;
      const cw = u.cacheWrite || 0;
      const cost = typeof u.cost?.total === "number" ? u.cost.total : 0;
      const add = (b: Bucket): void => {
        b.calls += 1;
        b.inp += inp;
        b.out += out;
        b.cr += cr;
        b.cw += cw;
        b.cost += cost;
      };

      const pmKey = `${provider}/${model}`;
      const pm = byProviderModel.get(pmKey) ?? blank();
      add(pm);
      if (prevWasSwitch && entry.type === "message") {
        pm.switchCalls += 1;
        pm.switchUncachedIn += inp + cw;
        totalSwitchCost += cost;
        prevWasSwitch = false;
      }
      byProviderModel.set(pmKey, pm);

      const ppKey = `${provider}:${purpose}`;
      const pp = byPurpose.get(ppKey) ?? blank();
      add(pp);
      byPurpose.set(ppKey, pp);

      const ss = bySession.get(sessId) ?? { ...blank(), subagentCalls: 0 };
      add(ss);
      if (isSubagent) ss.subagentCalls += 1;
      bySession.set(sessId, ss);
    }
  }

  const total = (b: Bucket) => b.inp + b.out + b.cr + b.cw;
  const top = <T extends Bucket>(map: Map<string, T>, n: number) => [...map.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, n);
  const lines: string[] = [
    `## ${days}-Day Token & Quota Burn Census (${files} session/subagent files analyzed)`,
    "",
    `- **Total Mid-Session Model Switches:** ${totalModelSwitches} (direct post-switch turn cost: $${totalSwitchCost.toFixed(2)})`,
    "",
    "### Top 15 Provider / Model Consumers",
    "| Provider / Model | Calls | Uncached In | Output | Cache Read | Cache Write | Post-Switch Uncached In | Est. Value |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [k, v] of top(byProviderModel, 15)) {
    lines.push(
      `| \`${k}\` | ${v.calls} | ${(v.inp / 1e6).toFixed(2)}M | ${(v.out / 1e6).toFixed(2)}M | ${(v.cr / 1e6).toFixed(1)}M | ${(v.cw / 1e6).toFixed(2)}M | ${(v.switchUncachedIn / 1e6).toFixed(2)}M | $${v.cost.toFixed(2)} |`,
    );
  }
  lines.push(
    "",
    "### Breakdown by Provider : Purpose (`main-turn` vs `subagent` vs `auxiliary`)",
    "| Provider : Purpose | Calls | Uncached In | Output | Cache Read | Cache Write | Est. Value |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const [k, v] of top(byPurpose, 15)) {
    lines.push(
      `| \`${k}\` | ${v.calls} | ${(v.inp / 1e6).toFixed(2)}M | ${(v.out / 1e6).toFixed(2)}M | ${(v.cr / 1e6).toFixed(1)}M | ${(v.cw / 1e6).toFixed(2)}M | $${v.cost.toFixed(2)} |`,
    );
  }
  lines.push(
    "",
    "### Top 10 Sessions by Total Token Volume",
    "| Session ID | Total Calls | Subagent Calls (%) | Uncached In | Output | Cache Read | Cache Write | Est. Value |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const [k, v] of top(bySession, 10)) {
    const subPct = v.calls > 0 ? ((v.subagentCalls / v.calls) * 100).toFixed(1) : "0.0";
    lines.push(
      `| \`omp:${k}\` | ${v.calls} | ${v.subagentCalls} (${subPct}%) | ${(v.inp / 1e6).toFixed(2)}M | ${(v.out / 1e6).toFixed(2)}M | ${(v.cr / 1e6).toFixed(1)}M | ${(v.cw / 1e6).toFixed(2)}M | $${v.cost.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}
