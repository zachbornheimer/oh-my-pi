import { type ConversationReader } from "./context.js";
import { conversationSource } from "./conversation_digest.js";
import { folderSource } from "./folder_inventory.js";
import type { Machine } from "./machine.js";
import { isRecord } from "./reply.js";
import { CONVERSATION_REF, harnessOf } from "./transcript.js";
import { SOURCE_KINDS, type Source } from "./types.js";

const MAX_FILE_CHARS = 40000;
const MAX_FILE_LINE_CHARS = 300;

/** What the gatherers read through: the filesystem and the conversation stores. Nothing is written. */
export interface GatherDeps {
  readonly machine: Machine;
  readonly readConversation: ConversationReader;
  readonly signal?: AbortSignal;
}

/** Where a source that is not a conversation ref lives: `~` and `~/` are the home directory, a relative path is from the working directory. */
export function pathOf(source: string, machine: Machine): string {
  const path = source === "~"
    ? machine.homeDirectory
    : source.startsWith("~/")
    ? `${machine.homeDirectory}/${source.slice(2)}`
    : source.startsWith("/")
    ? source
    : `${machine.workingDirectory}/${source}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** A file as a source: its lines numbered, so the model can cite `path:line`. */
export function fileSource(ref: string, path: string, text: string): Source {
  const lines = text.split("\n");
  const numbered: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const shown = `${index + 1}: ${
      line.length <= MAX_FILE_LINE_CHARS ? line : `${line.slice(0, MAX_FILE_LINE_CHARS)}…`
    }`;
    used += shown.length + 1;
    if (used > MAX_FILE_CHARS) break;
    numbered.push(shown);
  }
  return {
    ref,
    kind: "file",
    body: [`File: ${path}`, ...numbered].join("\n"),
    anchors: [...new Set([path, ref])],
    truncated: numbered.length < lines.length,
  };
}

/** One argument as a source: a conversation ref is read as a transcript with its tool calls, else a folder or a file. */
export async function resolveSource(argument: string, deps: GatherDeps): Promise<Source> {
  if (CONVERSATION_REF.test(argument)) {
    const harness = harnessOf(argument);
    const turns = await deps.readConversation(harness, argument.slice(harness.length + 1), deps.signal);
    const source = conversationSource(argument, turns);
    if (source.body === "") {
      throw new Error(`propose_capabilities: ${argument} has no user, agent or tool-call turns to read`);
    }
    return source;
  }
  const path = pathOf(argument, deps.machine);
  if (await deps.machine.isDirectory(path)) return folderSource(argument, path, deps.machine, deps.signal);
  const text = await deps.machine.readTextFile(path);
  if (text === undefined) {
    throw new Error(
      `propose_capabilities: cannot read ${path}; each source is a conversation ref such as claude:<id>, a file or a folder`,
    );
  }
  return fileSource(argument, path, text);
}

/** A source the caller already read, checked: the shape every later step relies on. */
export function sourceFrom(value: unknown, index: number): Source {
  const where = `sources[${index}]`;
  if (!isRecord(value)) throw new Error(`${where} must be a string to read or a source object`);
  const { ref, kind, body, anchors, truncated } = value;
  if (typeof ref !== "string" || ref === "") throw new Error(`${where}.ref must be a non-empty string`);
  if (typeof kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${where}.kind must be one of ${SOURCE_KINDS.join(", ")}`);
  }
  if (typeof body !== "string" || body === "") throw new Error(`${where}.body must be a non-empty string`);
  if (!Array.isArray(anchors) || anchors.some((anchor) => typeof anchor !== "string")) {
    throw new Error(`${where}.anchors must be an array of strings`);
  }
  if (typeof truncated !== "boolean") throw new Error(`${where}.truncated must be true or false`);
  return { ref, kind: kind as Source["kind"], body, anchors: anchors as string[], truncated };
}

/** Each source that is a string is read, in parallel; a source object is checked and kept. Order is kept. */
export function resolveSources(sources: readonly unknown[], deps: GatherDeps): Promise<Source[]> {
  return Promise.all(sources.map((source, index) =>
    typeof source === "string" ? resolveSource(source, deps) : Promise.resolve(sourceFrom(source, index))
  ));
}
