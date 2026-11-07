import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { Clock } from "./clock.js";
import { type StartTaskDependencies, startAtaskTask } from "./lifecycle.js";
import {
  DEFAULT_TIMEOUT_S,
  normalizeInput,
  ON_COMPLETE_VALUES,
  type RawStartAtaskTaskParams,
  type StartAtaskTaskOutput,
  WORKER_BUDGET_S,
} from "./schemas.js";

/** How often a long wait tells the caller it is still working. */
export const HEARTBEAT_MS = 15_000;

export const DESCRIPTION = "Start one atask objective in its own worktree with a headless `omp` worker, and land the result only after `atask verify complete` passes. "
  + "Use it to hand a ready atask task to an autonomous worker; use `atask` directly to plan or inspect tasks, and `complete_atask_group` for a whole group. "
  + "Input: `{\"id\":\"at-kbjk23\"}`. Omit `id` and `atask claim` assigns the oldest eligible task (`project` scopes that; ignored with `id`). "
  + "`onComplete`: `merge` (default) runs `wt merge <target> --no-squash --no-remove` from the worktree, `pr-auto` pushes the branch and opens a pull request against the target with auto-merge armed, `pr` opens one without, `nil` leaves worktree and branch. "
  + "`add_dirs` grants the worker extra directories (`~` expands); `prompt` replaces the worker prompt. "
  + `\`timeout_s\` (default ${DEFAULT_TIMEOUT_S}) is only how long this call waits; \`worker_timeout_s\` (default ${WORKER_BUDGET_S} plus 60 s) is the worker's kill budget, ignored when attaching. `
  + "Effects: claims the task (atask creates the `atask/<id>` worktree), spawns `omp --auto-approve --model @task -p` in a herdr pane or detached process, runs `atask verify complete`, then pushes, merges or opens pull requests per `onComplete`; spends model quota. "
  + "Returns `status`: `settled` (atask's verdict and the landing outcome `merged`, `pull_request`, `left` or `failed`), `failed` (verification message and worker output tail; nothing lands), `running` (wait elapsed; call again with the same `id` to attach, never a second worker), `refused` (draft, unstartable status, claim rejected). "
  + "Aborting the call stops the wait, not the worker. Sends progress every 15 s.";

/** The ports one call runs against; `forCall` builds them for that call's abort signal. */
export interface CallPorts extends Omit<StartTaskDependencies, "signal" | "report"> {
  readonly clock?: Clock;
}

export interface ToolOptions {
  /** Builds the ports for one call; the live wiring in `index.ts`, fakes in tests. */
  readonly forCall: (signal: AbortSignal | undefined) => CallPorts;
  readonly heartbeatMs?: number;
}

/** The answer as text: the status line, then every field the model needs to act on. */
export function answerText(output: StartAtaskTaskOutput): string {
  const lines = [`start_atask_task: ${output.status} — ${output.task_id}`];
  if (output.summary !== undefined) lines.push(output.summary);
  if (output.workspace !== undefined) lines.push(`workspace: ${output.workspace}`);
  if (output.branch !== undefined) lines.push(`branch: ${output.branch}`);
  if (output.job_id !== undefined) lines.push(`job: ${output.job_id}`);
  if (output.verdict !== undefined) lines.push(`verdict: ${output.verdict}`);
  const completion = output.completion;
  if (completion !== undefined) {
    lines.push(`landing (${completion.on_complete}): ${completion.outcome}${completion.url === undefined ? "" : ` ${completion.url}`}`);
    if (completion.error !== undefined) lines.push(`landing error: ${completion.error}`);
    if (completion.conflict !== undefined) {
      lines.push(`conflict onto ${completion.conflict.onto}: ${completion.conflict.files.join(", ") || "no files reported"}`);
    }
  }
  if (output.error !== undefined) lines.push(`error: ${output.error}`);
  if (output.status === "running") {
    lines.push(`The worker is still running; call start_atask_task again with id ${output.task_id} to keep waiting.`);
  }
  return lines.join("\n");
}

export function createTool(pi: Parameters<CustomToolFactory>[0], options: ToolOptions): ReturnType<CustomToolFactory> {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const z = pi.zod;
  return {
    name: "start_atask_task",
    label: "Start atask task",
    description: DESCRIPTION,
    loadMode: "discoverable",
    parameters: z.object({
      id: z.string().nullable().optional().describe(
        "atask objective id, e.g. `at-kbjk23`. Omit it to let `atask claim` assign the oldest eligible task; do not list tasks and pick one.",
      ),
      project: z.string().nullable().optional().describe(
        "Project id or name that scopes the assignment when `id` is omitted. Ignored when `id` is set.",
      ),
      onComplete: z.enum(ON_COMPLETE_VALUES).nullable().optional().describe(
        "Landing applied after verification passes: `merge` (default), `pr-auto`, `pr`, or `nil` (leave worktree and branch).",
      ),
      add_dirs: z.array(z.string()).nullable().optional().describe(
        "Extra workspace directories the worker may use, passed as `--add-dir`; `~` expands. Default none.",
      ),
      prompt: z.string().nullable().optional().describe(
        "Replaces the worker prompt. Default: work the claim, commit with `wt step commit`, finish only after `atask verify complete` passes.",
      ),
      timeout_s: z.number().int().positive().nullable().optional().describe(
        `Seconds this call waits before answering \`running\`; does not shorten the worker. Default ${DEFAULT_TIMEOUT_S}.`,
      ),
      worker_timeout_s: z.number().int().positive().nullable().optional().describe(
        `Seconds a newly spawned worker may run before it is killed, plus 60 s grace. Default ${WORKER_BUDGET_S}. Ignored when attaching.`,
      ),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const input = normalizeInput(params as RawStartAtaskTaskParams);
      const began = Date.now();
      let latest = input.id === undefined ? "claiming the oldest eligible task" : `starting ${input.id}`;
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `start_atask_task: ${latest} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase: latest },
        });
      }, heartbeatMs);
      try {
        const output = await startAtaskTask(input, {
          ...options.forCall(signal),
          signal,
          report: (message) => {
            latest = message;
          },
        });
        signal?.throwIfAborted();
        return {
          content: [{ type: "text", text: answerText(output) }],
          details: { ...output, seconds: Math.round((Date.now() - began) / 1000) },
        };
      } finally {
        clearInterval(beat);
      }
    },
  };
}
