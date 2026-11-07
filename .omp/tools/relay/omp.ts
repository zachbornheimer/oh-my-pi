import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";

/** omp's `@task` role: the model the ticket worker and the tooling pass run on unless a call names another. */
export const OMP_TASK_ROLE = "@task";
/** The adversarial reviewer's model: a different family from the maker's, because same-family models share blind spots. */
export const REVIEWER_MODEL = "xai-oauth/grok-4.7:high";

export const ASK_BUDGET_MS = 10 * 60_000;
export const REVIEW_BUDGET_MS = 45 * 60_000;
export const WORK_BUDGET_MS = 4 * 60 * 60_000;
export const IMPROVE_BUDGET_MS = 2 * 60 * 60_000;
export const FIX_BUDGET_MS = 60 * 60_000;

/** The flags that make `omp -p` a bare completion: no tool, extension, skill, rule or context file. */
export const BARE_OMP_FLAGS = [
  "--no-tools",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
  "--no-lsp",
  "--no-pty",
] as const;

/** What a run's omp store is seeded with from the global store: model roles and credentials, and the MCP servers. */
const SEEDED_FILES = ["config.yml", "models.yml", "models.db", "models.db-wal", "models.db-shm", "mcp.json"] as const;

/**
 * The omp session store private to one relay run. The run's omp children point `PI_CODING_AGENT_DIR` (omp's own override
 * for its storage directory) at it, so they are the only writers and no other omp process on the box contends with them
 * for `~/.omp/agent`, whose shared session files and `agent.db` corrupted under exactly that contention. A fresh store
 * answers `Model "@task" not found`, so it is seeded with copies of the global store's model config and MCP servers: the
 * run's own writes still land in the private store alone. Created on first use, removed by `dispose`.
 */
export class AgentStore {
  private directory: Promise<string> | undefined;

  constructor(private readonly globalStore = join(homedir(), ".omp", "agent")) {}

  path(): Promise<string> {
    this.directory ??= this.create();
    return this.directory;
  }

  private async create(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "relay-omp-store-"));
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true, mode: 0o700 });
    for (const name of SEEDED_FILES) {
      const source = join(this.globalStore, name);
      if (existsSync(source)) await copyFile(source, join(agent, name));
    }
    return agent;
  }

  async dispose(): Promise<void> {
    const made = this.directory;
    this.directory = undefined;
    if (made === undefined) return;
    const agent = await made.catch(() => undefined);
    if (agent !== undefined) await rm(join(agent, ".."), { recursive: true, force: true });
  }
}

/** Runs `omp` with `PI_CODING_AGENT_DIR` pointing at the run's private store, through `env` so no process-wide variable is touched. */
async function runOmp(
  exec: Exec,
  store: AgentStore,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number }> {
  options.signal?.throwIfAborted();
  const agent = await store.path();
  const result = await exec("env", [`PI_CODING_AGENT_DIR=${agent}`, "omp", ...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    signal: options.signal,
  });
  if (result.killed) {
    options.signal?.throwIfAborted();
    throw new Error(`omp was stopped after ${Math.round(options.timeoutMs / 1000)} s in ${options.cwd}`);
  }
  return result;
}

/** Writes `prompt` to a private temp file (never argv), runs `work` with its path, removes the file either way. */
async function withPromptFile<T>(prompt: string, work: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "relay-prompt-"));
  try {
    const file = join(directory, "prompt.md");
    await writeFile(file, prompt, { mode: 0o600 });
    return await work(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One model question: `omp -p` as a bare completion, answering its text. The reply is free text; the caller validates it. */
export async function askBare(exec: Exec, store: AgentStore, prompt: string, signal?: AbortSignal): Promise<string> {
  return withPromptFile(prompt, async (file) => {
    const scratch = await mkdtemp(join(tmpdir(), "relay-ask-"));
    try {
      const result = await runOmp(exec, store, ["-p", `@${file}`, ...BARE_OMP_FLAGS], {
        cwd: scratch,
        timeoutMs: ASK_BUDGET_MS,
        signal,
      });
      if (result.code !== 0) {
        throw new Error(`the model step exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      }
      return result.stdout;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

/**
 * One full omp session (every tool, extension and skill the store carries), headless, in `cwd`: the way the ticket worker,
 * the tooling pass and the reviewer run. Answers its final text; a non-zero exit throws with what omp said.
 */
export async function runAgent(
  exec: Exec,
  store: AgentStore,
  input: { cwd: string; prompt: string; model?: string; timeoutMs: number; label: string; signal?: AbortSignal },
): Promise<string> {
  await mkdir(input.cwd, { recursive: true });
  return withPromptFile(input.prompt, async (file) => {
    const result = await runOmp(exec, store, ["-p", `@${file}`, "--cwd", input.cwd, "--model", input.model ?? OMP_TASK_ROLE], {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    if (result.code !== 0) {
      const said = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim().slice(-1_000);
      throw new Error(`${input.label} (omp) exited ${result.code} in ${input.cwd}${said === "" ? "" : `: ${said}`}`);
    }
    return result.stdout;
  });
}
