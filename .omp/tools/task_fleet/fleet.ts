import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  childId,
  type ChildPlan,
  childPrompt,
  DEFAULT_AGENT,
  inboxEntry,
  RUNNER_SCRIPT,
  workerCommand,
  workerScript,
} from "./compose.js";
import type { FleetRequest } from "./input.js";

/**
 * The fleet registry lives on disk, one directory per session and one per child, so a later call (from this
 * omp process or another) sees every child. Children run under a detached `xargs -P` supervisor, so spawn
 * returns before any child finishes.
 */

export type ChildState = "queued" | "running" | "exited" | "killed";

export interface FleetChild {
  readonly id: string;
  readonly name: string;
  readonly agent: string;
  readonly state: ChildState;
  readonly exit_code?: number;
  readonly model?: string;
  readonly tools?: string[];
  readonly spawned_at: string;
  /** Messages delivered to this child. */
  readonly inbox: number;
  readonly output_path: string;
}

export interface FleetOutput {
  readonly op: FleetRequest["op"];
  readonly session: string;
  readonly state_dir: string;
  readonly ids?: string[];
  readonly children?: FleetChild[];
  readonly delivered_to?: string[];
  readonly killed?: string[];
}

/** What the fleet needs from the host: clock, ids, the detached supervisor, and signals. Tests inject fakes. */
export interface FleetPorts {
  /** Directory fleets live in. */
  readonly home: string;
  /** The session a call without `session` addresses. */
  readonly defaultSession: string;
  /** Directory a relative `cwd` resolves against and the default `cwd`. */
  readonly cwd: string;
  now(): Date;
  /** 32 hex characters. */
  randomId(): string;
  /** Starts the detached supervisor: at most `concurrency` runners at once over the NUL-separated list in `batchFile`. */
  startSupervisor(args: { batchFile: string; runnerPath: string; concurrency: number; cwd: string }): void;
  /** Sends SIGTERM to a pid; throws when it is gone. */
  terminate(pid: number): void;
}

const INBOX_HEADER = /^--- message from /gm;

interface ChildMeta {
  readonly id: string;
  readonly name: string;
  readonly agent: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly spawned_at: string;
}

export async function runFleet(ports: FleetPorts, request: FleetRequest): Promise<FleetOutput> {
  const session = request.session ?? ports.defaultSession;
  const stateDir = join(ports.home, session);
  switch (request.op) {
    case "spawn": {
      const ids = await spawnChildren(ports, request, session, stateDir);
      // Each child's state as spawn returns: queued or running, never settled, since spawn does not wait.
      const children = (await listChildren(stateDir)).filter((child) => ids.includes(child.id));
      return { op: "spawn", session, state_dir: stateDir, ids, children };
    }
    case "list":
      return { op: "list", session, state_dir: stateDir, children: await listChildren(stateDir) };
    case "send":
      return { op: "send", session, state_dir: stateDir, delivered_to: await sendMessage(ports, request, session, stateDir) };
    case "kill":
      return { op: "kill", session, state_dir: stateDir, killed: await killChildren(ports, request, session, stateDir) };
  }
}

async function spawnChildren(
  ports: FleetPorts,
  request: Extract<FleetRequest, { op: "spawn" }>,
  session: string,
  stateDir: string,
): Promise<string[]> {
  const cwd = resolve(ports.cwd, request.cwd ?? ".");
  if (!(await isDirectory(cwd))) throw new Error(`cwd ${cwd} is not a directory; no child was started`);
  await mkdir(stateDir, { recursive: true });

  const plans: ChildPlan[] = request.tasks.map((task) => {
    const id = childId(task.name, ports.randomId());
    return { id, name: task.name, agent: task.agent ?? DEFAULT_AGENT, task, inboxPath: join(stateDir, id, "inbox.md") };
  });
  const spawnedAt = ports.now().toISOString();
  for (const plan of plans) {
    const dir = join(stateDir, plan.id);
    await mkdir(dir);
    const meta: ChildMeta = {
      id: plan.id,
      name: plan.name,
      agent: plan.agent,
      model: plan.task.model,
      tools: plan.task.tools,
      spawned_at: spawnedAt,
    };
    await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta)}\n`);
    await writeFile(join(dir, "prompt.md"), childPrompt(session, request.context, plan, plans));
    await writeFile(
      join(dir, "worker.sh"),
      workerScript(session, plan, cwd, workerCommand(plan.task, request.workerCmd)),
    );
    await writeFile(join(dir, "inbox.md"), "");
    await writeFile(join(dir, "state"), "queued");
  }

  const runnerPath = join(stateDir, "runner.sh");
  await writeFile(runnerPath, RUNNER_SCRIPT);
  const batchFile = join(stateDir, `batch-${ports.randomId()}.list`);
  await writeFile(batchFile, plans.map((plan) => `${join(stateDir, plan.id)}\0`).join(""));
  ports.startSupervisor({ batchFile, runnerPath, concurrency: request.maxConcurrency, cwd });
  return plans.map((plan) => plan.id);
}

export async function listChildren(stateDir: string): Promise<FleetChild[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }
  const children: FleetChild[] = [];
  for (const entry of entries) {
    const dir = join(stateDir, entry);
    const meta = await readJson(join(dir, "meta.json"));
    if (!meta) continue;
    const exitText = (await readText(join(dir, "exit_code"))).trim();
    const inbox = (await readText(join(dir, "inbox.md"))).match(INBOX_HEADER)?.length ?? 0;
    children.push({
      id: meta.id,
      name: meta.name,
      agent: meta.agent,
      state: await childState(dir),
      exit_code: exitText === "" ? undefined : Number(exitText),
      model: meta.model,
      tools: meta.tools ? [...meta.tools] : undefined,
      spawned_at: meta.spawned_at,
      inbox,
      output_path: join(dir, "output.log"),
    });
  }
  return children.sort((a, b) => a.spawned_at.localeCompare(b.spawned_at) || a.name.localeCompare(b.name));
}

/** `exited` is final; otherwise the kill marker wins over whatever the runner last wrote. */
async function childState(dir: string): Promise<ChildState> {
  const recorded = (await readText(join(dir, "state"))).trim();
  if (recorded === "exited") return "exited";
  if (recorded === "killed" || (await exists(join(dir, "killed")))) return "killed";
  return recorded === "running" ? "running" : "queued";
}

const isLive = (child: FleetChild): boolean => child.state === "queued" || child.state === "running";

async function sendMessage(
  ports: FleetPorts,
  request: Extract<FleetRequest, { op: "send" }>,
  session: string,
  stateDir: string,
): Promise<string[]> {
  const children = await listChildren(stateDir);
  const targets = resolveLiveTargets(children, request.to, session);
  const entry = inboxEntry(request.from, ports.now().toISOString(), request.content);
  for (const child of targets) await appendFile(join(stateDir, child.id, "inbox.md"), entry);
  return targets.map((child) => child.id);
}

async function killChildren(
  ports: FleetPorts,
  request: Extract<FleetRequest, { op: "kill" }>,
  session: string,
  stateDir: string,
): Promise<string[]> {
  const targets = resolveLiveTargets(await listChildren(stateDir), request.to, session);
  const killed: string[] = [];
  for (const child of targets) {
    const dir = join(stateDir, child.id);
    // The child may have finished since it was listed: an exit already recorded stands.
    if ((await readText(join(dir, "state"))).trim() === "exited") continue;
    await writeFile(join(dir, "killed"), "");
    const pid = Number((await readText(join(dir, "pid"))).trim());
    if (pid > 0) {
      try {
        ports.terminate(pid);
      } catch {
        // Already gone: the recorded kill stands.
      }
    }
    killed.push(child.id);
  }
  return killed;
}

/**
 * `all` is every live child, an id or name must name a live child. A name reused across spawns addresses the
 * newest child carrying it. A child that has exited or was killed is refused: nothing would read its inbox.
 */
function resolveLiveTargets(children: readonly FleetChild[], to: string, session: string): FleetChild[] {
  if (to === "all") {
    const live = children.filter(isLive);
    if (live.length === 0) throw new Error(`no live child in fleet session ${session}`);
    return live;
  }
  const target = children.find((child) => child.id === to) ?? children.filter((child) => child.name === to).at(-1);
  if (!target) {
    const known = [...new Set(children.map((child) => child.name))].join(", ") || "none";
    throw new Error(`no child named or with id ${to} in fleet session ${session}; known: ${known}`);
  }
  if (!isLive(target)) throw new Error(`child ${target.id} is ${target.state}; only queued or running children can be addressed`);
  return [target];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readJson(path: string): Promise<ChildMeta | undefined> {
  const text = await readText(path);
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as ChildMeta;
  } catch {
    return undefined;
  }
}
