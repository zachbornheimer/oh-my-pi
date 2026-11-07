import type { FleetTask } from "./compose.js";

/** Ceiling on concurrent children of one spawn; excess children queue. */
export const MAX_CONCURRENCY = 32;
/** CamelCase, at most 32 characters. Names are the addresses messages use. */
export const NAME_PATTERN = /^[A-Z][A-Za-z0-9]{0,31}$/;
/** A session names a directory, so it is restricted to path-safe characters. */
export const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type FleetOp = "spawn" | "list" | "send" | "kill";

/** The parameters as a model may send them: every optional field may be absent or null. */
export interface RawTask {
  name: string;
  task: string;
  agent?: string | null;
  model?: string | null;
  tools?: string[] | null;
  solutionSpace?: string | null;
}

export interface RawInput {
  op?: FleetOp | null;
  session?: string | null;
  context?: string | null;
  tasks?: RawTask[] | null;
  max_concurrency?: number | null;
  cwd?: string | null;
  worker_cmd?: string | null;
  to?: string | null;
  from?: string | null;
  content?: string | null;
}

export type FleetRequest =
  | {
    readonly op: "spawn";
    readonly session?: string;
    readonly context: string;
    readonly tasks: readonly FleetTask[];
    readonly maxConcurrency: number;
    readonly cwd?: string;
    readonly workerCmd?: string;
  }
  | { readonly op: "list"; readonly session?: string }
  | { readonly op: "send"; readonly session?: string; readonly to: string; readonly content: string; readonly from: string }
  | { readonly op: "kill"; readonly session?: string; readonly to: string };

function present(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim() === "" ? undefined : value;
}

function need(value: string | null | undefined, field: string, why: string): string {
  const text = present(value);
  if (text === undefined) throw new Error(`${field} is required: ${why}`);
  return text;
}

/** Validates the per-op requirements and applies defaults; throws a message naming the field on a refusal. */
export function normalizeInput(raw: RawInput): FleetRequest {
  const op = raw.op ?? "spawn";
  const session = present(raw.session);
  if (session !== undefined && !SESSION_PATTERN.test(session)) {
    throw new Error("session must be path-safe: letters, digits, '.', '_', '-', starting with a letter or digit");
  }
  switch (op) {
    case "list":
      return { op, session };
    case "send":
      return {
        op,
        session,
        to: need(raw.to, "to", "name the child, its id, or all"),
        content: need(raw.content, "content", "the message"),
        from: present(raw.from) ?? "parent",
      };
    case "kill":
      return { op, session, to: need(raw.to, "to", "name the child, its id, or all") };
    case "spawn": {
      const context = need(raw.context, "context", "children start blank, so the shared preamble is required");
      if (!raw.tasks?.length) throw new Error("tasks is required for spawn: at least one child");
      const seen = new Set<string>();
      const tasks: FleetTask[] = raw.tasks.map((task, index) => {
        if (!NAME_PATTERN.test(task.name)) {
          throw new Error(
            `tasks[${index}].name "${task.name}" must be CamelCase (letters and digits, leading capital), at most 32 characters`,
          );
        }
        if (seen.has(task.name)) {
          throw new Error(`name ${task.name} is used twice; names are addresses and must be unique in a spawn`);
        }
        seen.add(task.name);
        const text = need(task.task, `tasks[${index}].task`, "a self-contained assignment");
        return {
          name: task.name,
          task: text,
          agent: present(task.agent),
          model: present(task.model),
          tools: task.tools?.length ? task.tools : undefined,
          solutionSpace: present(task.solutionSpace),
        };
      });
      const maxConcurrency = raw.max_concurrency ?? MAX_CONCURRENCY;
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
        throw new Error(`max_concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
      }
      return {
        op,
        session,
        context,
        tasks,
        maxConcurrency,
        cwd: present(raw.cwd),
        workerCmd: present(raw.worker_cmd),
      };
    }
  }
}
