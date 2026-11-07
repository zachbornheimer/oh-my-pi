import { QUESTION_INSTRUCTIONS, QUESTION_SCHEMA } from "./question.js";
import type { ResearchStep } from "./omp_research.js";
import {
  type Item,
  parseAnswer,
  type ResearchAnswer,
  type ResearchOutput,
  type ResearchRecord,
  type SourceRef,
} from "./schemas.js";
import { readSource, type SourceDeps } from "./source.js";
import { cacheKeyOf, readRecord, recordPathOf, writeRecord } from "./store.js";

export type ResearchInput = { source: SourceRef; cache_key?: string; fresh?: boolean; role?: string };

export type ResearchPorts = {
  source: SourceDeps;
  ask: ResearchStep;
  /** The directory the store lives in. */
  root: string;
  now(): Date;
  progress(message: string): void;
};

/**
 * The question with the source material in place of `{item}`, the reply schema attached, and nothing else. The JSON
 * Schema is inlined because `omp -p` has no structured-output field.
 */
export function researchPrompt(item: Item): string {
  const material = [`# ${item.title}`, `Source: ${item.kind} ${item.id}`, `Status: ${item.status}`, item.body]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  return [
    QUESTION_INSTRUCTIONS.replaceAll("{item}", () => material),
    "Answer with exactly one JSON object matching this schema and nothing else. Do not wrap it in a code fence.",
    JSON.stringify(QUESTION_SCHEMA, null, 2),
  ].join("\n\n");
}

/** The JSON object in an answer, or a typed failure naming what came back instead. */
export function parseResearch(answer: string): ResearchAnswer {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`research answered no JSON object: ${answer.slice(0, 400)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch (error) {
    throw new Error(`research answered invalid JSON (${(error as Error).message}): ${answer.slice(0, 400)}`);
  }
  return parseAnswer(parsed);
}

/**
 * Reads the source, reuses the stored record for its key unless `fresh`, else asks omp for the research and stores it.
 * It changes nothing outside the research store.
 */
export async function researchOneIssue(ports: ResearchPorts, input: ResearchInput): Promise<ResearchOutput> {
  // A bad cache_key fails before any source is read or model is asked.
  if (input.cache_key !== undefined) recordPathOf(input.cache_key, ports.root);
  ports.progress(`reading ${input.source.kind} ${input.source.ref}`);
  const item = await readSource(ports.source, input.source);
  const key = input.cache_key ?? cacheKeyOf(item);
  if (input.fresh !== true) {
    const cached = await readRecord(key, ports.root);
    if (cached !== undefined) return { record: cached, from_cache: true, store_path: recordPathOf(key, ports.root) };
  }
  ports.progress("researching (one omp turn with web search; minutes)");
  const answer = await ports.ask(researchPrompt(item), { role: input.role, signal: ports.source.signal });
  const record: ResearchRecord = { key, item, ...parseResearch(answer), researched_at: ports.now().toISOString() };
  const store_path = await writeRecord(record, ports.root);
  return { record, from_cache: false, store_path };
}
