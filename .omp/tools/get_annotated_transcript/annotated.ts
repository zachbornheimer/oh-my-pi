import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { estimateUsd, priceOf } from "./pricing.js";
import { COMPACTION_SUMMARY } from "./reader/schemas.js";
import { type Annotation, type Format, type Item, type SessionExport, itemsOf } from "./session_export.js";

const MAX_HAPPENED_CHARS = 160;
const NOTABLE_OUTPUT_CHARS = 8_000;
const NOTABLE_WAIT_MS = 60_000;
const CORRECTION_PATTERN = /\b(no|don't|do not|stop|instead|already (told|said|answered|gave)|wrong|not what i)\b/i;
const DENIAL_PATTERN = /denied|not available|no such tool|hook.?blocked|user rejected|permission denied/i;
const UNSAFE_FILENAME_CHARACTERS = /[^A-Za-z0-9._-]+/g;

type TokenUsage = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  model?: string;
};

export function annotatedDirectory(): string {
  return process.env.CAPABILITY_ANNOTATED_DIR || join(homedir(), ".local", "share", "capability-replicas", "annotated");
}

function withoutAnnotation(item: Item): Item {
  const { annotation: _annotation, ...rest } = item;
  return rest as Item;
}

function mapSessionItems(session: SessionExport, mapItem: (item: Item) => Item): SessionExport {
  return {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn,
      ...(turn.user === undefined ? {} : { user: turn.user.map(mapItem) }),
      ...(turn.response === undefined ? {} : { response: turn.response.map(mapItem) }),
    })),
  };
}

export function transcriptDigest(session: SessionExport): string {
  const transcript = mapSessionItems(session, withoutAnnotation);
  return createHash("sha256").update(JSON.stringify(transcript)).digest("hex").slice(0, 16);
}

function safeFilename(conversation: string): string {
  return conversation.replace(UNSAFE_FILENAME_CHARACTERS, "_");
}

export function annotatedPathOf(session: SessionExport): string {
  return join(annotatedDirectory(), `${safeFilename(session.conversation)}-${transcriptDigest(session)}.annotated.json`);
}

export function reviewPathOf(conversation: string): string {
  return join(annotatedDirectory(), `${safeFilename(conversation)}.review.md`);
}

function textOf(item: Item): string {
  const text = typeof item.text === "string" ? item.text.trim() : "";
  return text || (typeof item.content === "string" ? item.content.trim() : "");
}

function toolNamesOf(item: Item): string[] {
  if (!Array.isArray(item.tool_calls)) return [];

  return item.tool_calls.flatMap((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call) || !("name" in call)) return [];
    return typeof call.name === "string" && call.name !== "" ? [call.name] : [];
  });
}

function clipped(text: string, format: Format): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return format === "raw" || singleLine.length <= MAX_HAPPENED_CHARS
    ? singleLine
    : `${singleLine.slice(0, MAX_HAPPENED_CHARS - 1)}…`;
}

/**
 * An item's time in epoch milliseconds: an ISO string (an export written by another tool) or a number of Unix seconds
 * (what `exportOf` writes; a value already in milliseconds is kept).
 */
function timestampOf(item: Item | undefined): number | undefined {
  const value = item?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function usageOf(item: Item): TokenUsage | undefined {
  const usage: unknown = item.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;

  const values = usage as Record<string, unknown>;
  if (typeof values.input !== "number" && typeof values.output !== "number") return undefined;

  const model = typeof values.model === "string" && values.model !== "" ? values.model : undefined;
  return {
    input: tokenCount(values.input),
    output: tokenCount(values.output),
    cache_read: tokenCount(values.cache_read),
    cache_write: tokenCount(values.cache_write),
    ...(model === undefined ? {} : { model }),
  };
}

function isUserItem(item: Item, toolNames: readonly string[]): boolean {
  return item.source !== "agent"
    && item.source !== "system"
    && toolNames.length === 0
    && item.tool_call_id === undefined
    && item.is_error !== true;
}

function happenedOf(item: Item, text: string, toolNames: readonly string[], denied: boolean, format: Format): string {
  if (item.synthetic_reason === COMPACTION_SUMMARY) {
    return text === "" ? "Compacted earlier turns" : `Compacted earlier turns: ${clipped(text, format)}`;
  }

  if (toolNames.length > 0) return `Called ${toolNames.join(", ")}`;

  if (item.source === "system" || item.tool_call_id !== undefined || item.is_error === true) {
    const failed = denied || item.is_error === true;
    if (text === "") return failed ? "A tool failed" : "A tool returned nothing";
    return `${failed ? "Failed" : "Returned"}: ${clipped(text, format)}`;
  }

  if (item.source === "agent") return text === "" ? "Agent sent an empty reply" : `Replied: ${clipped(text, format)}`;
  return text === "" ? "User sent an empty turn" : `Asked: ${clipped(text, format)}`;
}

function costOf(item: Item, previous: Item | undefined, textLength: number): string | undefined {
  const costs: string[] = [];
  if (textLength >= NOTABLE_OUTPUT_CHARS) costs.push(`output of ${textLength} characters`);

  const timestamp = timestampOf(item);
  const previousTimestamp = timestampOf(previous);
  if (timestamp !== undefined && previousTimestamp !== undefined && timestamp - previousTimestamp >= NOTABLE_WAIT_MS) {
    costs.push(`waited ${Math.round((timestamp - previousTimestamp) / 1000)}s`);
  }

  return costs.length === 0 ? undefined : costs.join("; ");
}

export function annotationOf(item: Item, previous: Item | undefined, format: Format = "default"): Annotation {
  const text = textOf(item);
  const toolNames = toolNamesOf(item);
  const denied = DENIAL_PATTERN.test(text);
  const waste = denied ? "denied tool" : item.is_error === true ? "tool failed" : undefined;
  const cost = costOf(item, previous, text.length);
  const usage = usageOf(item);

  // Key order is the order of the `Annotation` schema (`happened, cost, waste, correction, tokens, est_usd`), so the
  // exported JSON is byte-identical to what the Mastra annotator writes for the same item.
  return {
    happened: happenedOf(item, text, toolNames, denied, format),
    ...(cost === undefined ? {} : { cost }),
    ...(waste === undefined ? {} : { waste }),
    correction: isUserItem(item, toolNames) && CORRECTION_PATTERN.test(text),
    ...(usage === undefined
      ? {}
      : { tokens: { in: usage.input, out: usage.output, cache_read: usage.cache_read, cache_write: usage.cache_write } }),
    ...(usage !== undefined && priceOf(usage.model).known ? { est_usd: estimateUsd(usage, usage.model) } : {}),
  };
}

export async function annotateTranscript(session: SessionExport, format: Format = "default"): Promise<SessionExport> {
  const annotations = new WeakMap<Item, Annotation>();
  let previous: Item | undefined;

  for (const item of itemsOf(session)) {
    annotations.set(item, annotationOf(item, previous, format));
    previous = item;
  }

  const annotate = (item: Item): Item => ({
    ...item,
    annotation: annotations.get(item) ?? annotationOf(item, undefined, format),
  });

  return mapSessionItems(session, annotate);
}

export async function writeAnnotated(session: SessionExport): Promise<string> {
  const path = annotatedPathOf(session);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`);
  return path;
}
