import { invocationOf, kindOf, ROOT_KINDS } from "./process_command.ts";
import type { ProcessKind, ProcessSample } from "./types.ts";

const INIT_PID = 1;

/** The processes of one snapshot as a tree: who started whom, what kind each is, and which one roots its family. */
export class ProcessTree {
  private readonly byPid = new Map<number, ProcessSample>();
  private readonly kinds = new Map<number, ProcessKind>();

  constructor(readonly processes: readonly ProcessSample[]) {
    for (const process of processes) {
      this.byPid.set(process.pid, process);
      this.kinds.set(process.pid, kindOf(process.command));
    }
  }

  kind(pid: number): ProcessKind {
    return this.kinds.get(pid) ?? "other";
  }

  baseName(process: ProcessSample): string {
    return invocationOf(process.command).base;
  }

  /** The processes above `process`, nearest first, up to init or the first parent `ps` did not list. */
  ancestors(process: ProcessSample): ProcessSample[] {
    const seen = new Set<number>([process.pid]);
    const above: ProcessSample[] = [];
    let parent = this.byPid.get(process.ppid);
    while (parent !== undefined && !seen.has(parent.pid)) {
      seen.add(parent.pid);
      above.push(parent);
      parent = parent.pid === INIT_PID ? undefined : this.byPid.get(parent.ppid);
    }
    return above;
  }

  /**
   * The process whose family `process` belongs to: the nearest of a root kind (itself included), climbed to the top
   * of the run of parents that share its kind (a `docker` under a `docker` under `docker-mcp` is one family).
   * A process with no root-kind ancestor roots its own family.
   */
  root(process: ProcessSample): ProcessSample {
    const start = [process, ...this.ancestors(process)].find((candidate) =>
      ROOT_KINDS.includes(this.kind(candidate.pid))
    );
    if (start === undefined) return process;
    const kind = this.kind(start.pid);
    let top = start;
    for (const above of this.ancestors(start)) {
      if (this.kind(above.pid) !== kind) break;
      top = above;
    }
    return top;
  }
}
