import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ConversationReader, Turn } from "./context.js";
import { isRecord, type Json } from "./reply.js";

/**
 * Reads the conversation `<harness>:<identifier>` from the harness's session store on this machine into the turns the
 * digest needs: what the person asked, what the agent said, and every tool call (name and input; results are not read).
 * The harness stores, the session lookup (full id, prefix, `latest`, title) and the user-text filter are the ones of
 * `get_recent_turns`, copied; this reader adds the tool-call records those turns leave out. Not read: Codex
 * `.jsonl.zst` rollouts, Cursor's legacy `store.db`, Grok's compaction summaries and Mastra threads.
 */

export const HARNESSES = [
  "agentmux",
  "grok",
  "claude",
  "cursor",
  "codex",
  "hermes",
  "opencode",
  "copilot",
  "pi",
  "omp",
] as const;
export type Harness = (typeof HARNESSES)[number];

/** A conversation ref as the tool takes it: `<harness>:<id>`, the id without spaces or colons. */
export const CONVERSATION_REF = new RegExp(`^(${HARNESSES.join("|")}):[^\\s:]+$`);

/** Characters an identifier never holds: path separators, shell metacharacters, quotes and control characters. */
const FORBIDDEN_IN_IDENTIFIER = /[/;\\$"'|&<>\u0000-\u001f\u007f]/u;

export const harnessOf = (ref: string): Harness => ref.slice(0, ref.indexOf(":")) as Harness;

/** Mastra human_voice.ts: user-role text no human wrote and that says nothing to the model. */
const NOISE_PREFIXES = [
  "<local-command-caveat>", "<local-command-stdout>", "<local-command-stderr>", "<command-name>", "<command-message>",
  "<command-args>", "<bash-input>", "<bash-stdout>", "<bash-stderr>", "<system-reminder>", "Base directory for this skill:",
  "Heartbeat (", "This session is being continued from a previous conversation", "<open_and_recently_viewed_files>",
  "<agent_transcripts>", "<agentmux-system>", "[tool_result",
  // Preambles the Mastra codex/cursor parsers drop before this layer.
  "<plugin_info>", "<system_notification>", "<additional_data>", "<permissions>", "# AGENTS.md instructions",
  "<INSTRUCTIONS>", "<environment_context>",
];
/** User-role text the harness wrote to instruct the model. */
const SYSTEM_PREFIXES = ["<task-notification>", "[Request interrupted by user]", "[Request interrupted by user for tool use]"];
const HOOK_FEEDBACK_FIRST_LINE = /^\S.*\bhook feedback:/;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const object = (value: unknown): Json | undefined => (isRecord(value) ? value : undefined);
const field = (value: unknown, key: string): unknown => object(value)?.[key];

/** The `text` blocks of a message content (a plain string stays itself), joined by newlines. */
function contents(value: unknown, blockTypes: readonly string[] = ["text"]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block: unknown) => {
    const part = object(block);
    return part && blockTypes.includes(String(part.type)) && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

function cleanUserText(text: string): string {
  const wrapped = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (wrapped) return wrapped[1]!.trim();
  return text.replace(/^\s*<timestamp>[^\n]*?<\/timestamp>\s*/i, "").trim();
}

/** What a person asked in user-role text: harness machinery (reminders, hook feedback, command echoes, environment dumps) is not. */
export function humanAsk(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (SYSTEM_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) || HOOK_FEEDBACK_FIRST_LINE.test(trimmed)) return undefined;
  const envDump = (trimmed.includes("<user_info>") || trimmed.includes("<git_status>")) && !trimmed.includes("<user_query>");
  if (envDump || NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return undefined;
  const text = cleanUserText(trimmed);
  return text === "" ? undefined : text;
}

const userTurns = (raw: string): Turn[] => {
  const text = humanAsk(raw);
  return text === undefined ? [] : [{ role: "user", text }];
};
const agentTurns = (raw: string): Turn[] => (raw.trim() === "" ? [] : [{ role: "agent", text: raw.trim() }]);

/** The arguments of a call a harness wrote as an object or as a JSON string; anything else is kept under `raw`. */
function argumentsOf(wire: unknown): Record<string, unknown> {
  if (isRecord(wire)) return { ...wire };
  if (typeof wire !== "string") return {};
  const parsed = parseJson(wire);
  if (isRecord(parsed)) return { ...parsed };
  return wire === "" ? {} : { raw: wire };
}

const callTurn = (id: unknown, name: unknown, input: unknown): Turn => ({
  role: "tool",
  text: "",
  tool_call: { id: string(id) ?? "", name: string(name) ?? "", input: argumentsOf(input) },
});

/** The turns one session-file record holds, by the harness that wrote it. */
export function recordTurns(harness: Harness, record: Json): Turn[] {
  if (harness === "omp" || harness === "pi") {
    if (record.type !== "message") return [];
    const message = object(record.message);
    const content = message?.content;
    if (message?.role === "user") return userTurns(contents(content));
    if (message?.role !== "assistant") return [];
    if (typeof content === "string") return agentTurns(content);
    if (!Array.isArray(content)) return [];
    return content.filter(isRecord).flatMap((block): Turn[] =>
      block.type === "text" ? agentTurns(string(block.text) ?? "")
      : block.type === "toolCall" ? [callTurn(block.id, block.name, block.arguments)]
      : []
    );
  }
  if (harness === "claude") {
    if (record.type !== "user" && record.type !== "assistant") return [];
    const message = object(record.message);
    const role = message?.role;
    if (role !== "user" && role !== "assistant") return [];
    if (record.isSidechain === true) return [];
    const text = contents(message?.content);
    if (record.isMeta === true && !/hook feedback:/i.test(text)) return [];
    if (role === "user") return userTurns(text);
    const content = message?.content;
    if (!Array.isArray(content)) return agentTurns(text);
    return content.filter(isRecord).flatMap((block): Turn[] =>
      block.type === "text" ? agentTurns(string(block.text) ?? "")
      : block.type === "tool_use" ? [callTurn(block.id, block.name, block.input)]
      : []
    );
  }
  if (harness === "grok") {
    if (record.type === "user") {
      if ((string(record.synthetic_reason) ?? "") !== "") return [];
      const content = record.content;
      const raw = typeof content === "string" ? content : Array.isArray(content) ? contents(content) : JSON.stringify(content ?? "");
      return userTurns(raw.replace(SYSTEM_REMINDER, ""));
    }
    if (record.type !== "assistant") return [];
    const content = record.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? contents(content) : "";
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls.filter(isRecord) : [];
    return [...agentTurns(text), ...calls.map((call) => callTurn(call.id, call.name, call.arguments))];
  }
  if (harness === "codex") {
    if (record.type !== "response_item") return [];
    const payload = object(record.payload);
    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
      return [callTurn(payload.call_id, payload.name, payload.arguments ?? payload.input)];
    }
    if (payload?.type !== "message") return [];
    const text = contents(payload.content, ["input_text", "output_text", "text"]);
    if (payload.role === "assistant") return agentTurns(text);
    return payload.role === "user" ? userTurns(text) : [];
  }
  if (harness === "cursor") {
    if (record.role !== "user" && record.role !== "assistant") return [];
    const content = field(record.message, "content");
    const text = contents(content);
    if (record.role === "user") return userTurns(text);
    const calls = Array.isArray(content)
      ? content.flatMap((block, position): Turn[] => {
        if (!isRecord(block) || block.type !== "tool_use") return [];
        const name = string(block.name) ?? "";
        return [callTurn(string(block.id) || `${name}#${position}`, name, block.input)];
      })
      : [];
    return [...agentTurns(text), ...calls];
  }
  if (harness === "copilot") {
    const event = string(record.type) ?? string(record.event);
    const role = event === "user.message" ? "user" : event === "assistant.message" ? "agent" : undefined;
    if (!role) return [];
    const payload = object(record.data) ?? object(record.payload) ?? record;
    const raw = payload.content ?? field(payload.message, "content") ?? payload.message ?? payload.text;
    const text = contents(raw);
    if (role === "user") return userTurns(text);
    const requests = Array.isArray(payload.toolRequests) ? payload.toolRequests.filter(isRecord) : [];
    return [...agentTurns(text), ...requests.map((request) => callTurn(request.toolCallId, request.name, request.arguments))];
  }
  return [];
}

/** agentmux's names for the harnesses a project transcript's lines come from. */
const AGENTMUX_PARSERS: Readonly<Record<string, Harness>> = { "claude-code": "claude", grok: "grok", codex: "codex", cursor: "cursor" };

/** The turns of a JSONL session of `harness`; a line that is not a JSON object is skipped. */
async function readJsonl(harness: Harness, path: string, signal?: AbortSignal): Promise<Turn[]> {
  const turns: Turn[] = [];
  const journal: Json[] = [];
  const input = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      const record = object(parseJson(line));
      if (!record) continue;
      if (harness === "pi" || harness === "omp") {
        // The ancestry walk needs parent links from every entry; only conversation messages need their bodies.
        const role = field(record.message, "role");
        journal.push(record.type === "message" && (role === "user" || role === "assistant") ? record : {
          id: record.id, parentId: record.parentId, type: record.type,
        });
        continue;
      }
      const parser = harness === "agentmux" ? AGENTMUX_PARSERS[string(record._agentmux_source)?.split(":", 1)[0] ?? ""] : harness;
      if (parser !== undefined) turns.push(...recordTurns(parser, record));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  for (const record of harness === "pi" || harness === "omp" ? journalBranch(journal) : []) {
    turns.push(...recordTurns(harness, record));
  }
  return turns;
}

/** OMP and Pi journals are trees, not flat chats. Recover the latest saved leaf's ancestry. */
function journalBranch(records: readonly Json[]): Json[] {
  const indexed = new Map<string, Json>();
  let leaf: string | undefined;
  const legacy: Json[] = [];
  for (const entry of records) {
    if (entry.type === "session" || entry.type === "title") continue;
    const id = string(entry.id);
    if (!id) { legacy.push(entry); continue; }
    indexed.set(id, entry);
    leaf = id;
  }
  if (!leaf) return legacy;
  const branch: Json[] = [];
  const visited = new Set<string>();
  while (leaf && !visited.has(leaf)) {
    visited.add(leaf);
    const entry = indexed.get(leaf);
    if (!entry) break;
    branch.push(entry);
    leaf = string(entry.parentId);
  }
  return branch.reverse();
}

interface Candidate { id: string; path: string; modified: number; title?: string; captured: boolean }

/** Where each harness keeps its sessions, under `home`. */
function storesOf(home: string): Partial<Record<Harness, string>> {
  return {
    agentmux: join(home, ".config/agentmux", "projects"),
    claude: join(home, ".claude/projects"),
    grok: join(home, ".grok/sessions"),
    codex: join(home, ".codex/sessions"),
    cursor: join(home, ".cursor/projects"),
    copilot: join(home, ".copilot/session-state"),
    pi: join(home, ".pi/agent/sessions"),
    omp: join(home, ".omp/agent/sessions"),
  };
}

async function* filesIn(directory: string, depth = 0, signal?: AbortSignal): AsyncGenerator<string> {
  if (depth > 7) return;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    signal?.throwIfAborted();
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesIn(path, depth + 1, signal);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

function candidateId(harness: Harness, path: string): string | undefined {
  const file = basename(path);
  if (harness === "claude") return file.slice(0, -6);
  if (harness === "cursor") return path.includes("/agent-transcripts/") && basename(dirname(path)) === file.slice(0, -6)
    ? file.slice(0, -6) : undefined;
  if (harness === "grok") return file === "chat_history.jsonl" ? basename(dirname(path)) : undefined;
  if (harness === "copilot") return file === "events.jsonl" ? basename(dirname(path)) : undefined;
  if (harness === "codex") return file.match(/rollout-.*?-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
  if (harness === "omp" || harness === "pi") return file.match(/^.+?_([^/]+)\.jsonl$/)?.[1];
  return undefined;
}

async function fileTitle(harness: Harness, path: string): Promise<string | undefined> {
  try {
    if (harness === "grok") {
      const summary = object(parseJson(await readFile(join(dirname(path), "summary.json"), "utf8")));
      return string(summary?.generated_title) ?? string(summary?.session_summary);
    }
    if (harness === "omp" || harness === "pi") {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(4_096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        for (const line of buffer.toString("utf8", 0, bytesRead).split("\n").slice(0, 3)) {
          const title = string(object(parseJson(line))?.title);
          if (title) return title;
        }
      } finally { await file.close(); }
    }
    if (harness === "copilot") {
      const workspace = await readFile(join(dirname(path), "workspace.yaml"), "utf8");
      return workspace.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

async function candidatesFor(harness: Harness, home: string, signal?: AbortSignal): Promise<Candidate[]> {
  const agentmux = join(home, ".config/agentmux");
  const roots: string[] = [];
  const store = storesOf(home)[harness];
  if (store) roots.push(store);
  if (harness !== "agentmux") roots.unshift(join(agentmux, "transcripts"));

  const candidates = new Map<string, Candidate>();
  for (const root of roots) {
    for await (const path of filesIn(root, 0, signal)) {
      const name = basename(path);
      const captured = root.endsWith("/transcripts");
      if (captured && !name.startsWith(`${harness === "claude" ? "claude-code" : harness}.`)) continue;
      if (harness === "agentmux" && name !== "transcript.jsonl") continue;
      const id = harness === "agentmux" ? basename(dirname(path))
        : captured ? name.slice(name.indexOf(".") + 1, -6) : candidateId(harness, path);
      if (!id) continue;
      const info = await stat(path);
      const existing = candidates.get(id);
      if (existing && existing.captured) continue;
      candidates.set(id, { id, path, modified: info.mtimeMs, captured });
    }
  }
  return [...candidates.values()];
}

/** A full id is resolved by direct path lookup instead of walking every session file. */
async function exactCandidate(harness: Harness, id: string, home: string, signal?: AbortSignal): Promise<Candidate | undefined> {
  if (id === "latest" || !/^[0-9A-Za-z][0-9A-Za-z-]{7,}$/.test(id)) return undefined;
  const found = async (path: string, captured: boolean): Promise<Candidate | undefined> => {
    try { return { id, path, modified: (await stat(path)).mtimeMs, captured }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const copy = await found(join(home, ".config/agentmux", "transcripts", `${harness === "claude" ? "claude-code" : harness}.${id}.jsonl`), true);
  if (copy) return copy;
  const store = storesOf(home)[harness];
  if (!store || (harness !== "omp" && harness !== "pi" && harness !== "claude")) return undefined;
  let projects: string[];
  try { projects = await readdir(store); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  for (const project of projects) {
    signal?.throwIfAborted();
    if (harness === "claude") {
      const hit = await found(join(store, project, `${id}.jsonl`), false);
      if (hit) return hit;
      continue;
    }
    let files: string[];
    try { files = await readdir(join(store, project)); } catch { continue; }
    const name = files.find((file) => file.endsWith(`_${id}.jsonl`));
    if (name) return found(join(store, project, name), false);
  }
  return undefined;
}

async function resolveCandidate(harness: Harness, identifier: string, home: string, signal?: AbortSignal): Promise<Candidate> {
  const exact = await exactCandidate(harness, identifier, home, signal);
  if (exact) return exact;
  let candidates = await candidatesFor(harness, home, signal);
  if (!candidates.length) throw new Error(`No ${harness} transcripts found in configured session directories.`);
  if (identifier === "latest" && (harness === "omp" || harness === "pi")) {
    // Subagent transcripts live below the project directory; `latest` means the newest top-level session.
    const topLevel = candidates.filter((c) => c.captured || dirname(dirname(c.path)) === storesOf(home)[harness]);
    if (topLevel.length) candidates = topLevel;
  }
  if (identifier === "latest") {
    if (harness === "grok") {
      const primary: Candidate[] = [];
      for (const candidate of candidates) {
        try {
          const summary = object(parseJson(await readFile(join(dirname(candidate.path), "summary.json"), "utf8")));
          if (summary?.session_kind !== "subagent") primary.push(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          primary.push(candidate);
        }
      }
      if (!primary.length) throw new Error("No top-level Grok sessions found.");
      return primary.sort((a, b) => b.modified - a.modified)[0]!;
    }
    return candidates.sort((a, b) => b.modified - a.modified)[0]!;
  }
  let matches = candidates.filter((candidate) => candidate.id === identifier);
  if (!matches.length) matches = candidates.filter((candidate) => candidate.id.startsWith(identifier));
  if (!matches.length) {
    for (const candidate of candidates) candidate.title = await fileTitle(harness, candidate.path);
    matches = candidates.filter((candidate) => candidate.title?.toLowerCase().includes(identifier.toLowerCase()));
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous ${harness} session '${identifier}': ${matches.slice(0, 10).map((c) => c.id).join(", ")}`);
  throw new Error(`No ${harness} session matched '${identifier}' (${candidates.length} session files checked).`);
}

/** The turns of one Hermes or OpenCode session, read through Bun's bundled read-only SQLite driver. */
async function readDatabase(harness: "hermes" | "opencode", identifier: string, home: string): Promise<Turn[]> {
  const path = harness === "hermes" ? join(home, ".hermes/state.db") : join(home, ".local/share/opencode/opencode.db");
  let db: Database;
  try {
    db = new Database(path, { readonly: true, create: false });
  } catch (error) {
    throw new Error(`cannot open the ${harness} database ${path}: ${(error as Error).message}`);
  }
  try {
    const sessions = (harness === "hermes" ? db.query("SELECT * FROM sessions") : db.query("SELECT * FROM session"))
      .all() as Json[];
    const sorted = sessions
      .filter((row) => identifier !== "latest" || (harness === "hermes"
        ? row.source !== "subagent" && row.archived !== 1 && row.hidden !== 1
        : !row.parent_id))
      .sort((a, b) => Number(b.last_activity_at ?? b.time_updated ?? b.started_at ?? b.created_at ?? 0) -
        Number(a.last_activity_at ?? a.time_updated ?? a.started_at ?? a.created_at ?? 0));
    const matching = identifier === "latest" ? sorted.slice(0, 1) :
      sorted.filter((row) => string(row.id) === identifier || string(row.id)?.startsWith(identifier) ||
        string(row.title)?.toLowerCase().includes(identifier.toLowerCase()));
    if (matching.length !== 1) throw new Error(`${matching.length ? "Ambiguous" : "Unknown"} ${harness} session '${identifier}'.`);
    const id = string(matching[0]?.id)!;
    const turns: Turn[] = [];
    if (harness === "hermes") {
      const messages = db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid").all(id) as Json[];
      for (const message of messages) {
        if (message.active === 0 || message.active === false ||
          (message.display_kind && message.display_kind !== "steer")) continue;
        const role = message.role;
        if (role !== "user" && role !== "assistant") continue;
        const raw = typeof message.content === "string" ? (parseJson(message.content) ?? message.content) : message.content;
        if (role === "user") { turns.push(...userTurns(contents(raw))); continue; }
        turns.push(...agentTurns(contents(raw)));
        const calls = parseJson(string(message.tool_calls) ?? "");
        for (const call of Array.isArray(calls) ? calls.filter(isRecord) : []) {
          const fn = object(call.function) ?? call;
          turns.push(callTurn(string(call.id) ?? call.call_id, string(fn.name) ?? call.name, fn.arguments ?? call.arguments));
        }
      }
    } else {
      const messages = db.query("SELECT * FROM message WHERE session_id = ? ORDER BY rowid").all(id) as Json[];
      const parts = db.query("SELECT * FROM part WHERE message_id = ? ORDER BY rowid");
      for (const message of messages) {
        const data = object(parseJson(string(message.data) ?? "")) ?? object(message.data);
        const role = data?.role ?? message.role;
        if (role !== "user" && role !== "assistant") continue;
        for (const part of parts.all(message.id as string) as Json[]) {
          const partData = object(parseJson(string(part.data) ?? "")) ?? object(part.data);
          if (partData?.type === "text" && typeof partData.text === "string") {
            turns.push(...(role === "assistant" ? agentTurns(partData.text) : userTurns(partData.text)));
          } else if (partData?.type === "tool") {
            turns.push(callTurn(partData.callID, partData.tool, field(partData.state, "input")));
          }
        }
      }
    }
    return turns;
  } finally {
    db.close();
  }
}

/** The turns of `<harness>:<identifier>` read from the session stores under `home`, oldest first. */
export async function readTurns(harness: Harness, identifier: string, home: string, signal?: AbortSignal): Promise<Turn[]> {
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    throw new Error(`transcript: "${harness}" is not a conversation harness; use one of ${HARNESSES.join(", ")}`);
  }
  if (identifier === "" || FORBIDDEN_IN_IDENTIFIER.test(identifier) || identifier.trim() !== identifier || identifier.includes("..")) {
    throw new Error(`transcript: session identifier "${identifier}" is empty, has a character that is not allowed, or starts or ends with a space`);
  }
  if (harness === "hermes" || harness === "opencode") return readDatabase(harness, identifier, home);
  const candidate = await resolveCandidate(harness, identifier, home, signal);
  return readJsonl(harness, candidate.path, signal);
}

/** The reader the tool uses: the session stores under `home`. */
export function conversationReaderFor(home: string): ConversationReader {
  return (harness, identifier, signal) => readTurns(harness as Harness, identifier, home, signal);
}
