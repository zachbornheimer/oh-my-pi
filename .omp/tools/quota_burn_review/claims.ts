import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A quota limit row reduced to what identifies the reset period being claimed. */
export interface ClaimRow {
  readonly provider: string;
  readonly resets_at?: number;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * One key per provider weekly reset period: limit buckets, accounts and fallback events on the same
 * provider/reset share one claim. A row with no reset time falls back to the UTC week bucket of `now`,
 * so it is reviewed once per week instead of once forever.
 */
export function quotaPeriodKey(row: ClaimRow, now: number = Date.now()): string {
  if (row.resets_at) return `${row.provider}:${row.resets_at}`;
  return `${row.provider}:unknown-reset:${Math.floor(now / WEEK_MS)}`;
}

export interface ClaimStore {
  /** Atomically take the keys this run may review; returns the subset acquired. */
  claim(keys: string[]): Promise<string[]>;
  markReviewed(keys: string[], reportPath: string): Promise<void>;
  /** Record a failed attempt so one limited retry can re-claim. */
  markFailed(keys: string[], reason: string): Promise<void>;
  /** Drop the claims entirely. Only for an explicit operator-requested re-review. */
  release(keys: string[]): Promise<void>;
}

interface ClaimRecord {
  status: "claimed" | "reviewed" | "failed";
  attempts: number;
  updated_at: string;
  report_path?: string;
  last_error?: string;
}

const MAX_ATTEMPTS = 2;

/**
 * Claims as JSON files under `dir`, one per period key. The first claim is an O_EXCL create (`wx`), so two
 * processes on this machine cannot both acquire a period; the one retry of a failed claim is gated by a second
 * O_EXCL file. Machine-local only: there is no cross-machine dedup.
 */
export class FileClaimStore implements ClaimStore {
  constructor(private readonly dir: string) {}

  private pathOf(key: string): string {
    return join(this.dir, `${encodeURIComponent(key).replaceAll("%", "_")}.json`);
  }

  private async read(key: string): Promise<ClaimRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.pathOf(key), "utf8")) as ClaimRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async write(key: string, record: ClaimRecord): Promise<void> {
    const target = this.pathOf(key);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }

  private async exclusive(path: string, body: string): Promise<boolean> {
    try {
      await writeFile(path, body, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async claim(keys: string[]): Promise<string[]> {
    await mkdir(this.dir, { recursive: true });
    const claimed: string[] = [];
    for (const key of new Set(keys)) {
      const fresh: ClaimRecord = { status: "claimed", attempts: 1, updated_at: new Date().toISOString() };
      if (await this.exclusive(this.pathOf(key), `${JSON.stringify(fresh)}\n`)) {
        claimed.push(key);
        continue;
      }
      const existing = await this.read(key);
      if (existing?.status === "failed" && existing.attempts < MAX_ATTEMPTS) {
        if (await this.exclusive(`${this.pathOf(key)}.retry${existing.attempts}`, "")) {
          await this.write(key, { status: "claimed", attempts: existing.attempts + 1, updated_at: new Date().toISOString() });
          claimed.push(key);
        }
      }
    }
    return claimed;
  }

  private async update(keys: string[], change: (record: ClaimRecord) => ClaimRecord): Promise<void> {
    for (const key of keys) {
      const record = await this.read(key);
      if (record) await this.write(key, { ...change(record), updated_at: new Date().toISOString() });
    }
  }

  markReviewed(keys: string[], reportPath: string): Promise<void> {
    return this.update(keys, (r) => ({ ...r, status: "reviewed", report_path: reportPath, last_error: undefined }));
  }

  markFailed(keys: string[], reason: string): Promise<void> {
    return this.update(keys, (r) => ({ ...r, status: "failed", last_error: reason }));
  }

  async release(keys: string[]): Promise<void> {
    for (const key of keys) {
      const base = this.pathOf(key);
      await rm(base, { force: true });
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) await rm(`${base}.retry${attempt}`, { force: true });
    }
  }
}
