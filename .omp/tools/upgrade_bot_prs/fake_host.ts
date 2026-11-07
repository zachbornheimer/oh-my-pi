import type { CommandResult, Launched, UpgradeBotHost } from "./host.js";

export const HOME = "/home/zach";
export const REGISTRY_PATH = `${HOME}/.config/webmaster/registry-upgrade_dependency.json`;
export const LOCK_PATH = `${HOME}/.config/webmaster/registry-upgrade_dependency.lock`;

export type GhResponder = (args: readonly string[]) => CommandResult | undefined;

export interface RecordedLaunch {
  readonly bin: string;
  readonly args: readonly string[];
  readonly logPath: string;
  readonly pid: number;
  /** The virtual clock when it started, in epoch ms. */
  readonly at: number;
  /** How many launched runs were alive just after this one started, itself included. */
  readonly aliveAfter: number;
}

interface Timer {
  readonly at: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

const wait = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets pending promise chains run: a macrotask per turn. */
export async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await wait();
}

/** The pull request URL a recorded launch was for: the one `https://github.com/` URL in its prompt. */
export const urlOf = (launch: RecordedLaunch): string => /https:\/\/github\.com\/\S+?\/pull\/\d+/.exec(launch.args[1]!)![0];

/**
 * A scripted host with a virtual clock. `sleep` waits on it, and `run` moves it: whenever everything is waiting, it
 * jumps to the earliest timer, so hours pass in milliseconds and the order of events is the real one. Files are in
 * memory, `gh` answers from `gh`, and a launched run lives `lifetimeMs` (or `lifetimes[url]`) of virtual time.
 */
export class FakeUpgradeBotHost implements UpgradeBotHost {
  nowMs: number;
  /** Milliseconds the clock moves on every `now()`; zero keeps it still. For proving a rule reads the tick's start. */
  tickPerNow = 0;
  /** How long a launched run stays alive. */
  lifetimeMs = 60 * 60 * 1000;
  /** URL of a pull request -> its run's lifetime, overriding `lifetimeMs`. */
  readonly lifetimes = new Map<string, number>();
  /** URL of a pull request -> the code its run exits with at once. */
  readonly exitsEarly = new Map<string, number>();
  readonly files = new Map<string, string>();
  /** Pids alive whatever the clock says, such as a run an earlier tick recorded. */
  readonly alive = new Set<number>();
  readonly launches: RecordedLaunch[] = [];
  readonly renames: { from: string; to: string }[] = [];
  readonly writtenPaths: string[] = [];
  /** Tools `toolInstalled` reports; `upgrade_dependency` by default. */
  readonly installed = new Set<string>(["upgrade_dependency"]);
  /** The most launched runs alive together. */
  maxAlive = 0;
  /** Every rename onto the registry fails, as a full disk would. */
  failRegistryWrites = false;
  signal?: AbortSignal;
  private nextPid = 1000;
  private readonly diesAt = new Map<number, number>();
  private timers: Timer[] = [];

  constructor(start: Date, private readonly gh: GhResponder = () => undefined) {
    this.nowMs = start.getTime();
  }

  home = () => HOME;

  toolInstalled = (name: string): boolean => this.installed.has(name);

  /** Environment variables `env` reports; none by default. */
  readonly environment = new Map<string, string>();

  env = (name: string): string | undefined => this.environment.get(name);

  async exec(bin: string, args: string[]): Promise<CommandResult> {
    const answer = bin === "gh" ? this.gh(args) : undefined;
    return answer ?? { status: 127, stdout: "", stderr: `no fake for ${bin} ${args.join(" ")}` };
  }

  now = (): Date => {
    const current = new Date(this.nowMs);
    this.nowMs += this.tickPerNow;
    return current;
  };

  sleep(ms: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if (this.signal?.aborted) {
      reject(this.signal.reason);
      return promise;
    }
    const timer: Timer = { at: this.nowMs + ms, resolve, reject };
    this.timers.push(timer);
    this.signal?.addEventListener("abort", () => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
      reject(this.signal!.reason);
    }, { once: true });
    return promise;
  }

  /**
   * Awaits `work` while moving the virtual clock; throws when `work` waits on nothing at all. One macrotask lets every
   * promise chain drain (nothing here does real I/O), then the clock jumps to the earliest timer and wakes all that
   * are due.
   */
  async run<T>(work: Promise<T>): Promise<T> {
    let finished = false;
    const result = work.finally(() => {
      finished = true;
    });
    result.catch(() => undefined);
    while (!finished) {
      await settle(1);
      if (finished) break;
      if (this.timers.length === 0) {
        await settle(2);
        if (!finished) throw new Error("the tick is stuck: nothing waits on the clock and it has not finished");
        break;
      }
      this.nowMs = Math.max(this.nowMs, Math.min(...this.timers.map((timer) => timer.at)));
      const due = this.timers.filter((timer) => timer.at <= this.nowMs);
      this.timers = this.timers.filter((timer) => timer.at > this.nowMs);
      for (const timer of due) timer.resolve();
    }
    return result;
  }

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeText(path: string, body: string): Promise<void> {
    this.writtenPaths.push(path);
    this.files.set(path, body);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failRegistryWrites && to === REGISTRY_PATH) throw new Error(`rename ${from} to ${to}: ENOSPC`);
    const body = this.files.get(from);
    if (body === undefined) throw new Error(`rename ${from}: no such file`);
    this.files.delete(from);
    this.files.set(to, body);
    this.renames.push({ from, to });
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async createExclusive(path: string, body: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, body);
    return true;
  }

  isAlive = (pid: number): boolean => this.alive.has(pid) || (this.diesAt.get(pid) ?? -1) > this.nowMs;

  launch(bin: string, args: readonly string[], logPath: string): Launched {
    const pid = this.nextPid++;
    const url = /https:\/\/github\.com\/\S+?\/pull\/\d+/.exec(args[1]!)![0];
    const code = this.exitsEarly.get(url);
    const at = this.nowMs;
    if (code === undefined) this.diesAt.set(pid, at + (this.lifetimes.get(url) ?? this.lifetimeMs));
    const aliveAfter = [...this.diesAt.keys()].filter((candidate) => this.isAlive(candidate)).length;
    this.maxAlive = Math.max(this.maxAlive, aliveAfter);
    this.launches.push({ bin, args, logPath, pid, at, aliveAfter });
    return { pid, exit: code === undefined ? new Promise<number>(() => {}) : Promise.resolve(code) };
  }

  registry(): { lastTrys: Record<string, unknown>; holds: Record<string, unknown> } | undefined {
    const text = this.files.get(REGISTRY_PATH);
    return text === undefined ? undefined : JSON.parse(text);
  }
}
