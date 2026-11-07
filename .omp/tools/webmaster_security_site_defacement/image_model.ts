import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BARE_OMP_FLAGS, type Exec, MODEL_TIMEOUT_MS, type ModelStep } from "./omp_model.ts";

/** A model step that reads one image: `omp -p @<prompt file> @<image>` in a private temporary directory removed afterwards. */
export function ompImageStep(exec: Exec, imagePath: string, options: { timeoutMs?: number } = {}): ModelStep {
  return async (prompt, signal) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "omp-image-step-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const result = await exec("omp", ["-p", `@${file}`, `@${imagePath}`, ...BARE_OMP_FLAGS], {
        signal,
        timeout: options.timeoutMs ?? MODEL_TIMEOUT_MS,
        cwd: directory,
      });
      if (result.killed) {
        signal?.throwIfAborted();
        throw new Error(`model step was killed after ${(options.timeoutMs ?? MODEL_TIMEOUT_MS) / 1000} s`);
      }
      if (result.code !== 0) throw new Error(`model step exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
      const reply = result.stdout.trim();
      if (reply === "") throw new Error("model step returned no text");
      return reply;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
