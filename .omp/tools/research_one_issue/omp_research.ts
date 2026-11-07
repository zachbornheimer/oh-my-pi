import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./source.js";

/**
 * The model step: one `omp -p` child process that reads a prompt file and answers in text. It is limited to `read`
 * (which fetches pages) and `web_search`, so it can research and cannot edit, run commands, or recurse into a tool;
 * every extension, skill, rule and context file is off. The model is omp's own default unless a role is named.
 */

/** Longest one research turn may run before it is killed. */
export const RESEARCH_TIMEOUT_MS = 20 * 60_000;

export const RESEARCH_TOOLS = "read,web_search";

export const RESEARCH_FLAGS = [
  "--tools",
  RESEARCH_TOOLS,
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
  "--no-lsp",
  "--no-pty",
] as const;

/** Sends one prompt to a model and returns its reply text. */
export type ResearchStep = (prompt: string, options: { role?: string; signal?: AbortSignal }) => Promise<string>;

export function ompResearchStep(exec: Exec, options: { timeoutMs?: number } = {}): ResearchStep {
  const timeout = options.timeoutMs ?? RESEARCH_TIMEOUT_MS;
  return async (prompt, { role, signal }) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "research-one-issue-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const args = ["-p", `@${file}`, ...RESEARCH_FLAGS, ...(role === undefined ? [] : ["--model", role])];
      const result = await exec("omp", args, { signal, timeout, cwd: directory });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`the research turn was killed after ${timeout / 1000} s`);
      }
      if (result.code !== 0) {
        throw new Error(`the research turn exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      }
      const reply = result.stdout.trim();
      if (reply === "") throw new Error("the research turn returned no text");
      return reply;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
