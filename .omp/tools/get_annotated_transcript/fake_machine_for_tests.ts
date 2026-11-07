import type { HostMachine } from "./reader/host_machine.js";

/** An in-memory read-only `HostMachine` over a `{absolute path: text}` map; directories are the prefixes of those paths. */
export class FakeMachine implements HostMachine {
  readonly homeDirectory: string;
  private readonly files: Map<string, string>;
  private readonly modified: Readonly<Record<string, number>>;

  constructor(homeDirectory: string, files: Readonly<Record<string, string>> = {}, modified: Readonly<Record<string, number>> = {}) {
    this.homeDirectory = homeDirectory;
    this.files = new Map(Object.entries(files));
    this.modified = modified;
  }

  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async isFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async isDirectory(path: string): Promise<boolean> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.files.keys()].some((candidate) => candidate.startsWith(prefix));
  }

  async listDirectory(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix)).map((candidate) =>
      candidate.slice(prefix.length).split("/")[0] as string
    );
    return [...new Set(names)].sort();
  }

  async modifiedAtMs(path: string): Promise<number | undefined> {
    return this.files.has(path) ? (this.modified[path] ?? 0) : undefined;
  }

  async readLines(path: string): Promise<AsyncIterable<string> | undefined> {
    const text = this.files.get(path);
    if (text === undefined) return undefined;
    const lines = text.split("\n");
    return (async function* () {
      yield* lines;
    })();
  }
}
