import type { Machine, ProcessResult } from "./machine.ts";

export interface FakeWorld {
  readonly files?: Readonly<Record<string, string>>;
  readonly directories?: readonly string[];
  /** The result for each exact command line (`ssh -G alpine`); an unscripted command exits 127. */
  readonly commands?: Readonly<Record<string, ProcessResult>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly home?: string;
}

export const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });

export interface RecordedRun {
  readonly commandLine: string;
}

/** A scripted machine: answers from `world`, records every process it was asked to run, never reaches a network. */
export class FakeMachine implements Machine {
  readonly runs: RecordedRun[] = [];
  readonly homeDirectory: string;
  private readonly files: Map<string, string>;

  constructor(private readonly world: FakeWorld = {}) {
    this.files = new Map(Object.entries(world.files ?? {}));
    this.homeDirectory = world.home ?? "/home/zach";
  }

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const commandLine = [command, ...args].join(" ");
    this.runs.push({ commandLine });
    return this.world.commands?.[commandLine] ?? { code: 127, stdout: "", stderr: `no fake for ${commandLine}` };
  }

  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async listDirectory(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const paths = [...this.files.keys(), ...(this.world.directories ?? [])];
    return [...new Set(paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0] as string))].sort();
  }

  environment(name: string): string | undefined {
    return this.world.environment?.[name];
  }
}
