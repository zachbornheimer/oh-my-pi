import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { SiteLock, SiteLockPort } from "./types";

/** Files that may be created only once; the primitive a cross-process lock needs. */
export interface ExclusiveFiles {
  /** Creates the file with this content; false when it already exists. */
  create(path: string, content: string): Promise<boolean>;
  /** The file's content; undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Removes the file; a file already gone is not an error. */
  remove(path: string): Promise<void>;
}

/** This process's identity and whether another process is still running. */
export interface ProcessPort {
  readonly pid: number;
  isAlive(pid: number): boolean;
}

const codeOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** Exclusive create is `open(path, "wx")`: it fails with EEXIST when the file exists, across processes. */
export const localExclusive: ExclusiveFiles = {
  async create(path, content) {
    await mkdir(dirname(path), { recursive: true });
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw error;
    }
  },
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
  },
  async remove(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
  },
};

export function memoryExclusive(): ExclusiveFiles {
  const held = new Map<string, string>();
  return {
    create: (path, content) => {
      if (held.has(path)) return Promise.resolve(false);
      held.set(path, content);
      return Promise.resolve(true);
    },
    read: (path) => Promise.resolve(held.get(path)),
    remove: (path) => (held.delete(path), Promise.resolve()),
  };
}

/** `process.kill(pid, 0)` checks existence only; EPERM means it exists under another user, only ESRCH means gone. */
export const localProcess: ProcessPort = {
  pid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return codeOf(error) !== "ESRCH";
    }
  },
};

const PID_LINE = /^pid=(\d+)$/m;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The pid a lock file records; undefined for a lock written without one. */
export function lockHolderPid(content: string): number | undefined {
  const match = PID_LINE.exec(content);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Lock file `<dir>/<name>-<site>.lock`, created exclusively so two runs (even in two processes) cannot both win.
 * With a `ProcessPort` the file records the holder's pid, and a lock whose pid is no longer running (a killed run)
 * is reclaimed. A live pid, or a lock with no readable pid, refuses and names the file so a person can remove it.
 * A site name that is not a plain file-name segment is refused with an error (it would name a path outside `dir`).
 */
export function fileSiteLock(
  files: ExclusiveFiles,
  dir: string,
  holder: string,
  name = "fix",
  processes?: ProcessPort,
): SiteLockPort {
  const content = processes === undefined ? `${holder}\n` : `${holder}\npid=${processes.pid}\n`;

  /** True when the lock at `path` was left by a process that is gone and has been removed. */
  async function reclaimed(path: string): Promise<boolean> {
    if (processes === undefined) return false;
    const seen = await files.read(path);
    const pid = seen === undefined ? undefined : lockHolderPid(seen);
    if (seen === undefined || pid === undefined || processes.isAlive(pid)) return false;
    // Re-read so a lock another run just took over is not removed from under it.
    if ((await files.read(path)) !== seen) return false;
    await files.remove(path);
    return true;
  }

  return {
    async acquire(site): Promise<SiteLock> {
      if (!SAFE_NAME.test(site)) throw new Error(`lock refused: ${JSON.stringify(site)} is not a plain site name`);
      const path = `${dir}/${name}-${site}.lock`;
      const created = (await files.create(path, content)) || ((await reclaimed(path)) && (await files.create(path, content)));
      if (!created) return { held: true, holder: path };
      return { held: false, release: () => files.remove(path) };
    },
  };
}
