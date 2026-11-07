import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "./exec.js";
import type { SandboxPort, SessionRequest, SessionRun } from "./ports.js";

/** The dev-env checkout that owns the sandbox tasks; this capability runs them and never edits them. */
export const DEV_ENV_ENV = "RELAY_TICKET_DEV_ENV";
export function defaultDevEnvRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[DEV_ENV_ENV] ?? join(homedir(), "Developer", "Personal", "dev-env");
}

/** The dev-env mise tasks this adapter drives. */
const TASK_UP = "container:up";
const TASK_SESSION = "container:e2b:session";
const TASK_DOWN = "container:down";

/**
 * The up phases a session needs: the session driver prepares everything else inside the sandbox itself. `tailnet`
 * joins the owner's tailnet as an ephemeral node (dev-env hands the Tailscale key to the box; this side holds none).
 * A failed join fails `container:up`, so `lease` throws; `relayTicket` then never runs the session, sweeps the
 * sandbox in its teardown check and settles the ticket `failed` with the up output as the reason. No retry, no
 * fallback to a tailnet-less sandbox.
 */
const UP_PHASES = ["probe", "apt", "tailnet"] as const;

/** Provisioning's own deadline; a longer one is a hung provision, and its sandbox is swept by the caller. */
const LEASE_DEADLINE_MS = 15 * 60_000;
/** The status and down calls are short API round trips. */
const API_DEADLINE_MS = 3 * 60_000;
/** The sandbox outlives the session by provisioning plus the driver's own 15-minute command margin and a buffer. */
const SANDBOX_MARGIN_MINUTES = 25;
/** The session driver's command timeout is budget + 15 min; this deadline sits beyond it so the driver ends first. */
const SESSION_MARGIN_MINUTES = 25;

/** How long the sandbox is leased for a session budget: the E2B timeout is the backstop that ends a leak. */
export function sandboxLifetimeMinutes(sessionMinutes: number): number {
  return sessionMinutes + SANDBOX_MARGIN_MINUTES;
}

const tail = (text: string, chars = 1500) => text.trim().slice(-chars);

function failure(what: string, result: ExecResult): Error {
  const how = result.stopped ? "was stopped at its deadline" : `exited ${result.code}`;
  return new Error(`${what} ${how}: ${tail(`${result.stderr}\n${result.stdout}`)}`);
}

/** `e2b.py status --json`: an array of rows, each with a nullable `name`; anything else is unreadable and throws. */
function statusNames(stdout: string): (string | null)[] {
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("e2b.py status --json did not answer a list");
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || !("name" in row) || (row.name !== null && typeof row.name !== "string")) {
      throw new Error("e2b.py status --json answered a row without a name");
    }
    return row.name;
  });
}

/**
 * The sandbox port over dev-env's tasks: `container:up` leases, `container:e2b:session` runs the session and ends it
 * (worktree dropped, sandbox terminated, on every exit path of the driver), `container:down` and `e2b.py status --json`
 * verify and sweep. mise runs with `-C <devEnv>`; nothing under dev-env is written.
 */
export function devEnvSandbox(exec: Exec, devEnv: string): SandboxPort {
  const mise = (task: string, args: readonly string[]) => ["-C", devEnv, "run", task, ...args];
  return {
    async lease({ name, minutes }, signal) {
      const phases = UP_PHASES.flatMap((phase) => ["--phase", phase]);
      const result = await exec(
        "mise",
        mise(TASK_UP, ["--name", name, ...phases, "--timeout-minutes", String(sandboxLifetimeMinutes(minutes))]),
        { timeoutMs: LEASE_DEADLINE_MS, signal },
      );
      if (result.code !== 0) throw failure(`${TASK_UP} --name ${name}`, result);
    },

    async session(request: SessionRequest, signal?: AbortSignal): Promise<SessionRun> {
      const args = [
        "--name", request.name,
        ...(request.repo === undefined ? [] : ["--repo", `https://github.com/${request.repo}.git`]),
        "--branch", request.branch,
        "--conversation", request.conversation,
        "--timeout-minutes", String(request.minutes),
        ...(request.model === undefined ? [] : ["--model", request.model]),
        "--prompt", request.prompt,
      ];
      const result = await exec("mise", mise(TASK_SESSION, args), {
        timeoutMs: (request.minutes + SESSION_MARGIN_MINUTES) * 60_000,
        signal,
        // The driver's stderr is the session's live output, including the worker's transcript frames.
        liveSession: true,
      });
      return { exitCode: result.code, output: `${result.stdout}\n${result.stderr}`, stopped: result.stopped };
    },

    async present(name) {
      const result = await exec("uv", ["run", "--quiet", join(devEnv, "tools", "container", "e2b.py"), "status", "--json"], {
        timeoutMs: API_DEADLINE_MS,
      });
      if (result.code !== 0) throw failure("e2b.py status --json", result);
      return statusNames(result.stdout).includes(name);
    },

    async down(name) {
      const result = await exec("mise", mise(TASK_DOWN, ["--name", name]), { timeoutMs: API_DEADLINE_MS });
      if (result.code !== 0) throw failure(`${TASK_DOWN} --name ${name}`, result);
    },
  };
}
