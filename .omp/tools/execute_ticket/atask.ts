import type { Exec } from "./omp.js";
import type { AtaskFilePort, ShownObjective } from "./ticket.js";

/**
 * The slice of the `atask` CLI this tool uses: list the board, file one objective (reusing an open one that carries
 * the group key), and show one objective in full. Always `atask --json ...` with an argument array, so nothing in a
 * title or a check is interpreted by a shell. The board is the one atask resolves from the working directory.
 */

const ATASK_TIMEOUT_MS = 60_000;

interface Envelope {
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface ListedTask {
  readonly id?: string;
  readonly key?: string;
  readonly title?: string;
  readonly status?: string;
}

export interface AtaskPort extends AtaskFilePort {
  show(id: string): Promise<ShownObjective>;
}

async function call(exec: Exec, args: string[], cwd: string | undefined, signal: AbortSignal | undefined, what: string): Promise<Envelope> {
  let result;
  try {
    result = await exec("atask", ["--json", ...args], { cwd, signal, timeout: ATASK_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`atask CLI is not runnable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.killed) {
    signal?.throwIfAborted();
    throw new Error(`atask ${what} was stopped after ${ATASK_TIMEOUT_MS / 1000} s`);
  }
  let envelope: Envelope;
  try {
    envelope = JSON.parse(result.stdout) as Envelope;
  } catch {
    throw new Error(`atask ${what} returned non-JSON output (exit ${result.code}): ${result.stderr.trim()}`);
  }
  if (envelope.ok !== true) {
    throw new Error(`atask ${what} failed (exit ${result.code}): ${envelope.error?.message ?? result.stderr.trim()}`);
  }
  return envelope;
}

/** atask's check grammar needs a preset, so a bare command is given the `run:` one. */
function withRun(check: string): string {
  return /^[a-z_]+:\s/.test(check) ? check : `run: ${check}`;
}

/** The stored key, or the `[key]` marker an older filing left in the title. */
function carriesKey(task: ListedTask, groupKey: string): boolean {
  return task.key === groupKey || (task.title ?? "").includes(`[${groupKey}]`);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function ataskCli(options: { exec: Exec; cwd?: string; signal?: AbortSignal }): AtaskPort {
  const { exec, cwd, signal } = options;
  return {
    async show(id) {
      const result = (await call(exec, ["show", id, "--full"], cwd, signal, "show")).result as
        | { title?: unknown; outcome?: unknown; acceptance?: unknown; constraints?: unknown }
        | undefined;
      if (typeof result?.title !== "string" || typeof result.outcome !== "string") {
        throw new Error(`atask show ${id} returned no title and outcome`);
      }
      const acceptance = Array.isArray(result.acceptance)
        ? result.acceptance.flatMap((line) =>
            typeof line === "object" && line !== null && typeof (line as { description?: unknown }).description === "string"
              ? [(line as { description: string }).description]
              : [],
          )
        : [];
      return { title: result.title, outcome: result.outcome, acceptance, constraints: strings(result.constraints) };
    },

    async fileOrReuse(_project, item) {
      const listed = await call(exec, ["list"], cwd, signal, "list");
      const tasks = (listed.result as { tasks?: readonly ListedTask[] } | undefined)?.tasks ?? [];
      const existing = tasks.find(
        (task) => task.status !== "complete" && task.status !== "archived" && carriesKey(task, item.groupKey),
      );
      if (existing?.id !== undefined) return { id: existing.id, reused: true };
      const envelope = await call(
        exec,
        ["add", item.title, "--key", item.groupKey, "--outcome", item.outcome, "--proof", withRun(item.proof), "--regression", withRun(item.regression)],
        cwd,
        signal,
        "add",
      );
      const added = envelope.result as { id?: string; task?: { id?: string } } | undefined;
      const id = added?.task?.id ?? added?.id;
      if (id === undefined) throw new Error("atask add succeeded but returned no task id");
      return { id, reused: false };
    },
  };
}
