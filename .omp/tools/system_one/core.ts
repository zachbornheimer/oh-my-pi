/**
 * The System One wire: one POST of `{ state, questions, model? }` to a `/v1/systemone` endpoint, and a fail-closed
 * validation of the reply. Copied and ported to TypeScript from the MIT-licensed `system-one-core` 0.2.1
 * (https://github.com/iamaamir/system-one, `dist/providers/http.js` and `dist/validation.js`), plus the
 * probability-sum check that release lacks.
 */

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export type Questions = Record<string, Question>;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface Evaluation {
  model?: string;
  answers: Record<string, unknown>;
  usage?: Usage;
  requestId?: string;
  provider: string;
}

export class SystemOneError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SystemOneError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;
/** Upper bound for error-body buffering on non-OK responses. */
const MAX_ERROR_BODY_BYTES = 2048;
/** Upper bound for the model-visible error detail after extraction. */
const MAX_ERROR_DETAIL_CHARS = 500;

type Json = Record<string, unknown>;

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

function assertProb(n: unknown, what: string): void {
  if (!isFiniteNum(n) || n < 0 || n > 1) throw new SystemOneError(`invalid probability for ${what}`, "SYSTEM_ONE_PROTOCOL");
}

const protocol = (message: string): SystemOneError => new SystemOneError(message, "SYSTEM_ONE_PROTOCOL");

/** An answer id comes from the caller: `__proto__` must store an answer, not reparent the object. */
function setOwnAnswer(answers: Json, id: string, value: unknown): void {
  Object.defineProperty(answers, id, { value, enumerable: true, writable: true, configurable: true });
}

const asCount = (n: unknown): number | undefined => (isFiniteNum(n) && n >= 0 ? n : undefined);

function normalizeUsage(u: unknown): Usage | undefined {
  if (!isRecord(u)) return undefined;
  const inputTokens = asCount(u.inputTokens) ?? asCount(u.input_tokens);
  const outputTokens = asCount(u.outputTokens) ?? asCount(u.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
}

/** Checks every question has a correctly shaped answer; anything else throws a protocol error. */
export function validateResponse(questions: Questions, raw: unknown, providerId: string): Omit<Evaluation, "requestId"> & { requestId?: string } {
  if (!isRecord(raw)) throw protocol("response is not an object");
  if (!isRecord(raw.answers)) throw protocol("missing answers");
  const given = raw.answers;
  const answers: Json = {};
  for (const [id, q] of Object.entries(questions)) {
    // Own-key read: a provider-controlled answers object must not satisfy the presence check via an inherited property.
    const a = Object.hasOwn(given, id) ? given[id] : undefined;
    if (!isRecord(a)) throw protocol(`missing answer for ${id}`);
    if (a.type !== q.type) throw protocol(`wrong answer type for ${id}`);
    if (q.type === "noul") {
      if (!isFiniteNum(a.noul) || a.noul < 0 || a.noul > 1) throw protocol(`invalid noul for ${id}`);
      setOwnAnswer(answers, id, { type: "noul", noul: a.noul });
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      if (typeof a.choice !== "string" || !keys.includes(a.choice)) throw protocol(`unknown choice for ${id}`);
      if (!isRecord(a.probabilities)) throw protocol(`missing probabilities for ${id}`);
      for (const k of keys) assertProb(a.probabilities[k], `${id}.${k}`);
      if (!isFiniteNum(a.confidence) || a.confidence < 0 || a.confidence > 1) throw protocol(`invalid confidence for ${id}`);
      setOwnAnswer(answers, id, { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence });
    } else {
      // A score is a location on the ordered rubric, in one full convention: index slots ("0".."n-1") or criteria
      // values. The distribution must cover every level exactly once, the legend must label exactly the
      // distributed keys, and the score must sit on the rubric.
      const slots = q.criteria.map((_, i) => String(i));
      const values = q.criteria.map((c) => String(c));
      if (!isFiniteNum(a.score)) throw protocol(`invalid score for ${id}`);
      if (!isFiniteNum(a.confidence) || a.confidence < 0 || a.confidence > 1) throw protocol(`invalid confidence for ${id}`);
      if (!isRecord(a.legend)) throw protocol(`score answer "${id}" legend must be an object map`);
      if (!isRecord(a.probabilities)) throw protocol(`score answer "${id}" probabilities must be an object map`);
      const probs = a.probabilities;
      const probKeys = Object.keys(probs);
      const slotsComplete = slots.every((s) => Object.hasOwn(probs, s));
      const valuesComplete = values.every((v) => Object.hasOwn(probs, v));
      const complete = probKeys.length === q.criteria.length && (slotsComplete || valuesComplete);
      if (!complete) {
        const inSlots = probKeys.every((k) => slots.includes(k));
        const inValues = probKeys.every((k) => values.includes(k));
        if (!inSlots && !inValues) {
          const unknown = probKeys.find((k) => !slots.includes(k) && !values.includes(k));
          if (unknown !== undefined) throw protocol(`score answer "${id}" contains unexpected probability key "${unknown}"`);
          throw protocol(`score answer "${id}" mixes rubric index and label probability keys`);
        }
        const expected = inSlots ? slots : values;
        const missing = expected.find((k) => !Object.hasOwn(probs, k));
        if (missing === undefined) throw protocol(`score answer "${id}" mixes rubric index and label probability keys`);
        throw protocol(`score answer "${id}" is missing probability for rubric level "${missing}"`);
      }
      for (const k of probKeys) assertProb(probs[k], `${id}.${k}`);
      for (const k of probKeys) {
        if (!Object.hasOwn(a.legend, k)) throw protocol(`score answer "${id}" is missing legend entry for rubric level "${k}"`);
      }
      for (const k of Object.keys(a.legend)) {
        if (!Object.hasOwn(probs, k)) throw protocol(`score answer "${id}" contains unexpected legend key "${k}"`);
      }
      const max = q.criteria.length - 1;
      if (a.score < 0 || a.score > max) throw protocol(`score answer "${id}" has score ${a.score} outside valid rubric range 0..${max}`);
      setOwnAnswer(answers, id, { type: "score", score: a.score, probabilities: a.probabilities, legend: a.legend, confidence: a.confidence });
    }
  }
  const usage = normalizeUsage(raw.usage);
  return {
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    answers,
    ...(usage ? { usage } : {}),
    ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
    provider: providerId,
  };
}

/**
 * `system-one-core` 0.2.1 checks every probability's range but not that they sum to 1, so a torn distribution would
 * pass as calibrated. A choice or score answer whose probabilities are not a distribution is malformed.
 */
export function assertDistributions(questions: Questions, answers: Record<string, unknown>): void {
  for (const id of Object.keys(questions)) {
    const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
    const probabilities = isRecord(answer) && isRecord(answer.probabilities) ? answer.probabilities : undefined;
    if (probabilities === undefined) continue;
    const total = Object.values(probabilities).reduce<number>((sum, p) => sum + (typeof p === "number" ? p : 0), 0);
    if (Math.abs(total - 1) > 1e-5) throw new Error(`answer "${id}" probabilities sum to ${total}, expected 1`);
  }
}

/** Credential-shaped `key=value` fragments a backend may echo back are redacted; the key stays so the message is debuggable. */
const SENSITIVE_VALUE_PATTERN = /((?:api[_-]?key|password|passwd|secret|token|authorization)\s*[:=]\s*["']?)([^"'\s,}]+)/gi;

function sanitizeErrorDetail(detail: string): string {
  return detail
    .replace(SENSITIVE_VALUE_PATTERN, "$1[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

/** A message out of the known error envelopes (`detail`, `message`, `error`, `error.message`, a bare string). */
function extractStructuredDetail(body: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof data === "string") return data;
  if (isRecord(data)) {
    for (const key of ["detail", "message"]) {
      if (typeof data[key] === "string") return data[key] as string;
    }
    const nested = data.error;
    if (typeof nested === "string") return nested;
    if (isRecord(nested) && typeof nested.message === "string") return nested.message;
  }
  return undefined;
}

/** Remote error bodies are untrusted: 5xx bodies are never forwarded; 4xx details are bounded and sanitized. */
export function formatErrorDetail(status: number, body: string): string {
  if (status >= 500) return "";
  const structured = extractStructuredDetail(body);
  const raw = (structured ?? body).trim();
  if (!raw) return "";
  // An unstructured body that opens like markup is an error page, not a validation message.
  if (structured === undefined && raw.startsWith("<")) return "";
  const detail = sanitizeErrorDetail(raw).slice(0, MAX_ERROR_DETAIL_CHARS);
  return detail ? `: ${detail}` : "";
}

/** Streams at most `maxBytes` of a body; `truncated` says the cap cut it short. */
async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (bytes - maxBytes))));
      truncated = true;
      break;
    }
    chunks.push(value);
  }
  await reader.cancel().catch(() => {});
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

export interface ProviderOptions {
  id: string;
  baseUrl: string;
  path: string;
  apiKey?: string;
  defaultModel?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** One evaluation against a `/v1/systemone` endpoint; throws `SystemOneError` subclasses by `code` on any failure. */
export async function evaluate(
  options: ProviderOptions,
  request: { state: unknown; questions: Questions; model?: string },
  signal?: AbortSignal,
): Promise<Evaluation> {
  if (!options.baseUrl) throw new Error("baseUrl is required");
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}${options.path}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort);
  }
  const timeout = (cause?: unknown): SystemOneError =>
    new SystemOneError(`request timed out after ${timeoutMs}ms`, "SYSTEM_ONE_TIMEOUT", { cause });
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const model = request.model ?? options.defaultModel;
    let res: Response;
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ state: request.state, questions: request.questions, ...(model ? { model } : {}) }),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        if (timedOut) throw timeout();
        throw new SystemOneError("request aborted", "SYSTEM_ONE_TRANSPORT", { cause: e });
      }
      throw new SystemOneError((e as Error)?.message ?? "transport failure", "SYSTEM_ONE_TRANSPORT", { cause: e });
    }
    const requestId = res.headers.get("x-request-id") ?? res.headers.get("x-typesafe-request-id") ?? undefined;
    if (!res.ok) {
      let body = "";
      try {
        body = (await readLimited(res, MAX_ERROR_BODY_BYTES)).text;
      } catch {
        // Unreadable body (aborted mid-read); the status still informs.
      }
      if (timedOut) throw timeout();
      if (controller.signal.aborted) throw new SystemOneError("request aborted", "SYSTEM_ONE_TRANSPORT");
      throw new SystemOneError(`provider error ${res.status}${formatErrorDetail(res.status, body)}`, "SYSTEM_ONE_HTTP");
    }
    let read: { text: string; truncated: boolean };
    try {
      read = await readLimited(res, maxBytes);
    } catch (e) {
      if (timedOut) throw timeout(e);
      if (controller.signal.aborted) throw new SystemOneError("request aborted", "SYSTEM_ONE_TRANSPORT", { cause: e });
      throw new SystemOneError(e instanceof Error ? e.message : "response body read failure", "SYSTEM_ONE_TRANSPORT", { cause: e });
    }
    if (read.truncated) throw new SystemOneError("response too large", "SYSTEM_ONE_HTTP");
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch {
      throw new SystemOneError("invalid JSON", "SYSTEM_ONE_HTTP");
    }
    const out = validateResponse(request.questions, json, options.id);
    return { ...out, ...(out.requestId === undefined && requestId !== undefined ? { requestId } : {}) } as Evaluation;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
