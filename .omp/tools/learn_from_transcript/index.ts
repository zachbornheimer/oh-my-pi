import { homedir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { annotatedDirectory } from "./annotated.js";
import { type LearnResult, learnFromTranscript, loadPreambles } from "./chain.js";
import { liveStartTask } from "./dispatch.js";
import { execAtask } from "./exec_atask.js";
import { HEARTBEAT_MS, ompAgentStep } from "./omp_agent.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";

export const DESCRIPTION = [
  "Learn from one finished agent session and file a fix for every root cause: annotate the session without a model, run an execution-forensics thread (analyze, root_cause) and a forensic-PM thread (pm_triage, pm_review) as full `omp -p` sessions, file one atask objective per reviewed objective (`atask add`, idempotent on title) and, with dispatch, start one atask worker per ready objective, serialized per project.",
  "Use after a session that went wrong or wasted time. A prose review alone is `extract_hypotheses`; landing changes straight from a review is `learn`.",
  'Input `{"source":"/path/session.jsonl","dispatch":false}`. `source` is an omp session file, a session-export `.json`, or `<harness>:<id|latest|title words>`; omitted, it takes the worst unlearned omp session among the youngest 50 here (ranked by active minutes, tool errors, cost). Mastra chat-thread refs are NOT supported. `dispatch` defaults true; false files objectives and starts no worker.',
  "Effects: reads sessions; spends model quota (four full omp sessions, up to 40 min each, which may search and update Linear); writes annotated and thread files; files atask objectives; with dispatch, spawns headless workers that claim tasks, edit worktrees and merge once verification passes (each waits up to 30 min, then reports `running`). Runs minutes to hours and sends progress every 15 s.",
  "Fails when a model answer stays schema-invalid after 3 attempts; finished questions replay on a rerun.",
  "Returns the source, thread paths and one entry per objective: atask id, status, filing, warning or error, and with dispatch its `delegated` run or `skip` reason.",
].join(" ");

/** The model-facing rendering: the headline, then one line per objective. */
export function resultText(result: LearnResult): string {
  const lines = [`learn_from_transcript: ${result.headline}`, `source: ${result.source}${result.source_picked ? " (picked)" : ""}`];
  for (const objective of result.objectives) {
    const parts = [objective.atask_id ?? "unfiled", objective.status, objective.title];
    if (objective.project !== undefined) parts.push(`[${objective.project}]`);
    lines.push(`- ${parts.join(" | ")}`);
    if (objective.warning !== undefined) lines.push(`  warning: ${objective.warning}`);
    if (objective.error !== undefined) lines.push(`  error: ${objective.error}`);
    if ("delegated" in objective && objective.delegated !== undefined) {
      const run = objective.delegated;
      lines.push(`  worker: ${run.status}${run.branch === undefined ? "" : ` on ${run.branch}`}${run.completion === undefined ? "" : `, landing ${run.completion.outcome}`}${run.error === undefined ? "" : `, ${run.error}`}`);
    }
    if ("skip" in objective && objective.skip !== undefined) lines.push(`  no worker: ${objective.skip}`);
  }
  lines.push(`forensics thread: ${result.forensics_thread}`, `PM thread: ${result.pm_thread}`, `annotated: ${result.annotated_path}`);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "learn_from_transcript",
    label: "Learn from transcript",
    description: DESCRIPTION,
    loadMode: "discoverable",
    parameters: z.object({
      source: z
        .string()
        .nullable()
        .optional()
        .describe("Session to learn from: omp session file path, session-export `.json`, or `<harness>:<id|latest|title words>`. Omitted: the worst unlearned omp session among the youngest 50."),
      dispatch: z
        .boolean()
        .nullable()
        .optional()
        .describe("Start one atask worker per ready filed objective. Default true; false files the objectives and starts no worker."),
    }),
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      const source = params.source ?? undefined;
      if (source !== undefined && source.trim() === "") throw new Error("learn_from_transcript: `source` is blank");
      const dispatch = params.dispatch ?? true;

      const began = Date.now();
      let latest = "starting";
      const report = (message: string): void => {
        latest = message;
      };
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `learn_from_transcript: ${latest} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { phase: latest },
        });
      }, HEARTBEAT_MS);
      try {
        const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
        const result = await learnFromTranscript(
          { ...(source === undefined ? {} : { source: source.trim() }), dispatch },
          {
            agent: ompAgentStep(pi.exec, { cwd: pi.cwd, addDirs: [annotatedDirectory(), join(agentDir, "threads")] }),
            atask: execAtask(pi.exec, { cwd: pi.cwd, signal }),
            startTask: liveStartTask({ cwd: pi.cwd, signal, report }),
            transcripts: transcriptFilesTurnSource(),
            agentDir,
            preambles: await loadPreambles(),
            records: { currentSessionId: process.env.OMP_SESSION_ID },
            report,
            signal,
          },
        );
        signal?.throwIfAborted();
        return {
          content: [{ type: "text", text: resultText(result) }],
          details: { ...result, seconds: Math.round((Date.now() - began) / 1000) },
        };
      } finally {
        clearInterval(beat);
      }
    },
  };
};

export default factory;
