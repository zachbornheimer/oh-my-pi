import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { analyzeHost } from "./analyze.ts";
import { type HostClock, type HostMachine, gatherSnapshot, systemClock } from "./gather.ts";
import { type Exec, type ModelStep, ompModelStep, withHeartbeat } from "./omp_model.ts";
import { DEFAULT_TOP, DEFAULT_WINDOW_S, type HostBottlenecksOutput, type HostSnapshot } from "./types.ts";

/**
 * Native `host_bottlenecks` custom tool: a port of the Mastra capability `host.bottlenecks` together with the host-side
 * gatherer the Mastra CLI ran before it. Self-contained: no Mastra, no gateway, no `capability` CLI. The model step is
 * one `omp -p` child process.
 */

/** One host command (`ps`, `lsof`, `docker stats`) may run this long; a hung `docker` must not hang the tool. */
const COMMAND_TIMEOUT_MS = 30_000;

export const DESCRIPTION =
  "Find what is slowing this Mac down: the heaviest CPU and memory process families, each with what started it (a git commit, a hook, an agent session, launchd), "
  + "a verdict (`normal`, `overscoped`, `runaway`, `contention` or `unknown`) and a remedy. It also reports swap in use, disks over 90% full, "
  + "and each virtual machine's product, configured CPUs and containers, so a saturated machine can be told from an undersized one. "
  + "Use it when the machine is slow or hot, or before deciding to kill or cap something. "
  + "`{\"top\":5,\"window_s\":2,\"include_normal\":false}`: every field is optional; `top` is how many of the heaviest families by CPU and by memory are examined (default 10), "
  + "`window_s` is the seconds between the two process samples that measure CPU (default 5, so the call takes at least that long), "
  + "`include_normal` also lists families judged normal in `families` (default false; they are always in `normal`). "
  + "Rules settle what they can and one `omp -p` model call judges the rest; a family neither settles stays `unknown`. "
  + "Remedies are advice, with the exact command where one applies: it NEVER kills, caps or restarts anything, so ask the user before acting on one. "
  + "Read-only on the machine: runs `ps`, `sysctl`, `df`, `lsof`, `git rev-parse` and, when a Docker VM runs, `docker stats`; "
  + "reads the working directories of the heaviest processes and the hook config of their repositories. "
  + "Result: `summary` (one sentence), `load`, `families` (worst first), `normal`, `swap`, `disks`, `vms`.";

type ToolApi = Parameters<CustomToolFactory>[0];
type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** The test seam: every outside thing the tool touches. Production passes none. */
export interface HostBottlenecksDeps {
  readonly machine?: HostMachine;
  readonly step?: ModelStep;
  readonly clock?: HostClock;
  /** Replaces the whole gather (tests that start from a recorded snapshot). */
  readonly gather?: (request: { top: number; window_s: number }) => Promise<HostSnapshot>;
}

/** The real machine: `pi.exec` for every command (argument lists, a timeout each), the real files under the user's home. */
export function execMachine(pi: ToolApi, signal: AbortSignal | undefined): HostMachine {
  return {
    homeDirectory: homedir(),
    async run(command, args) {
      signal?.throwIfAborted();
      try {
        const result = await pi.exec(command, [...args], { signal, timeout: COMMAND_TIMEOUT_MS, cwd: pi.cwd });
        if (result.killed) {
          signal?.throwIfAborted();
          return { code: -1, stdout: result.stdout, stderr: `${command} timed out after ${COMMAND_TIMEOUT_MS / 1000} s` };
        }
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        signal?.throwIfAborted();
        return { code: -1, stdout: "", stderr: (error as Error).message };
      }
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async isFile(path) {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** The text the model reads: the one-sentence summary, then the full report as JSON. */
export function renderReport(output: HostBottlenecksOutput): string {
  return `${output.summary}\n${JSON.stringify(output)}`;
}

/** Build the tool; `deps` is the test seam. */
export function buildTool(pi: ToolApi, deps: HostBottlenecksDeps = {}) {
  const z = pi.zod;
  return {
    name: "host_bottlenecks",
    label: "Host Bottlenecks",
    description: DESCRIPTION,
    parameters: z.object({
      top: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(`How many of the heaviest families by CPU and by memory to examine each; default ${DEFAULT_TOP}.`),
      window_s: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(`Seconds between the two process samples that measure CPU; default ${DEFAULT_WINDOW_S}. The call takes at least this long.`),
      include_normal: z
        .boolean()
        .nullable()
        .optional()
        .describe("List families judged normal in `families` too; default false."),
    }),

    async execute(
      _toolCallId: string,
      params: { top?: number | null; window_s?: number | null; include_normal?: boolean | null },
      onUpdate: Update | undefined,
      _ctx: unknown,
      signal: AbortSignal | undefined,
    ) {
      const request = { top: params.top ?? DEFAULT_TOP, window_s: params.window_s ?? DEFAULT_WINDOW_S };
      const output = await withHeartbeat(onUpdate, "host_bottlenecks is reading the machine", async () => {
        const snapshot = deps.gather
          ? await deps.gather(request)
          : await gatherSnapshot(deps.machine ?? execMachine(pi, signal), request, deps.clock ?? systemClock);
        onUpdate?.({ content: [{ type: "text", text: "host_bottlenecks: judging process families" }], details: { status: "running" } });
        const step = deps.step ?? ompModelStep(pi.exec as Exec);
        return analyzeHost(snapshot, { top: request.top, include_normal: params.include_normal ?? false }, step, signal);
      });
      return { content: [{ type: "text" as const, text: renderReport(output) }], details: output };
    },
  };
}

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
