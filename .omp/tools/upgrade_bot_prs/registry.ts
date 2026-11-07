import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LOCK_FILE, REGISTRY_FILE, WEBMASTER_DIR } from "./constants.js";
import type { UpgradeBotHost } from "./host.js";
import { type Owner, parseOwner, parseRegistry, type Registry } from "./schemas.js";

const emptyRegistry = (): Registry => ({ lastTrys: {}, holds: {} });

export const registryPath = (host: UpgradeBotHost): string => join(host.home(), WEBMASTER_DIR, REGISTRY_FILE);
export const lockPath = (host: UpgradeBotHost): string => join(host.home(), WEBMASTER_DIR, LOCK_FILE);

/**
 * The registry file. Every change is a read, an edit and an atomic write (a temp file, then a rename), one at a time
 * in this process, so repositories working at once never lose each other's entries. The lock file keeps other
 * processes out for the length of a tick.
 */
export class RegistryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: UpgradeBotHost) {}

  async read(): Promise<Registry> {
    const path = registryPath(this.host);
    const text = await this.host.readText(path);
    if (text === undefined) return emptyRegistry();
    try {
      return parseRegistry(safeJson(text));
    } catch (error) {
      throw new Error(`${path} is not a valid registry: ${(error as Error).message}`);
    }
  }

  /** Applies `edit` to the registry as it is now and writes the result. */
  update(edit: (registry: Registry) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const registry = await this.read();
      edit(registry);
      const path = registryPath(this.host);
      const temp = `${path}.${process.pid}.tmp`;
      await this.host.writeText(temp, `${JSON.stringify(parseRegistry(registry), null, 2)}\n`);
      await this.host.rename(temp, path);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The lock taken, with its release; or refused, with why. */
export type LockOutcome = { release: () => Promise<void> } | { refused: string };

/** A file's owner, or why it cannot be trusted. Missing is `undefined`. */
async function ownerOf(host: UpgradeBotHost, path: string): Promise<Owner | string | undefined> {
  const text = await host.readText(path);
  if (text === undefined) return undefined;
  return parseOwner(safeJson(text)) ?? `${path} is malformed; remove it by hand once no tick is running`;
}

/** Removes `path` only while `owner` still owns it. */
async function releaseOwned(host: UpgradeBotHost, path: string, owner: Owner): Promise<void> {
  const current = await ownerOf(host, path);
  if (typeof current === "object" && current.token === owner.token) await host.remove(path);
}

/**
 * Takes the process-wide tick lock: `{ pid, startedAt, token }` created atomically, full content or nothing. One tick
 * at a time: while the owner's pid is alive the lock refuses, however old it is. A malformed lock refuses too (fail
 * closed). Only a dead owner's lock is recovered, and only under the reclaim guard, a second atomic file: the one
 * reclaimer holding it re-reads the lock, removes it only if it is still that dead owner's, and creates its own, so
 * two reclaimers can never remove each other's live lock. The release removes the lock only while it is still ours.
 */
export async function takeLock(host: UpgradeBotHost, tickStart: Date): Promise<LockOutcome> {
  const path = lockPath(host);
  const mine: Owner = { pid: process.pid, startedAt: tickStart.toISOString(), token: randomUUID() };
  const taken: LockOutcome = { release: () => releaseOwned(host, path, mine) };
  if (await host.createExclusive(path, JSON.stringify(mine))) return taken;
  const holder = await ownerOf(host, path);
  if (typeof holder === "string") return { refused: holder };
  if (holder !== undefined && host.isAlive(holder.pid)) return { refused: heldBy(holder) };

  const guard = `${path}.reclaim`;
  if (!(await host.createExclusive(guard, JSON.stringify(mine)))) {
    const reclaimer = await ownerOf(host, guard);
    if (typeof reclaimer === "object" && host.isAlive(reclaimer.pid)) {
      return { refused: `another tick (pid ${reclaimer.pid}) is recovering the lock` };
    }
    return {
      refused: `${guard} was left by a recovery that did not finish; remove it by hand once no tick is running`,
    };
  }
  try {
    const still = await ownerOf(host, path);
    if (typeof still === "string") return { refused: still };
    if (still !== undefined) {
      if (holder === undefined || still.token !== holder.token || host.isAlive(still.pid)) {
        return { refused: heldBy(still) };
      }
      await host.remove(path);
    }
    if (await host.createExclusive(path, JSON.stringify(mine))) return taken;
    return { refused: "another tick took the lock first" };
  } finally {
    await releaseOwned(host, guard, mine);
  }
}

const heldBy = (owner: Owner): string =>
  `another tick (pid ${owner.pid}, started ${owner.startedAt}) holds the lock and is still running`;
