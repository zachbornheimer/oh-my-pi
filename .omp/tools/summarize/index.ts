import type { CustomToolAPI, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { COMMAND_TIMEOUT_MS, type GatherDeps, prepare, type RawOutput } from "./gather.js";
import { type Update, withHeartbeat } from "./heartbeat.js";
import { askJson, type Exec, type ModelStep, ompModelStep } from "./omp_model.js";
import { acceptSummary, type FocusAnswer, summaryPrompt } from "./summary.js";

export const NAME = "summarize";

export const DESCRIPTION = [
  "Summarize a command's output or a file for another agent when the output is too long to read; use `run_command` with `purpose` when you want the summary folded into one command result.",
  'Call `{"command":"ps aux","focus":["Examine duplicate processes"]}` or `{"file":"build.log"}`. Pass `file` (read, never executed; relative to the session directory, `~/` allowed) or `command` (run with `sh -c` in the session directory, 300 s limit), NEVER both. `argument` alone: a path that exists is read, anything else is run as a shell command. `focus` lists questions the summary MUST answer, in order.',
  "The whole raw output goes to one `omp -p` model run with no tools (`SUMMARIZE_MODEL` picks the model); a malformed reply is asked again with the reason, 3 tries, then the call fails `summarize: no valid reply...`. Focus answers MUST repeat each question verbatim, in order; an empty summary or a summary that quotes the raw path is refused.",
  "EXECUTES the command with your permissions and spends model quota. A command's output (stdout then stderr) is written to a new temp file, mode 0600; a non-zero exit is summarized, not failed, but exit 127 or a timeout throws. A `file` is not copied.",
  "Returns `{summary,focus:[{question,answer,relevant_data}],raw_output:{path,lines}}`: `summary` is Markdown, `raw_output.path` holds the unabridged text.",
].join(" ");

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  /** The model step; defaults to `omp -p` through `pi.exec`. */
  step?: ModelStep;
  /** Where a command's output file goes; defaults to the OS temp directory. */
  tempDir?: string;
  home?: string;
  commandTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface Params {
  file?: string | null;
  command?: string | null;
  argument?: string | null;
  focus?: string[] | null;
}

export interface SummarizeOutput {
  summary: string;
  focus: FocusAnswer[];
  raw_output: RawOutput;
}

export async function runSummarize(
  params: Params,
  host: { exec: Exec; cwd: string },
  deps: Deps = {},
  signal?: AbortSignal,
): Promise<SummarizeOutput> {
  const asked = params.focus ?? [];
  if (asked.some((question) => typeof question !== "string" || question.trim() === "")) throw new Error("summarize: every focus question must be a non-empty string");
  const gather: GatherDeps = {
    exec: host.exec,
    cwd: host.cwd,
    ...(deps.home === undefined ? {} : { home: deps.home }),
    ...(deps.tempDir === undefined ? {} : { tempDir: deps.tempDir }),
    ...(signal === undefined ? {} : { signal }),
    commandTimeoutMs: deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
  };
  const prepared = await prepare(params, gather);
  signal?.throwIfAborted();
  const model = (deps.env ?? process.env).SUMMARIZE_MODEL?.trim();
  const step = deps.step ?? ompModelStep(host.exec, model ? { model } : {});
  const reply = await askJson(step, summaryPrompt(prepared.argument, asked, prepared.text), (value) => acceptSummary(value, asked, prepared.raw_output.path), { signal });
  return { summary: reply.summary, focus: reply.focus, raw_output: prepared.raw_output };
}

export function makeTool(pi: Pick<CustomToolAPI, "zod" | "exec" | "cwd">, deps: Deps = {}) {
  const z = pi.zod;
  return {
    name: NAME,
    label: "Summarize",
    description: DESCRIPTION,
    loadMode: "essential" as const,
    approval: "exec" as const,
    parameters: z.object({
      file: z.string().nullable().optional().describe("Existing file to read and summarize without executing it."),
      command: z.string().nullable().optional().describe("Shell command to run (`sh -c`); its stdout then stderr is summarized."),
      argument: z.string().nullable().optional().describe("Alternative to file/command: an existing path is read, anything else is run."),
      focus: z.array(z.string()).nullable().optional().describe("Questions the summary must answer, in order; answers come back one per question, verbatim."),
    }),
    async execute(_toolCallId: string, params: Params, onUpdate: Update | undefined, _ctx: unknown, signal?: AbortSignal) {
      const output = await withHeartbeat(onUpdate, "summarize is working", () => runSummarize(params, { exec: pi.exec as Exec, cwd: pi.cwd }, deps, signal));
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  };
}

const factory: CustomToolFactory = (pi) => makeTool(pi) as never;

export default factory;
