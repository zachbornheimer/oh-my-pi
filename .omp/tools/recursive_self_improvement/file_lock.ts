import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A lock older than this is reclaimed even if its process still lives. */
export const LOCK_MAX_AGE_MS = 12 * 3_600_000;

interface Holder {
  runId: string;
  ticket: string;
  pid: number;
  acquiredAt: number;
}

export interface Lock {
  acquire(input: { runId: string; ticket: string }): Promise<{ held: boolean; holder?: { runId: string; ticket: string } }>;
  release(runId: string): Promise<void>;
}

export interface FileLockOptions {
  now?: () => number;
  /** Whether a process is still running; `process.kill(pid, 0)` by default. */
  isAlive?: (pid: number) => boolean;
  maxAgeMs?: number;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readHolder(path: string): Promise<Holder | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<Holder>;
    if (typeof parsed.runId === "string" && typeof parsed.pid === "number" && typeof parsed.acquiredAt === "number") {
      return { runId: parsed.runId, ticket: String(parsed.ticket ?? ""), pid: parsed.pid, acquiredAt: parsed.acquiredAt };
    }
  } catch {
    // An unreadable lock file is a lock nobody can own: it is reclaimed like a dead holder's.
  }
  return { runId: "", ticket: "", pid: 0, acquiredAt: 0 };
}

/**
 * A machine-wide lock: a file created exclusively (`wx`) holding the run, ticket and pid. A lock whose process is gone, or older
 * than `maxAgeMs`, is reclaimed. `release` removes the file only when it is this run's.
 */
export function fileLock(path: string, options: FileLockOptions = {}): Lock {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processIsAlive;
  const maxAgeMs = options.maxAgeMs ?? LOCK_MAX_AGE_MS;

  async function create(input: { runId: string; ticket: string }): Promise<boolean> {
    const holder: Holder = { runId: input.runId, ticket: input.ticket, pid: process.pid, acquiredAt: now() };
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, JSON.stringify(holder), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  return {
    async acquire(input) {
      if (await create(input)) return { held: true };
      const holder = await readHolder(path);
      if (holder !== undefined && holder.pid > 0 && isAlive(holder.pid) && now() - holder.acquiredAt < maxAgeMs) {
        return { held: false, holder: { runId: holder.runId, ticket: holder.ticket } };
      }
      // Reclaim only the very lock judged stale: another reclaimer may have replaced it since it was read.
      if ((await readHolder(path))?.runId !== holder?.runId) return { held: false };
      await rm(path, { force: true });
      return { held: await create(input) };
    },
    async release(runId) {
      const holder = await readHolder(path);
      if (holder?.runId === runId) await rm(path, { force: true });
    },
  };
}
