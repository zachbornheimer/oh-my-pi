import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type PollOutcome, pollRun, startGroupRun, stopRun } from "./start.js";
import { resolveGroupInput, WORKER_BUDGET_S } from "./types.js";
import { messageOf } from "./util.js";

const HEARTBEAT_MS = 15_000;

const DESCRIPTION =
  "Run one atask group to verified completion in a detached background process, then poll it by run_id. Use after filing a DAG of tasks under a group; one task belongs to start_atask_task. "
  + `Start: \`{"group":"at-abc123","max_workers":4,"onComplete":"merge","add_dirs":[],"worker_timeout_s":${WORKER_BUDGET_S}}\`, only group is required. Poll: \`{"run_id":"gr-..."}\`. Stop: \`{"run_id":"gr-...","stop":true}\`. `
  + "group MUST be a group id whose subtree holds no draft: a task id, an empty group or any draft is refused (each draft named with the proof or regression it lacks). A live run of the same group is returned, never duplicated. "
  + "The runner claims members with `atask claim --group`, runs up to max_workers headless `omp --auto-approve --model @task` workers, each in its task worktree (a live worker of a re-claimed member is adopted), gates each ended worker with `atask verify complete`, renews leases, and runs the group's own proofs. "
  + "Only after atask answers DONE it lands members one at a time in completion order: merge runs `wt merge <target> --no-squash --no-remove`, pr pushes the branch and opens a pull request with `gh`, nil leaves worktrees. A prerequisite outside the group is never claimed and stalls the run. "
  + "Spends model quota, commits, merges, pushes and opens pull requests; state and logs live under ~/.local/state/omp/complete_atask_group. "
  + "NO completion message reaches this session: poll once when you need the answer, never in a loop. "
  + "Start returns status started or running with the run_id; poll returns running, settled (one line per member and its landing), stalled (atask's reasons), failed or lost (runner gone: call again with the group to continue).";

/** The one-line status a user sees on the call. */
function startText(status: "started" | "running", group: string, runId: string, dir: string): string {
  return [
    status === "started"
      ? `run ${runId} started for group ${group}.`
      : `group ${group} already has a live run ${runId}; nothing was started.`,
    `Poll with {"run_id":"${runId}"} when you need the answer; no completion message is delivered to this session.`,
    `Run state: ${dir}`,
  ].join("\n");
}

function pollDetails(action: "poll" | "stop", polled: PollOutcome, stopRequested?: boolean) {
  const { record } = polled;
  return {
    action,
    status: record.state,
    group: record.group,
    run_id: record.run_id,
    run_dir: polled.run_dir,
    pid: record.pid,
    heartbeat_at: record.heartbeat_at,
    ...(stopRequested === undefined ? {} : { stop_requested: stopRequested }),
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    ...(record.result === undefined ? {} : { members: record.result.members }),
    ...(record.result?.status === "stalled" ? { reasons: record.result.reasons } : {}),
    ...(record.result?.status === "failed" ? { error: record.result.error } : {}),
  };
}

const factory: CustomToolFactory = (pi) => ({
  name: "complete_atask_group",
  label: "Complete atask group",
  description: DESCRIPTION,
  parameters: pi.zod.object({
    group: pi.zod.string().min(1).nullable().optional().describe(
      "The atask group id (at-XXXXXX) to run; a group id, never a task id. Starts a run. Omit when polling or stopping.",
    ),
    max_workers: pi.zod.number().int().positive().nullable().optional().describe(
      "Headless omp workers running at once, each in its own task worktree. Default 4. Start only.",
    ),
    onComplete: pi.zod.enum(["merge", "pr", "nil"]).nullable().optional().describe(
      "Landing applied to each member after the whole group verifies: merge (default), pr (push and open a pull request), nil (leave worktrees and branches). Start only.",
    ),
    add_dirs: pi.zod.array(pi.zod.string()).nullable().optional().describe(
      "Extra workspace directories granted to every worker (omp --add-dir). Default none. Start only.",
    ),
    worker_timeout_s: pi.zod.number().int().positive().nullable().optional().describe(
      `Seconds one worker may run before it is killed, plus 60 s grace. Default ${WORKER_BUDGET_S}. A killed worker is gated like any ended one. Start only.`,
    ),
    run_id: pi.zod.string().min(1).nullable().optional().describe(
      "A run id returned by a start (gr-...). Reads that run's state and final report instead of starting. Mutually exclusive with group.",
    ),
    stop: pi.zod.boolean().nullable().optional().describe(
      "With run_id: ask the live runner to stop (workers stopped, held claims released, run recorded as failed). Default false.",
    ),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const runId = params.run_id ?? undefined;
    const group = params.group ?? undefined;
    if ((runId === undefined) === (group === undefined)) {
      throw new Error("pass exactly one of group (start a run) or run_id (poll or stop one)");
    }

    if (runId !== undefined) {
      const startOnly = ["max_workers", "onComplete", "add_dirs", "worker_timeout_s"] as const;
      const stray = startOnly.filter((key) => params[key] !== undefined && params[key] !== null);
      if (stray.length > 0) throw new Error(`${stray.join(", ")} apply only when starting a run with group`);
      if (params.stop === true) {
        const stopped = await stopRun(runId);
        return {
          content: [{ type: "text", text: stopped.text }],
          details: pollDetails("stop", stopped, stopped.stopRequested),
        };
      }
      const polled = await pollRun(runId);
      return { content: [{ type: "text", text: polled.text }], details: pollDetails("poll", polled) };
    }

    if (params.stop === true) throw new Error("stop needs run_id");
    const input = resolveGroupInput({ ...params, group });
    const began = Date.now();
    const beat = setInterval(() => {
      onUpdate?.({
        content: [{ type: "text", text: `checking group ${input.group} (${Math.round((Date.now() - began) / 1000)} s)` }],
        details: { action: "start", status: "checking", group: input.group },
      });
    }, HEARTBEAT_MS);
    try {
      const started = await startGroupRun(input, { cwd: pi.cwd, signal });
      if (started.status === "refused") throw new Error(`complete_atask_group refused ${started.group}: ${started.error}`);
      return {
        content: [{ type: "text", text: startText(started.status, started.group, started.run_id, started.run_dir) }],
        details: { action: "start", status: started.status, group: started.group, run_id: started.run_id, run_dir: started.run_dir },
      };
    } catch (error) {
      throw error instanceof Error ? error : new Error(messageOf(error));
    } finally {
      clearInterval(beat);
    }
  },
});

export default factory;
