import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exec, ExecResult } from "./omp_session.js";

/** A scripted stand-in for `pi.exec`: it answers each `omp -p` call from a script, reads the prompt file the call named, and keeps what it saw. */
export interface Call {
  command: string;
  args: string[];
  prompt: string;
  cwd: string | undefined;
  timeout: number | undefined;
  signal: AbortSignal | undefined;
}

export type Reply = string | ExecResult | ((call: Call) => string | ExecResult | Promise<string | ExecResult>);

export function fakeOmp(script: Reply[]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    const promptArg = args.find((arg) => arg.startsWith("@"));
    const call: Call = {
      command,
      args,
      prompt: promptArg === undefined ? "" : await readFile(promptArg.slice(1), "utf8"),
      cwd: options?.cwd,
      timeout: options?.timeout,
      signal: options?.signal,
    };
    calls.push(call);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error(`the fake omp was called ${calls.length} times and has no reply for it`);
    const reply = typeof next === "function" ? await next(call) : next;
    const sessionDir = args.find((arg) => arg.startsWith("--session-dir="))?.slice("--session-dir=".length);
    if (sessionDir !== undefined) {
      await mkdir(join(sessionDir, "--tmp--"), { recursive: true });
      await writeFile(join(sessionDir, "--tmp--", `session-${calls.length}.jsonl`), "{}\n");
    }
    return typeof reply === "string" ? { stdout: reply, stderr: "", code: 0, killed: false } : reply;
  };
  return { exec, calls };
}
