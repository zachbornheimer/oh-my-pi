import type { CustomTool, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type FleetOutput, type FleetPorts, runFleet } from "./fleet.js";
import { MAX_CONCURRENCY, NAME_PATTERN, normalizeInput, type RawInput, SESSION_PATTERN } from "./input.js";
import { renderOutput } from "./render.js";

export const NAME = "task_fleet";

export const DESCRIPTION =
  "Start detached `omp -p` workers from `tasks[]`, message them while they run, list their state, or kill them. "
  + "Unlike omp's built-in `task` (in-session subagents whose results come back to this conversation), these are separate OS processes: spawn returns child ids at once, children keep running after this session ends, and nothing is returned to the parent; read each child's `output_path`. Prefer `task` for ordinary delegation; use task_fleet for long-running, killable workers that message each other. "
  + "Spawn: `{\"context\":\"# Goal\\n...\",\"tasks\":[{\"name\":\"ReadPaths\",\"task\":\"# Target\\n...\",\"model\":\"opus\",\"tools\":[\"read\",\"grep\"]}],\"max_concurrency\":4,\"cwd\":\"/abs/dir\"}`. "
  + "`context` and `tasks` are REQUIRED (children start blank); names are CamelCase, at most 32, unique per spawn. `tools` goes to `omp --tools`; `agent` and `solutionSpace` are only text in the child's prompt. "
  + "At most `max_concurrency` (default and maximum 32) run at once; the rest queue. `worker_cmd` replaces `omp -p`: `sh` runs it with the prompt on stdin. "
  + "Other ops: `{\"op\":\"list\"}`; `{\"op\":\"send\",\"to\":\"ReadPaths\",\"content\":\"...\"}` appends to a queued or running child's inbox file (`to` is a name, an id, or `all`); `{\"op\":\"kill\",\"to\":\"all\"}` sends SIGTERM and a queued child never starts. "
  + "`session` defaults to this omp process; pass it to reach a fleet from another process. "
  + "Each child is a full model session in `cwd` with your omp config (spends quota, can edit files, no worktree isolation). "
  + "Returns per child state queued|running|exited (with exit_code)|killed, inbox count and output_path. State is read from files under `$TMPDIR/omp-task-fleet`, so a child lost to a reboot may still read as running.";

/** Builds the tool; `ports` supplies the host (tests pass fakes). */
export function createTool(
  pi: { zod: any; cwd: string },
  ports: (cwd: string) => FleetPorts,
): CustomTool {
  const z = pi.zod;
  const nullableString = (describe: string) => z.string().min(1).nullable().optional().describe(describe);
  const task = z.object({
    name: z.string().regex(NAME_PATTERN, "CamelCase (letters and digits, leading capital), at most 32 characters").describe(
      "CamelCase, at most 32 characters, unique in the spawn; the child's address for messages.",
    ),
    task: z.string().min(1).describe("Self-contained assignment: # Target, # Change, # Acceptance."),
    agent: nullableString("Role label written into the child's prompt (task, scout, reviewer, ...); no effect on its tools. Default `task`."),
    model: nullableString("Model for this child, passed to `omp --model` (fuzzy, e.g. `opus`). Omit for omp's default."),
    tools: z.array(z.string().min(1)).nullable().optional().describe(
      "This child's `omp --tools` allowlist (omp tool names such as `read`, `grep`, `edit`). Omit for all tools.",
    ),
    solutionSpace: nullableString("How open-ended the child's problem is; written into its prompt."),
  });
  return {
    name: NAME,
    label: "Task fleet",
    description: DESCRIPTION,
    loadMode: "discoverable",
    parameters: z.object({
      op: z.enum(["spawn", "list", "send", "kill"]).nullable().optional().describe(
        "`spawn` (default) starts children; `list` shows them; `send` messages live children; `kill` stops them.",
      ),
      session: z.string().regex(SESSION_PATTERN, "letters, digits, '.', '_', '-'").nullable().optional().describe(
        "Fleet the call addresses. Default: this omp process. Pass it to reach a fleet spawned from another process.",
      ),
      context: nullableString("spawn: shared preamble (# Goal, # Contract) every child receives. REQUIRED for spawn."),
      tasks: z.array(task).nullable().optional().describe("spawn: the children to start, at least one. REQUIRED for spawn."),
      max_concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).nullable().optional().describe(
        `spawn: children of this spawn running at once, 1-${MAX_CONCURRENCY}. Default ${MAX_CONCURRENCY}; the rest queue.`,
      ),
      cwd: nullableString("spawn: working directory for the children; relative paths resolve against the session cwd. Default the session cwd."),
      worker_cmd: nullableString("spawn: shell command run by `sh` for every child instead of `omp -p`; the prompt arrives on stdin."),
      to: nullableString("send/kill: a child name, a child id, or `all` (every live child). REQUIRED for send and kill."),
      from: nullableString("send: sender named in the message header. Default `parent`."),
      content: nullableString("send: the message. REQUIRED for send."),
    }),

    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const request = normalizeInput(params as RawInput);
      const output: FleetOutput = await runFleet(ports(pi.cwd), request);
      return { content: [{ type: "text", text: renderOutput(output) }], details: output };
    },
  };
}
