import { beforeEach, describe, expect, it } from "bun:test";
import { assertDistributions, evaluate, formatErrorDetail, validateResponse, type Questions } from "./core.js";
import factory, { DESCRIPTION, endpointFrom, makeTool, runSystemOne, validateQuestions } from "./index.js";
import { resetCachedKey } from "./openrouter_key.js";
import { loadZod } from "./zod_for_tests.ts";

const zod = await loadZod();

const CHOICE: Questions = { team: { type: "choice", instructions: "which team?", criteria: { frontend: null, backend: "owns APIs" } } };

const choiceReply = { type: "choice", choice: "frontend", probabilities: { frontend: 0.75, backend: 0.25 }, confidence: 0.9 };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("validateResponse", () => {
  it("accepts a choice, a noul and a score answer and keeps usage in both spellings", () => {
    const questions: Questions = {
      ...CHOICE,
      yes: { type: "noul", instructions: "ok?" },
      sev: { type: "score", instructions: "how bad?", criteria: ["low", "mid", "high"] },
    };
    const out = validateResponse(
      questions,
      {
        model: "m",
        requestId: "r1",
        usage: { input_tokens: 5, outputTokens: 2 },
        answers: {
          team: choiceReply,
          yes: { type: "noul", noul: 0.4 },
          sev: { type: "score", score: 1.5, probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 }, legend: { "0": "low", "1": "mid", "2": "high" }, confidence: 0.7 },
        },
      },
      "p",
    );
    expect(out.provider).toBe("p");
    expect(out.model).toBe("m");
    expect(out.requestId).toBe("r1");
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(out.answers.yes).toEqual({ type: "noul", noul: 0.4 });
  });

  it("accepts a score distribution keyed by rubric values", () => {
    const questions: Questions = { sev: { type: "score", instructions: "x", criteria: ["low", "high"] } };
    const out = validateResponse(questions, { answers: { sev: { type: "score", score: 0, probabilities: { low: 0.5, high: 0.5 }, legend: { low: "a", high: "b" }, confidence: 1 } } }, "p");
    expect(Object.keys(out.answers)).toEqual(["sev"]);
  });

  const reject = (questions: Questions, raw: unknown, message: string) =>
    expect(() => validateResponse(questions, raw, "p")).toThrow(message);

  it("rejects every malformed reply instead of guessing", () => {
    reject(CHOICE, null, "response is not an object");
    reject(CHOICE, {}, "missing answers");
    reject(CHOICE, { answers: {} }, "missing answer for team");
    reject(CHOICE, { answers: { team: { ...choiceReply, type: "noul" } } }, "wrong answer type for team");
    reject(CHOICE, { answers: { team: { ...choiceReply, choice: "mobile" } } }, "unknown choice for team");
    reject(CHOICE, { answers: { team: { ...choiceReply, probabilities: undefined } } }, "missing probabilities for team");
    reject(CHOICE, { answers: { team: { ...choiceReply, probabilities: { frontend: 1.5, backend: 0 } } } }, "invalid probability for team.frontend");
    reject(CHOICE, { answers: { team: { ...choiceReply, confidence: 2 } } }, "invalid confidence for team");
    reject({ q: { type: "noul", instructions: "x" } }, { answers: { q: { type: "noul", noul: -0.1 } } }, "invalid noul for q");
  });

  it("rejects score answers that are off the rubric", () => {
    const q: Questions = { s: { type: "score", instructions: "x", criteria: ["a", "b"] } };
    const good = { type: "score", score: 0, probabilities: { "0": 0.5, "1": 0.5 }, legend: { "0": "a", "1": "b" }, confidence: 1 };
    reject(q, { answers: { s: { ...good, score: 2 } } }, "outside valid rubric range 0..1");
    reject(q, { answers: { s: { ...good, probabilities: { "0": 1 } } } }, 'missing probability for rubric level "1"');
    reject(q, { answers: { s: { ...good, probabilities: { "0": 0.5, "1": 0.25, "x": 0.25 } } } }, 'unexpected probability key "x"');
    reject(q, { answers: { s: { ...good, probabilities: { "0": 0.5, b: 0.5 } } } }, "mixes rubric index and label probability keys");
    reject(q, { answers: { s: { ...good, legend: { "0": "a" } } } }, 'missing legend entry for rubric level "1"');
    reject(q, { answers: { s: { ...good, legend: { "0": "a", "1": "b", "2": "c" } } } }, 'unexpected legend key "2"');
  });

  it("does not let an inherited property satisfy an answer, and stores a __proto__ id as an own answer", () => {
    reject({ constructor: { type: "noul", instructions: "x" } }, { answers: {} }, "missing answer for constructor");
    const out = validateResponse(JSON.parse('{"__proto__":{"type":"noul","instructions":"x"}}'), JSON.parse('{"answers":{"__proto__":{"type":"noul","noul":0.5}}}'), "p");
    expect(Object.getPrototypeOf(out.answers)).toBe(Object.prototype);
    expect(Object.keys(out.answers)).toEqual(["__proto__"]);
  });
});

describe("assertDistributions", () => {
  it("rejects probabilities that do not sum to 1 and accepts those within 1e-5", () => {
    expect(() => assertDistributions(CHOICE, { team: { probabilities: { frontend: 0.7, backend: 0.2 } } })).toThrow('answer "team" probabilities sum to');
    expect(() => assertDistributions(CHOICE, { team: { probabilities: { frontend: 0.75, backend: 0.250001 } } })).not.toThrow();
    expect(() => assertDistributions({ n: { type: "noul", instructions: "x" } }, { n: { noul: 0.5 } })).not.toThrow();
  });
});

describe("formatErrorDetail", () => {
  it("forwards a redacted 4xx detail, never a 5xx body or an HTML page", () => {
    expect(formatErrorDetail(422, JSON.stringify({ detail: "bad state, api_key=sk-secret and Bearer abc123" }))).toBe(": bad state, api_key=[redacted] and Bearer [redacted]");
    expect(formatErrorDetail(400, JSON.stringify({ error: { message: "nope" } }))).toBe(": nope");
    expect(formatErrorDetail(502, "stack trace")).toBe("");
    expect(formatErrorDetail(404, "<html>missing</html>")).toBe("");
    expect(formatErrorDetail(400, "plain text reason")).toBe(": plain text reason");
    expect(formatErrorDetail(400, "x".repeat(900)).length).toBe(502);
  });
});

const OPTIONS = { id: "system_one", baseUrl: "https://example.test/api/", path: "/v1/systemone", apiKey: "k", defaultModel: "dm" };

describe("evaluate", () => {
  it("posts state, questions and the model with a bearer key, and returns the request id header", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ answers: { team: choiceReply } }, { headers: { "x-request-id": "hdr-1" } });
    }) as unknown as typeof fetch;
    const out = await evaluate({ ...OPTIONS, fetch: fake }, { state: { a: 1 }, questions: CHOICE });
    expect(seen?.url).toBe("https://example.test/api/v1/systemone");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(seen?.init.body as string)).toEqual({ state: { a: 1 }, questions: CHOICE, model: "dm" });
    expect(out.requestId).toBe("hdr-1");
    expect(out.provider).toBe("system_one");
    await evaluate({ ...OPTIONS, fetch: fake }, { state: "s", questions: CHOICE, model: "other" });
    expect(JSON.parse(seen?.init.body as string).model).toBe("other");
  });

  it("maps an HTTP error to `provider error <status>: <detail>`", async () => {
    const fake = (async () => jsonResponse({ message: "criteria required" }, { status: 422 })) as unknown as typeof fetch;
    await expect(evaluate({ ...OPTIONS, fetch: fake }, { state: "s", questions: CHOICE })).rejects.toThrow("provider error 422: criteria required");
  });

  it("fails on invalid JSON, an oversized body and a transport error", async () => {
    const run = (fake: typeof fetch, extra = {}) => evaluate({ ...OPTIONS, ...extra, fetch: fake }, { state: "s", questions: CHOICE });
    await expect(run((async () => new Response("not json")) as unknown as typeof fetch)).rejects.toThrow("invalid JSON");
    await expect(run((async () => new Response("x".repeat(50))) as unknown as typeof fetch, { maxResponseBytes: 10 })).rejects.toThrow("response too large");
    await expect(run((async () => { throw new Error("connect refused"); }) as unknown as typeof fetch)).rejects.toThrow("connect refused");
  });

  it("times out when the endpoint never answers, and reports an external abort as aborted", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    await expect(evaluate({ ...OPTIONS, fetch: hang, timeoutMs: 20 }, { state: "s", questions: CHOICE })).rejects.toThrow("request timed out after 20ms");
    const controller = new AbortController();
    const pending = evaluate({ ...OPTIONS, fetch: hang }, { state: "s", questions: CHOICE }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("request aborted");
  });
});

describe("validateQuestions", () => {
  it("refuses an empty set, a one-label choice, a short rubric, a blank instruction and an unknown type", () => {
    expect(() => validateQuestions({})).toThrow("at least one question is required");
    expect(() => validateQuestions({ a: { type: "choice", instructions: "x", criteria: { only: null } } })).toThrow("requires at least two criteria");
    expect(() => validateQuestions({ a: { type: "score", instructions: "x", criteria: ["one"] } })).toThrow("at least two rubric levels");
    expect(() => validateQuestions({ a: { type: "noul", instructions: " " } })).toThrow("non-empty instructions");
    expect(() => validateQuestions({ a: { type: "rank", instructions: "x" } })).toThrow('unknown type "rank"');
  });

  it("keeps only the fields the wire knows", () => {
    expect(validateQuestions({ a: { type: "noul", instructions: "x", extra: 1 } })).toEqual({ a: { type: "noul", instructions: "x" } });
  });
});

describe("endpointFrom", () => {
  beforeEach(() => resetCachedKey());

  it("uses SYSTEM_ONE_API_KEY, then the OpenRouter key on the default endpoint only", async () => {
    expect(await endpointFrom({ SYSTEM_ONE_API_KEY: "sk", OPENROUTER_API_KEY: "or" })).toMatchObject({ baseUrl: "https://openrouter.ai/api", apiKey: "sk", path: "/v1/systemone", defaultModel: "~typesafe/jev-latest" });
    expect(await endpointFrom({ OPENROUTER_API_KEY: "or" })).toMatchObject({ apiKey: "or" });
    const custom = await endpointFrom({ SYSTEM_ONE_BASE_URL: "http://localhost:9", OPENROUTER_API_KEY: "or", SYSTEM_ONE_PATH: "/x", SYSTEM_ONE_MODEL: "m" });
    expect(custom).toEqual({ id: "system_one", baseUrl: "http://localhost:9", path: "/x", defaultModel: "m" });
  });

  it("falls back to 1Password through op when the environment has no key, and names the failure otherwise", async () => {
    const references: string[] = [];
    const ok = await endpointFrom({}, async (reference) => (references.push(reference), "from-op\n"));
    expect(ok.apiKey).toBe("from-op");
    expect(references).toEqual(["op://Zysys/OpenRouter API Key/credential"]);
    resetCachedKey();
    await expect(endpointFrom({}, async () => { throw new Error("not signed in"); })).rejects.toThrow("OpenRouter key unavailable");
    let asked = 0;
    await expect(endpointFrom({}, async () => (asked++, "late"))).rejects.toThrow("not signed in");
    expect(asked).toBe(0);
    resetCachedKey();
    expect((await endpointFrom({ OPENROUTER_API_KEY: "op://Vault/Item/field" }, async (reference) => (references.push(reference), "k2"))).apiKey).toBe("k2");
    expect(references.at(-1)).toBe("op://Vault/Item/field");
  });
});

describe("runSystemOne", () => {
  const env = { SYSTEM_ONE_API_KEY: "sk" };

  it("returns the validated evaluation", async () => {
    const fake = (async () => jsonResponse({ model: "jev", answers: { team: choiceReply } })) as unknown as typeof fetch;
    const out = await runSystemOne({ state: "s", questions: CHOICE as never }, { env, fetch: fake });
    expect(out).toMatchObject({ model: "jev", provider: "system_one", answers: { team: { choice: "frontend" } } });
  });

  it("prefixes every failure with `system_one:` including a torn distribution and bad questions", async () => {
    const torn = (async () => jsonResponse({ answers: { team: { ...choiceReply, probabilities: { frontend: 0.5, backend: 0.1 } } } })) as unknown as typeof fetch;
    await expect(runSystemOne({ state: "s", questions: CHOICE as never }, { env, fetch: torn })).rejects.toThrow("system_one: answer \"team\" probabilities sum to");
    await expect(runSystemOne({ state: "s", questions: {} }, { env })).rejects.toThrow("system_one: at least one question is required");
    const down = (async () => jsonResponse({}, { status: 503 })) as unknown as typeof fetch;
    await expect(runSystemOne({ state: "s", questions: CHOICE as never }, { env, fetch: down })).rejects.toThrow("system_one: provider error 503");
  });

  it("rethrows the abort itself when the caller cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const hang = (() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }))) as unknown as typeof fetch;
    const error = await runSystemOne({ state: "s", questions: CHOICE as never }, { env, fetch: hang }, controller.signal).catch((e: Error) => e);
    expect((error as Error).message).toBe("request aborted");
  });
});

describe("tool shape", () => {
  const tool = makeTool({ zod } as never, { env: { SYSTEM_ONE_API_KEY: "sk" } });

  it("is essential, read-tier, named for the capability, with a dense description", () => {
    expect(tool.name).toBe("system_one");
    expect(tool.loadMode).toBe("essential");
    expect(tool.approval).toBe("read");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });

  it("validates parameters: valid input, null model, and invalid values", () => {
    const valid = { state: "s", questions: { q: { type: "noul", instructions: "x" } } };
    expect(tool.parameters.safeParse(valid).success).toBe(true);
    expect(tool.parameters.safeParse({ ...valid, model: null }).success).toBe(true);
    expect(tool.parameters.safeParse({ state: { a: [1] }, questions: { q: { type: "score", instructions: "x", criteria: ["a", "b"] } } }).success).toBe(true);
    expect(tool.parameters.safeParse({ ...valid, questions: { q: { type: "rank", instructions: "x" } } }).success).toBe(false);
    expect(tool.parameters.safeParse({ ...valid, state: 5 }).success).toBe(false);
    expect(tool.parameters.safeParse({ questions: valid.questions }).success).toBe(false);
  });

  it("executes through the fake endpoint and returns JSON text plus details", async () => {
    const fake = (async () => jsonResponse({ answers: { q: { type: "noul", noul: 0.2 } } })) as unknown as typeof fetch;
    const t = makeTool({ zod } as never, { env: { SYSTEM_ONE_API_KEY: "sk" }, fetch: fake });
    const result = await t.execute("id", { state: "s", questions: { q: { type: "noul", instructions: "x" } } }, undefined, {}, undefined);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ answers: { q: { noul: 0.2 } }, provider: "system_one" });
    expect(result.details.answers.q).toEqual({ type: "noul", noul: 0.2 });
  });

  it("default export builds the same tool from a pi API", () => {
    const built = factory({ zod } as never) as unknown as { name: string };
    expect(built.name).toBe("system_one");
  });
});
