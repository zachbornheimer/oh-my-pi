import type { CustomToolAPI, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { assertDistributions, evaluate, type Evaluation, type Questions } from "./core.js";
import { type Update, withHeartbeat } from "./heartbeat.js";
import { openRouterKey, type OpRead } from "./openrouter_key.js";

export const NAME = "system_one";

/** OpenRouter's System One base URL; the path is appended. */
export const OPENROUTER_SYSTEM_ONE_BASE_URL = "https://openrouter.ai/api";
/** OpenRouter's moving alias for the newest jev; the tilde is part of the slug (without it OpenRouter answers 400). */
export const DEFAULT_MODEL = "~typesafe/jev-latest";
export const DEFAULT_PATH = "/v1/systemone";

export const DESCRIPTION = [
  "Ask a System One decision model every question about a state in one call and get calibrated probabilities back; use it for bounded choices, yes/no probabilities and rubric scores, not free-form answers.",
  'Call `{"state":"the export button crashes in safari","questions":{"team":{"type":"choice","instructions":"which team?","criteria":{"frontend":null,"backend":"owns the APIs"}}}}`.',
  "`state` is a string or any JSON object or array, sent as-is. `questions` maps your ids to `{type:\"choice\",instructions,criteria:{label:rubric|null}}` (two or more labels), `{type:\"noul\",instructions}` (probability of yes) or `{type:\"score\",instructions,criteria:[lowest,…,highest]}` (two or more levels); at least one question is REQUIRED. `model` overrides the default.",
  "Endpoint: `SYSTEM_ONE_BASE_URL` (default OpenRouter's System One API; key `SYSTEM_ONE_API_KEY`, on the default endpoint else `OPENROUTER_API_KEY`, else 1Password), `SYSTEM_ONE_PATH` (default `/v1/systemone`), `SYSTEM_ONE_MODEL` (default `~typesafe/jev-latest`).",
  "A reply with a missing answer, wrong answer type, unknown choice, probability outside 0..1, probabilities not summing to 1, or an off-rubric score is REJECTED, never repaired. Every failure throws `system_one: <reason>`; one request, 10 s limit, no retry.",
  "Sends the state and questions to the endpoint (network, may cost money); writes nothing locally.",
  "Returns `{model?,answers,usage?,requestId?,provider}`: choice `{type,choice,probabilities,confidence}`, noul `{type,noul}`, score `{type,score (0-based rubric index),probabilities,legend,confidence}`.",
].join(" ");

/** What the tool reaches outside itself for; tests pass fakes. */
export interface Deps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  opRead?: OpRead;
}

interface Params {
  state: unknown;
  questions: Record<string, Record<string, unknown>>;
  model?: string | null;
}

/** Rejects what the wire would: no question, a choice or score with under two levels, a blank instruction. */
export function validateQuestions(raw: unknown): Questions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new Error("at least one question is required");
  }
  const questions: Questions = {};
  for (const [id, value] of Object.entries(raw)) {
    const q = value as Record<string, unknown> | null;
    if (q === null || typeof q !== "object") throw new Error(`question "${id}" must be an object`);
    if (typeof q.instructions !== "string" || q.instructions.trim() === "") throw new Error(`question "${id}" needs non-empty instructions`);
    if (q.type === "noul") {
      Object.defineProperty(questions, id, { value: { type: "noul", instructions: q.instructions }, enumerable: true, writable: true, configurable: true });
    } else if (q.type === "choice") {
      const criteria = q.criteria as Record<string, unknown> | null | undefined;
      if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria) || Object.keys(criteria).length < 2) {
        throw new Error(`choice question "${id}" requires at least two criteria`);
      }
      for (const [label, rubric] of Object.entries(criteria)) {
        if (rubric !== null && typeof rubric !== "string") throw new Error(`choice question "${id}": criterion "${label}" must be a string or null`);
      }
      Object.defineProperty(questions, id, { value: { type: "choice", instructions: q.instructions, criteria }, enumerable: true, writable: true, configurable: true });
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.some((level) => typeof level !== "string")) {
        throw new Error(`score question "${id}" requires an array of at least two rubric levels`);
      }
      Object.defineProperty(questions, id, { value: { type: "score", instructions: q.instructions, criteria: q.criteria }, enumerable: true, writable: true, configurable: true });
    } else {
      throw new Error(`question "${id}" has unknown type ${JSON.stringify(q.type)}; use choice, noul or score`);
    }
  }
  return questions;
}

/** The endpoint the environment names, with its key; only the default endpoint falls back to the OpenRouter key. */
export async function endpointFrom(env: NodeJS.ProcessEnv, opRead?: OpRead) {
  const baseUrl = env.SYSTEM_ONE_BASE_URL?.trim() || OPENROUTER_SYSTEM_ONE_BASE_URL;
  const rawKey = env.SYSTEM_ONE_API_KEY?.trim();
  let apiKey = rawKey && !rawKey.startsWith("op://") ? rawKey : undefined;
  if (apiKey === undefined && baseUrl === OPENROUTER_SYSTEM_ONE_BASE_URL) apiKey = await openRouterKey(env, opRead);
  return {
    id: NAME,
    baseUrl,
    path: env.SYSTEM_ONE_PATH?.trim() || DEFAULT_PATH,
    ...(apiKey ? { apiKey } : {}),
    defaultModel: env.SYSTEM_ONE_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export async function runSystemOne(params: Params, deps: Deps = {}, signal?: AbortSignal): Promise<Evaluation> {
  try {
    const questions = validateQuestions(params.questions);
    const options = await endpointFrom(deps.env ?? process.env, deps.opRead);
    const response = await evaluate(
      { ...options, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
      { state: params.state, questions, ...(params.model ? { model: params.model } : {}) },
      signal,
    );
    assertDistributions(questions, response.answers);
    return response;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`system_one: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function makeTool(pi: Pick<CustomToolAPI, "zod">, deps: Deps = {}) {
  const z = pi.zod;
  const question = z.union([
    z.object({
      type: z.literal("choice").describe("Pick exactly one label."),
      instructions: z.string().min(1).describe("What the model is asked."),
      criteria: z.record(z.string(), z.string().nullable()).describe("Two or more labels mapped to a rubric string or null."),
    }),
    z.object({
      type: z.literal("noul").describe("Probability of yes."),
      instructions: z.string().min(1).describe("What the model is asked."),
    }),
    z.object({
      type: z.literal("score").describe("Locate the state on an ordered rubric."),
      instructions: z.string().min(1).describe("What the model is asked."),
      criteria: z.array(z.string()).describe("Two or more rubric levels, lowest to highest."),
    }),
  ]);
  return {
    name: NAME,
    label: "System One",
    description: DESCRIPTION,
    loadMode: "essential" as const,
    approval: "read" as const,
    parameters: z.object({
      state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("What every question is asked about: a string or any JSON object/array, sent as-is."),
      questions: z.record(z.string(), question).describe("Questions by answer id; at least one; all are asked in one call."),
      model: z.string().nullable().optional().describe("Model on the wire; omit for SYSTEM_ONE_MODEL, else ~typesafe/jev-latest."),
    }),
    async execute(_toolCallId: string, params: Params, onUpdate: Update | undefined, _ctx: unknown, signal?: AbortSignal) {
      const output = await withHeartbeat(onUpdate, "system_one is waiting for the decision model", () => runSystemOne(params, deps, signal));
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  };
}

const factory: CustomToolFactory = (pi) => makeTool(pi) as never;

export default factory;
