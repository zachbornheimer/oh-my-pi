/**
 * The per-step checkpoint of one ticket's run. omp has no workflow suspend and resume, so each finished step writes the
 * state it ended with to `<dir>/<TICKET>.json`; a rerun of a ticket whose last run did not finish reads that file and
 * skips every step it lists. The file is rewritten atomically (a temp file, then a rename), so a crash mid-write leaves
 * the previous checkpoint whole.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { arr, bool, int, obj, safeParse, str } from "./shape.js";
import { stateShape, type State } from "./schemas.js";

export interface Checkpoint {
  readonly version: 1;
  readonly ticket: string;
  /** The run that wrote it. */
  readonly runId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** The ids of the steps that finished, in order. */
  readonly steps: readonly string[];
  /** The state after the last finished step. */
  readonly state: State;
  /** True once the run ended (settled, or ended early with an outcome): a finished checkpoint is never resumed. */
  readonly finished: boolean;
}

export interface Checkpoints {
  load(ticket: string): Promise<Checkpoint | undefined>;
  save(checkpoint: Checkpoint): Promise<void>;
  /** Removes a checkpoint that can no longer be resumed. */
  discard(ticket: string): Promise<void>;
  /** Every readable checkpoint, whatever its state: the sweep picks the unfinished, fresh ones to resume. */
  list(): Promise<Checkpoint[]>;
}

const checkpointShape = obj({
  version: int({ min: 1, max: 1 }),
  ticket: str(),
  runId: str(),
  startedAt: int(),
  updatedAt: int(),
  steps: arr(str()),
  state: stateShape,
  finished: bool(),
});

/** Checkpoint files in `dir`, one per ticket. */
export function fileCheckpoints(dir: string): Checkpoints {
  const pathOf = (ticket: string) => join(dir, `${ticket}.json`);
  return {
    async load(ticket) {
      let raw: string;
      try {
        raw = await readFile(pathOf(ticket), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        // A checkpoint nobody can read is no checkpoint: the run starts over and overwrites it.
        return undefined;
      }
      const parsed = safeParse(checkpointShape, value);
      if (!parsed.ok || parsed.value.ticket !== ticket) return undefined;
      return { ...parsed.value, version: 1 };
    },
    async save(checkpoint) {
      const path = pathOf(checkpoint.ticket);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
      await rename(temporary, path);
    },
    async discard(ticket) {
      await rm(pathOf(ticket), { force: true });
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const loaded = await Promise.all(
        names.filter((name) => name.endsWith(".json")).map((name) => this.load(name.slice(0, -".json".length))),
      );
      return loaded.filter((checkpoint): checkpoint is Checkpoint => checkpoint !== undefined);
    },
  };
}
