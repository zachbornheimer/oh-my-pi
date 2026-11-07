import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { answerQuestions } from "./answer_questions.js";
import { ompModelStep, withHeartbeat } from "./omp_model.js";
import { type ActiveBranch, readRecentTurns } from "./recent_turns.js";

export const DESCRIPTION = [
  "Answer every question in one or more question files (ai-question-schema YAML) about one state, using model runs (`omp -p`, no tools); use it to gate or classify a session or a proposed action against a standing question set. Use `get_recent_turns` to read turns without asking questions.",
  'Input: `{"state":"Add a retry to the upload step.","questions":[{"file":"/abs/allow.yaml"}]}` or `{"conversation":"omp:latest","additional_context":{"tool":"run_command","command":"rm -rf build"},"turns":6,"questions":[{"file":"/abs/allow.yaml"}]}`.',
  "`state` (non-blank string or JSON object) is the state and nothing is read; else `conversation` (`<harness>:<session id|prefix|latest|title>`, harness omp, pi, claude, grok, codex, cursor, copilot, agentmux, hermes or opencode) supplies its newest `turns` (default 16, `length_limit` 3000 characters a message, `max_tokens` 12000). `additional_context` (string or object) is appended after the state.",
  "Question file paths MUST be absolute. A relative path, missing file, unparseable file, a field in two files, or a schema that cannot be checked fails before any model runs.",
  "Returns `{answers, conversation?, turns?: {total_turns, kept, dropped}}`: a yes/no field is P(yes) from 0 to 1, a choice `{Value, Probabilities}`, a score `{Point, Probabilities}`, a schema field its JSON value.",
  "Probabilities are the model's stated estimates, not calibrated token probabilities. Any failure throws and no answer is guessed.",
  "Cost: one model process for all decision questions and one per schema question. Reads the files and session transcripts; writes nothing. Mastra chat threads and Codex `.jsonl.zst` transcripts cannot be read.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  // pi.zod (omptype) has no .nullish(); models sometimes send null for an unused field.
  const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional();
  const stateOrObject = z.union([z.string(), z.record(z.string(), z.unknown())]);
  return {
    name: "answer_questions",
    label: "Answer question files",
    description: DESCRIPTION,
    parameters: z.object({
      state: stateOrObject.nullable().optional().describe(
        "What the questions are about: a non-blank string (trimmed) or a JSON object. When present, no conversation is read.",
      ),
      conversation: z.string().nullable().optional().describe(
        "Read the state from this session when `state` is absent: `<harness>:<session id|prefix|latest|title>`, e.g. `omp:latest`.",
      ),
      additional_context: stateOrObject.nullable().optional().describe(
        "Extra material added after the state, such as a proposed tool call, a diff or a rule. A string is kept as words, an object as JSON.",
      ),
      turns: positiveInteger.describe("Newest conversation turns kept. Default 16."),
      length_limit: positiveInteger.describe("Most characters kept of one message. Default 3000."),
      max_tokens: positiveInteger.describe("Oldest turns are dropped until the estimate is at or below this. Default 12000."),
      questions: z.array(z.object({ file: z.string().describe("Absolute path of a question YAML file.") })).min(1).describe(
        "Question files to ask, each `{file: \"/abs/path.yaml\"}`. At least one.",
      ),
    }),

    async execute(_toolCallId, params, onUpdate, ctx, signal) {
      const active: ActiveBranch | undefined = ctx?.sessionManager === undefined
        ? undefined
        : {
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
          branch: ctx.sessionManager.getBranch() as unknown as ActiveBranch["branch"],
        };
      const output = await withHeartbeat(onUpdate, "answer_questions is working", () =>
        answerQuestions(
          {
            state: params.state ?? undefined,
            conversation: params.conversation ?? undefined,
            additional_context: params.additional_context ?? undefined,
            turns: params.turns ?? undefined,
            length_limit: params.length_limit ?? undefined,
            max_tokens: params.max_tokens ?? undefined,
            questions: params.questions,
          },
          {
            step: ompModelStep(pi.exec),
            readConversation: (reference, bounds, abort) => readRecentTurns(reference, bounds, active, abort),
            signal,
          },
        ));
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
