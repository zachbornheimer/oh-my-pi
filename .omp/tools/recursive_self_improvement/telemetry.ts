// Deterministic telemetry of one omp session: wall time, tokens, cost, tool errors, model switches and the human's own
// prompts. Copied from the Mastra twin (`packages/ai/src/learn/triage.ts`, `extractOmpSessionTelemetry`). No imports.

export interface SessionTelemetry {
  conversation: string;
  source: string;
  /** `YYYY-MM-DD` */
  day: string;
  bytes: number;
  human_turns: number;
  tool_calls: number;
  tool_errors: number;
  model_switches: number;
  active_wall_minutes: number;
  longest_turn_minutes: number;
  total_tokens: number;
  cost_usd: number;
  models_used: string[];
  human_excerpts: string[];
  error_excerpts: string[];
}

const SYNTHETIC_PREFIXES = [
  "<system-reminder",
  "<system-context",
  "<hindsight_",
  "Untrusted capability wake",
  "Scope: ",
  "Intent: ",
  "atask_context_version:",
  "[Pass 1 Execution Forensics",
  "# Shared operating instructions",
  "Convert a complete 2-pass Execution Forensics",
];

function isGenuineHumanPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return !SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const rec = part as { readonly type?: unknown; readonly text?: unknown };
      return rec.type === "text" && typeof rec.text === "string" ? [rec.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Extracts deterministic wall-time, token, cost, tool-error, model-switch, and human-prompt telemetry
 * from raw omp JSONL content. Returns `undefined` if the session is a learner/PM session itself.
 */
export function extractOmpSessionTelemetry(input: {
  readonly conversation: string;
  readonly source: string;
  readonly day: string;
  readonly rawJsonl: string;
}): SessionTelemetry | undefined {
  const bytes = Buffer.byteLength(input.rawJsonl, "utf8");
  const lines = input.rawJsonl.split("\n").filter((line) => line.trim() !== "");
  let humanTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let modelSwitches = 0;
  let totalTokens = 0;
  let costUsd = 0;
  const modelsSet = new Set<string>();
  const humanExcerpts: string[] = [];
  const errorExcerpts: string[] = [];

  let currentTurnStartMs: number | undefined;
  let currentTurnLastMs: number | undefined;
  let activeWallMs = 0;
  let longestTurnMs = 0;
  let lastModel: string | undefined;

  const flushTurn = () => {
    if (currentTurnStartMs !== undefined && currentTurnLastMs !== undefined && currentTurnLastMs > currentTurnStartMs) {
      const span = Math.min(currentTurnLastMs - currentTurnStartMs, 2 * 3600 * 1000);
      activeWallMs += span;
      if (span > longestTurnMs) longestTurnMs = span;
    }
    currentTurnStartMs = undefined;
    currentTurnLastMs = undefined;
  };

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.type === "model_change") {
      modelSwitches += 1;
      continue;
    }
    const rawMsg = entry.message;
    const msgObj = typeof rawMsg === "object" && rawMsg !== null ? (rawMsg as Record<string, unknown>) : undefined;
    const tsRaw = entry.timestamp ?? msgObj?.timestamp;
    const tsMs = typeof tsRaw === "number" ? tsRaw : typeof tsRaw === "string" ? Date.parse(tsRaw) : undefined;
    const msg = msgObj ?? entry;
    const role = msg.role;

    if (role === "user") {
      const text = extractTextFromContent(msg.content);
      // Skip learner / PM sessions so the self-improving loop never triages its own forensics runs.
      if (
        text.includes("Here's a transcript to review:")
        || text.includes("<stage1_forensics_conversation>")
        || text.includes("You are the **Stage 2 Forensic PM Agent**")
      ) {
        return undefined;
      }
      if (isGenuineHumanPrompt(text)) {
        flushTurn();
        if (tsMs !== undefined && !Number.isNaN(tsMs)) {
          currentTurnStartMs = tsMs;
          currentTurnLastMs = tsMs;
        }
        humanTurns += 1;
        const clean = text.replace(/\s+/g, " ").slice(0, 220);
        if (humanExcerpts.length < 10) humanExcerpts.push(clean);
        else {
          humanExcerpts.shift();
          humanExcerpts.push(clean);
        }
      }
    } else if (role === "assistant") {
      if (tsMs !== undefined && !Number.isNaN(tsMs)) {
        if (currentTurnStartMs === undefined) currentTurnStartMs = tsMs;
        currentTurnLastMs = tsMs;
      }
      const model = typeof msg.model === "string" ? msg.model : undefined;
      if (model !== undefined) {
        modelsSet.add(model);
        if (lastModel !== undefined && lastModel !== model) modelSwitches += 1;
        lastModel = model;
      }
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (typeof usage === "object" && usage !== null) {
        const inp = typeof usage.input === "number" ? usage.input : 0;
        const out = typeof usage.output === "number" ? usage.output : 0;
        const cr = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
        const cw = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
        totalTokens += inp + out + cr + cw;
        const costObj = usage.cost as Record<string, unknown> | number | undefined;
        if (typeof costObj === "number") costUsd += costObj;
        else if (typeof costObj === "object" && costObj !== null && typeof costObj.total === "number") {
          costUsd += costObj.total;
        }
      }
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "object" && part !== null && "type" in part && part.type === "toolCall") {
            toolCalls += 1;
          }
        }
      }
    } else if (role === "toolResult" || role === "tool") {
      if (tsMs !== undefined && !Number.isNaN(tsMs)) currentTurnLastMs = tsMs;
      const isErr = msg.isError === true || entry.isError === true;
      if (isErr) {
        toolErrors += 1;
        if (errorExcerpts.length < 6) {
          const errText = extractTextFromContent(msg.content).replace(/\s+/g, " ").slice(0, 180);
          if (errText !== "") errorExcerpts.push(errText);
        }
      }
    }
  }
  flushTurn();

  return {
    conversation: input.conversation,
    source: input.source,
    day: input.day,
    bytes,
    human_turns: humanTurns,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    model_switches: modelSwitches,
    active_wall_minutes: Math.round((activeWallMs / 60_000) * 10) / 10,
    longest_turn_minutes: Math.round((longestTurnMs / 60_000) * 10) / 10,
    total_tokens: totalTokens,
    cost_usd: Math.round(costUsd * 100) / 100,
    models_used: [...modelsSet],
    human_excerpts: humanExcerpts,
    error_excerpts: errorExcerpts,
  };
}
