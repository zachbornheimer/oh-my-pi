/** A child's assignment as the caller gave it. */
export interface FleetTask {
  readonly name: string;
  readonly task: string;
  readonly agent?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly solutionSpace?: string;
}

/** The worker a child runs when the call names none; the child prompt arrives on stdin, as `omp -p` reads it. */
export const DEFAULT_WORKER_CMD = "omp -p";
export const DEFAULT_AGENT = "task";

/** One child as the registry records it at spawn. */
export interface ChildPlan {
  readonly id: string;
  readonly name: string;
  readonly agent: string;
  readonly task: FleetTask;
  readonly inboxPath: string;
}

/** POSIX shell quoting for one word: single quotes, with an embedded quote closed and reopened. */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The prompt one child starts from: who it is, its peers and their inboxes, how messages reach it and how it
 * sends them, then the shared context and its own task. Children start blank, so everything they need is here.
 */
export function childPrompt(session: string, context: string, child: ChildPlan, peers: readonly ChildPlan[]): string {
  const others = peers.filter((peer) => peer.id !== child.id);
  const lines = [
    "# Fleet",
    `You are \`${child.name}\` (agent: ${child.agent}, id \`${child.id}\`) in fleet session \`${session}\`.`,
    others.length
      ? `Peers running beside you: ${others.map((peer) => `\`${peer.name}\` (inbox ${peer.inboxPath})`).join(", ")}.`
      : "You have no peers in this spawn.",
    `Messages from the parent or peers are appended to ${child.inboxPath}; re-read it between steps.`,
    `To message a peer, call the \`task_fleet\` tool with {"op":"send","session":"${session}","to":"<Name>|all",`
    + `"from":"${child.name}","content":"..."}. Without that tool, append to the peer's inbox file an entry of the `
    + `form \`--- message from ${child.name} at <ISO time>\` followed by the message on the next line.`,
  ];
  if (child.task.tools?.length) lines.push(`Your tools are limited to: ${child.task.tools.join(", ")}.`);
  if (child.task.solutionSpace) lines.push(`Solution space: ${child.task.solutionSpace}.`);
  return `${lines.join("\n")}\n\n${context.trim()}\n\n# Your task\n${child.task.task.trim()}\n`;
}

/** The worker command for one child: the caller's, or `omp -p` with the child's model and tool list. */
export function workerCommand(task: FleetTask, workerCmd: string | undefined): string {
  if (workerCmd) return workerCmd;
  const parts = [DEFAULT_WORKER_CMD];
  if (task.model) parts.push("--model", shQuote(task.model));
  if (task.tools?.length) parts.push("--tools", shQuote(task.tools.join(",")));
  return parts.join(" ");
}

/**
 * The script one child's runner executes: the child's identity as environment, its working directory,
 * then the worker replacing the shell so the recorded pid is the worker's.
 */
export function workerScript(session: string, child: ChildPlan, cwd: string, command: string): string {
  const env: Record<string, string> = {
    TASK_FLEET_SESSION: session,
    TASK_FLEET_ID: child.id,
    TASK_FLEET_NAME: child.name,
    TASK_FLEET_AGENT: child.agent,
    TASK_FLEET_INBOX: child.inboxPath,
    TASK_FLEET_TOOLS: (child.task.tools ?? []).join(","),
  };
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shQuote(value)}`);
  return `${exports.join("\n")}\ncd ${shQuote(cwd)} || exit 127\nexec ${command}\n`;
}

/**
 * Runs one child: skips a child killed while queued, marks it running, records the worker pid, and records the
 * exit code. A kill is a `killed` marker file that is never overwritten, so a kill that lands between the
 * runner's checks is still honoured: the runner re-checks after the pid is recorded and signals the worker.
 */
export const RUNNER_SCRIPT = `d=$1
[ -e "$d/killed" ] && exit 0
printf running > "$d/state"
/bin/sh "$d/worker.sh" < "$d/prompt.md" > "$d/output.log" 2>&1 &
pid=$!
printf '%s' "$pid" > "$d/pid"
[ -e "$d/killed" ] && kill "$pid" 2>/dev/null
wait "$pid"
code=$?
printf '%s' "$code" > "$d/exit_code"
[ -e "$d/killed" ] || printf exited > "$d/state"
exit 0
`;

/** Bounded concurrency: xargs runs at most $2 runners at once over the NUL-separated child list in $1. */
export const SUPERVISOR_SCRIPT = `xargs -0 -n 1 -P "$2" /bin/sh "$3" < "$1"`;

/** A child id: its name plus a short random suffix, so a name reused across spawns stays addressable. */
export function childId(name: string, random: string): string {
  return `${name}-${random.slice(0, 8)}`;
}

/** One inbox entry: a header naming the sender and time, then the message. */
export function inboxEntry(from: string, at: string, content: string): string {
  return `--- message from ${from} at ${at}\n${content.trim()}\n`;
}
