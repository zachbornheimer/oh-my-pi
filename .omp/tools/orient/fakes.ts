import type { EmbeddingIndex } from "./embeddings.js";
import type { HostMachine } from "./gather.js";
import type { Exec, ExecResult, ModelStep } from "./omp_model.js";

/** Fakes for orient's tests: a scripted machine, an embedding index with no network, and a model that answers by rule. */

export const ok = (stdout: string): { code: number; stdout: string } => ({ code: 0, stdout });

export interface FakeWorld {
  /** Command line (`git -C /repo ls-files`) to its result. An unlisted command fails with exit 127. */
  readonly commands?: Readonly<Record<string, { code: number; stdout: string }>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly directories?: readonly string[];
  readonly workingDirectory?: string;
}

/** A scripted machine: answers from `world` and records every command it was asked to run. */
export class FakeMachine implements HostMachine {
  readonly runs: string[] = [];
  readonly workingDirectory: string;
  private readonly files: Map<string, string>;

  constructor(private readonly world: FakeWorld = {}) {
    this.files = new Map(Object.entries(world.files ?? {}));
    this.workingDirectory = world.workingDirectory ?? "/work";
  }

  async run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
    const line = [command, ...args].join(" ");
    this.runs.push(line);
    return this.world.commands?.[line] ?? { code: 127, stdout: "" };
  }

  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async isFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async isDirectory(path: string): Promise<boolean> {
    return (await this.listDirectory(path)).length > 0 || (this.world.directories?.includes(path) ?? false);
  }

  async listDirectory(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const paths = [...this.files.keys(), ...(this.world.directories ?? [])];
    return [...new Set(paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0] as string))]
      .filter((name) => name !== "")
      .sort();
  }
}

/**
 * An embedding index with no network: `vectorOf` decides each text's vector, so a test states what "means the same" by
 * construction. `failure` makes every call throw it, as an unreachable provider would.
 */
export function embeddingIndexOf(vectorOf: (text: string) => number[], failure?: string): EmbeddingIndex {
  const embed = (text: string): Float32Array => {
    if (failure !== undefined) throw new Error(failure);
    return Float32Array.from(vectorOf(text));
  };
  return {
    embedQuery: async (text) => embed(text),
    embedDocuments: async (texts) => ({ vectors: texts.map(embed), embedded: texts.length, notes: [] }),
  };
}

export interface ParsedAsk {
  readonly field: string;
  readonly instructions: string;
  readonly body: string;
}

/** The asks a `decide.ts` prompt carries: one `## field` block with its instructions and its BEGIN/END DATA body. */
export function asksOf(prompt: string): ParsedAsk[] {
  return [...prompt.matchAll(/^## (\S+)\n([\s\S]*?)\nBEGIN DATA\n([\s\S]*?)\nEND DATA/gm)].map((match) => ({
    field: match[1]!,
    instructions: match[2]!,
    body: match[3]!,
  }));
}

/** A model that answers every ask in a prompt with `probability(ask)`; records each prompt it was sent. */
export function fakeModel(probability: (ask: ParsedAsk) => number | string | undefined) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    const reply: Record<string, unknown> = {};
    for (const ask of asksOf(prompt)) {
      const value = probability(ask);
      if (value !== undefined) reply[ask.field] = value;
    }
    return JSON.stringify(reply);
  };
  return { step, prompts };
}

/**
 * A `pi.exec` for the whole tool: `git` answers from `commands`, and `omp -p @file` reads the prompt file and answers
 * through `model`. Nothing else may run.
 */
export function fakeExec(
  commands: Readonly<Record<string, { code: number; stdout: string }>>,
  model: { step: ModelStep },
): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (command, args): Promise<ExecResult> => {
    calls.push([command, ...args].join(" "));
    if (command === "omp") {
      const file = args[1]!.slice(1);
      const reply = await model.step(await Bun.file(file).text());
      return { stdout: reply, stderr: "", code: 0, killed: false };
    }
    const line = [command, ...args].join(" ");
    const result = commands[line] ?? { code: 127, stdout: "" };
    return { stdout: result.stdout, stderr: "", code: result.code, killed: false };
  };
  return { exec, calls };
}

/** A chainable stand-in for `pi.zod`: every method returns the same schema, so a factory can build its parameters. */
export function fakeZod(): unknown {
  const schema: unknown = new Proxy(() => schema, { get: () => () => schema, apply: () => schema });
  return new Proxy({}, { get: () => () => schema });
}
