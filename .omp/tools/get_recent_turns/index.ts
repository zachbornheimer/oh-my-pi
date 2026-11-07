
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

/**
 * Native get_recent_turns custom tool for oh-my-pi (port of the Mastra `get_recent_turns` workflow).
 *
 * Install: ~/.omp/agent/tools/get_recent_turns/index.ts. Call with {} for the active branch, or
 * { conversation: "claude:latest" } to read a local session. Hermes and OpenCode use Bun's bundled read-only
 * SQLite driver. Not supported (the Mastra version has them): Mastra threads, Codex .jsonl.zst, Cursor's legacy
 * store.db, Grok compaction summaries, the Neon fleet fallback, and tool-call turns.
 * Same defaults, clipping, token estimate and output as Mastra; for omp/pi it reads the active branch only.
 */
type Speaker = "user" | "agent" | "system";
type Harness = "omp" | "pi" | "claude" | "grok" | "codex" | "cursor" | "copilot" | "agentmux" | "hermes" | "opencode";
type Format = "json" | "text";

type JsonObject = Record<string, unknown>;
interface Message { from: Speaker; timestamp: string | null; content: string; truncated?: boolean }
interface ConversationTurn { id: number; messages: Message[] }
interface Bounds { turns: number; lengthLimit: number; maxTokens: number }
interface Transcript {
  conversation: string;
  harness: Harness;
  path: string;
  skippedLines: number;
  turns: ConversationTurn[];
  totalTurns: number;
}
interface Candidate { id: string; path: string; modified: number; title?: string; captured: boolean }
interface Selection {
  turns: ConversationTurn[];
  estimated_tokens: number;
  over_max_tokens: boolean;
  dropped: { turns_for_limit: number; turns_beyond_count: number };
}

const DEFAULTS: Bounds = { turns: 16, lengthLimit: 3_000, maxTokens: 12_000 };
/** Mastra's SESSION_IDENTIFIER: anything but shell/path/query metacharacters and control characters. */
const FORBIDDEN_IN_IDENTIFIER = /[/;\\$"'|&<>\u0000-\u001f\u007f]/u;
const HARNESSES = new Set<Harness>(["omp", "pi", "claude", "grok", "codex", "cursor", "copilot", "agentmux", "hermes", "opencode"]);
/** `$HOME` first (Bun's `homedir()` ignores a changed `$HOME`), so a test can point the tool at a scratch home. */
const HOME = process.env.HOME || homedir();
const AGENTMUX = join(HOME, ".config/agentmux");
const STORES: Partial<Record<Harness, string>> = {
  agentmux: join(AGENTMUX, "projects"),
  claude: join(HOME, ".claude/projects"),
  grok: join(HOME, ".grok/sessions"),
  codex: join(HOME, ".codex/sessions"),
  cursor: join(HOME, ".cursor/projects"),
  copilot: join(HOME, ".copilot/session-state"),
  pi: join(HOME, ".pi/agent/sessions"),
  omp: join(HOME, ".omp/agent/sessions"),
};

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

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function field(value: unknown, key: string): unknown {
  return object(value)?.[key];
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function contents(value: unknown, blockTypes: readonly string[] = ["text"]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block: unknown) => {
    const part = object(block);
    return part && blockTypes.includes(String(part.type)) && typeof part.text === "string"
      ? [part.text]
      : [];
  }).join("\n");
}

function timestamp(value: unknown, epochUnit: "seconds" | "milliseconds" = "milliseconds"): string | null {
  if (typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = epochUnit === "seconds" ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  }
  return null;
}

function cleanUserText(text: string): string {
  const wrapped = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (wrapped) return wrapped[1]!.trim();
  return text.replace(/^\s*<timestamp>[^\n]*?<\/timestamp>\s*/i, "").trim();
}

function speaker(role: "user" | "agent", raw: string, time: string | null, synthetic = false): Message | undefined {
  if (synthetic) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (role === "agent") return { from: "agent", timestamp: time, content: trimmed };

  // Mastra order: system first, then noise and unwrapped env dumps, else the human.
  if (SYSTEM_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) || HOOK_FEEDBACK_FIRST_LINE.test(trimmed)) {
    return { from: "system", timestamp: time, content: trimmed };
  }
  const envDump = (trimmed.includes("<user_info>") || trimmed.includes("<git_status>")) && !trimmed.includes("<user_query>");
  if (envDump || NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return undefined;
  const text = cleanUserText(trimmed);
  return text ? { from: "user", timestamp: time, content: text } : undefined;
}

function spokenFromRecord(harness: Harness, record: JsonObject): Message | undefined {
  if (harness === "omp" || harness === "pi") {
    if (record.type !== "message") return undefined;
    const message = object(record.message);
    const role = message?.role;
    if (role !== "user" && role !== "assistant") return undefined;
    return speaker(role === "assistant" ? "agent" : "user", contents(message?.content), timestamp(record.timestamp));
  }
  if (harness === "claude") {
    if (record.type !== "user" && record.type !== "assistant") return undefined;
    const message = object(record.message);
    const role = message?.role;
    if (role !== "user" && role !== "assistant") return undefined;
    const text = contents(message?.content);
    if (record.isSidechain === true) return undefined;
    if (record.isMeta === true && !/hook feedback:/i.test(text)) return undefined;
    return speaker(role === "assistant" ? "agent" : "user", text, timestamp(record.timestamp));
  }
  if (harness === "grok") {
    if (record.type !== "user" && record.type !== "assistant") return undefined;
    return speaker(record.type === "user" ? "user" : "agent", contents(record.content), timestamp(record.timestamp),
      typeof record.synthetic_reason === "string" && record.synthetic_reason !== "");
  }
  if (harness === "codex") {
    if (record.type !== "response_item") return undefined;
    const payload = object(record.payload);
    if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) return undefined;
    return speaker(payload.role === "assistant" ? "agent" : "user",
      contents(payload.content, ["input_text", "output_text"]), timestamp(record.timestamp));
  }
  if (harness === "cursor") {
    if (record.role !== "user" && record.role !== "assistant") return undefined;
    return speaker(record.role === "assistant" ? "agent" : "user",
      contents(field(record.message, "content")), timestamp(record.timestamp));
  }
  if (harness === "copilot") {
    const event = string(record.type) ?? string(record.event);
    const role = event === "user.message" ? "user" : event === "assistant.message" ? "agent" : undefined;
    if (!role) return undefined;
    const payload = object(record.data) ?? object(record.payload) ?? record;
    const raw = payload.content ?? field(payload.message, "content") ?? payload.message ?? payload.text;
    return speaker(role, contents(raw), timestamp(record.timestamp));
  }
  return undefined;
}

/** Bound retained history, preserving whole-conversation turn IDs and interleaved sessions. */
class TurnCollector {
  readonly turns: ConversationTurn[] = [];
  readonly openBySession = new Map<string, ConversationTurn>();
  private readonly retained = new Set<ConversationTurn>();
  totalTurns = 0;
  private readonly maxTurns: number;
  constructor(maxTurns: number) { this.maxTurns = maxTurns; }

  append(message: Message, session = ""): void {
    let current = this.openBySession.get(session);
    if (!current || message.from === "user") {
      current = { id: ++this.totalTurns, messages: [] };
      this.openBySession.set(session, current);
      this.turns.push(current);
      this.retained.add(current);
      if (this.turns.length > this.maxTurns) {
        const removed = this.turns.shift()!;
        this.retained.delete(removed);
        // An evicted turn may remain open in an interleaved source. Do not keep accumulating its content.
        removed.messages = [];
      }
    }
    if (this.retained.has(current)) current.messages.push(message);
  }
}

function selectTurns(transcript: Transcript, bounds: Bounds): Selection {
  const turns = transcript.turns.map((turn) => ({
    id: turn.id,
    messages: turn.messages.map((message) => {
      const runes = Array.from(message.content);
      const truncated = runes.length > bounds.lengthLimit;
      return {
        ...message,
        content: truncated ? `${runes.slice(0, bounds.lengthLimit).join("").trim()} …` : message.content,
        truncated,
      };
    }),
  }));
  const lengths = turns.map((turn) => turn.messages.reduce((sum, message) => sum + Array.from(message.content).length, 0));
  let characters = lengths.reduce((sum, length) => sum + length, 0);
  let drop = 0;
  while (drop < turns.length - 1 && Math.ceil(characters / 4) > bounds.maxTokens) {
    characters -= lengths[drop]!;
    drop++;
  }
  const estimated_tokens = Math.ceil(characters / 4);
  return {
    turns: turns.slice(drop),
    estimated_tokens,
    over_max_tokens: estimated_tokens > bounds.maxTokens,
    dropped: { turns_for_limit: drop, turns_beyond_count: transcript.totalTurns - transcript.turns.length },
  };
}

/** OMP and Pi journals are trees, not flat chats. Recover the latest saved leaf's ancestry. */
function journalBranch(records: readonly JsonObject[]): JsonObject[] {
  const indexed = new Map<string, JsonObject>();
  let leaf: string | undefined;
  const legacy: JsonObject[] = [];
  for (const entry of records) {
    if (entry.type === "session" || entry.type === "title") continue;
    const id = string(entry.id);
    if (!id) { legacy.push(entry); continue; }
    indexed.set(id, entry);
    leaf = id;
  }
  if (!leaf) return legacy;
  const branch: JsonObject[] = [];
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

function fromBranch(entries: readonly JsonObject[], conversation: string, path: string, bounds: Bounds): Transcript {
  const collector = new TurnCollector(bounds.turns);
  for (const entry of entries) {
    const spoken = spokenFromRecord("omp", entry);
    if (spoken) collector.append(spoken);
  }
  return {
    conversation, harness: "omp", path, skippedLines: 0,
    turns: collector.turns, totalTurns: collector.totalTurns,
  };
}

async function* jsonLines(path: string, signal?: AbortSignal): AsyncGenerator<unknown> {
  const input = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      yield parseJson(line);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function readJsonl(harness: Harness, candidate: Candidate, bounds: Bounds, signal?: AbortSignal): Promise<Transcript> {
  const collector = new TurnCollector(bounds.turns);
  const journal: JsonObject[] = [];
  let skippedLines = 0;
  for await (const raw of jsonLines(candidate.path, signal)) {
    const record = object(raw);
    if (!record) { skippedLines++; continue; }
    if (harness === "pi" || harness === "omp") {
      // The ancestry walk needs parent links from every entry; only conversation messages need their bodies.
      const role = field(record.message, "role");
      journal.push(record.type === "message" && (role === "user" || role === "assistant") ? record : {
        id: record.id, parentId: record.parentId, type: record.type,
      });
      continue;
    }
    const source = harness === "agentmux" ? string(record._agentmux_source) : undefined;
    const [sourceHarness, sourceId] = source?.split(":", 2) ?? [];
    const parser: Harness = harness === "agentmux"
      ? sourceHarness === "claude-code" ? "claude" : HARNESSES.has(sourceHarness as Harness) ? sourceHarness as Harness : "agentmux"
      : harness;
    const spoken = spokenFromRecord(parser, record);
    if (spoken) collector.append(spoken, harness === "agentmux" ? source ?? `${parser}:${sourceId ?? ""}` : "");
  }
  if (harness === "pi" || harness === "omp") {
    for (const record of journalBranch(journal)) {
      const spoken = spokenFromRecord(harness, record);
      if (spoken) collector.append(spoken);
    }
  }
  return {
    conversation: `${harness}:${candidate.id}`, harness, path: candidate.path,
    skippedLines, turns: collector.turns, totalTurns: collector.totalTurns,
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

async function candidatesFor(harness: Harness, signal?: AbortSignal): Promise<Candidate[]> {
  const roots: string[] = [];
  const store = STORES[harness];
  if (store) roots.push(store);
  if (harness !== "agentmux") roots.unshift(join(AGENTMUX, "transcripts"));

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

/** A full id is resolved by direct path lookup, as Mastra's locateJsonl does, instead of walking every session file. */
async function exactCandidate(harness: Harness, id: string, signal?: AbortSignal): Promise<Candidate | undefined> {
  if (id === "latest" || !/^[0-9A-Za-z][0-9A-Za-z-]{7,}$/.test(id)) return undefined;
  const found = async (path: string, captured: boolean): Promise<Candidate | undefined> => {
    try { return { id, path, modified: (await stat(path)).mtimeMs, captured }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const copy = await found(join(AGENTMUX, "transcripts", `${harness === "claude" ? "claude-code" : harness}.${id}.jsonl`), true);
  if (copy) return copy;
  const store = STORES[harness];
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

async function resolveCandidate(harness: Harness, identifier: string, signal?: AbortSignal): Promise<Candidate> {
  const exact = await exactCandidate(harness, identifier, signal);
  if (exact) return exact;
  let candidates = await candidatesFor(harness, signal);
  if (!candidates.length) throw new Error(`No ${harness} transcripts found in configured session directories.`);
  if (identifier === "latest" && (harness === "omp" || harness === "pi")) {
    // Subagent transcripts live below the project directory; `latest` means the newest top-level session.
    const topLevel = candidates.filter((c) => c.captured || dirname(dirname(c.path)) === STORES[harness]);
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

/** Use Bun's bundled SQLite driver for the two database-backed harnesses. */
async function readDatabase(harness: "hermes" | "opencode", identifier: string, bounds: Bounds): Promise<Transcript> {
  const path = harness === "hermes" ? join(HOME, ".hermes/state.db") : join(HOME, ".local/share/opencode/opencode.db");
  const moduleName = "bun:sqlite";
  const sqlite = await import(moduleName);
  const db = new sqlite.Database(path, { readonly: true, create: false });
  try {
    const sessions = (harness === "hermes"
      ? db.query("SELECT * FROM sessions").all()
      : db.query("SELECT * FROM session").all()) as JsonObject[];
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
    const collector = new TurnCollector(bounds.turns);
    if (harness === "hermes") {
      const messages = db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid").all(id) as JsonObject[];
      for (const message of messages) {
        if (message.active === 0 || message.active === false ||
          (message.display_kind && message.display_kind !== "steer")) continue;
        const role = message.role;
        if (role !== "user" && role !== "assistant") continue;
        const raw = typeof message.content === "string" ? (parseJson(message.content) ?? message.content) : message.content;
        const spoken = speaker(role === "assistant" ? "agent" : "user", contents(raw), timestamp(message.timestamp, "seconds"));
        if (spoken) collector.append(spoken);
      }
    } else {
      const messages = db.query("SELECT * FROM message WHERE session_id = ? ORDER BY rowid").all(id) as JsonObject[];
      const parts = db.query("SELECT * FROM part WHERE message_id = ? ORDER BY rowid");
      for (const message of messages) {
        const data = object(parseJson(string(message.data) ?? "")) ?? object(message.data);
        const role = data?.role ?? message.role;
        if (role !== "user" && role !== "assistant") continue;
        const blocks = (parts.all(message.id) as JsonObject[]).flatMap((part) => {
          const partData = object(parseJson(string(part.data) ?? "")) ?? object(part.data);
          return partData?.type === "text" && typeof partData.text === "string" ? [partData.text] : [];
        });
        const spoken = speaker(role === "assistant" ? "agent" : "user", blocks.join("\n"),
          timestamp(message.time_created ?? field(data?.time, "created")));
        if (spoken) collector.append(spoken);
      }
    }
    return { conversation: `${harness}:${id}`, harness, path, skippedLines: 0,
      turns: collector.turns, totalTurns: collector.totalTurns };
  } finally {
    db.close();
  }
}

function parseReference(input: string): { harness: Harness; id: string } {
  const colon = input.indexOf(":");
  const harness = input.slice(0, colon) as Harness;
  const id = input.slice(colon + 1);
  if (colon < 1 || !HARNESSES.has(harness) || !id || FORBIDDEN_IN_IDENTIFIER.test(id) || id.trim() !== id || id.includes("..")) {
    throw new Error("Expected <harness>:<session id|prefix|latest|title>, using omp, pi, claude, grok, codex, cursor, copilot, agentmux, hermes or opencode.");
  }
  return { harness, id };
}

function render(turns: readonly ConversationTurn[]): string {
  return turns.flatMap((turn) => turn.messages.map((message) => {
    const time = message.timestamp === null ? "" : ` (${message.timestamp})`;
    const cut = message.truncated ? " [cut]" : "";
    return `[turn ${turn.id}] ${message.from}${time}: ${message.content.replace(/\s*\n\s*/g, " ")}${cut}`;
  })).join("\n");
}

const DESCRIPTION = [
  "Read the newest turns of the current omp branch or of a local harness session as a bounded conversation excerpt. Use it to recall what was said earlier in this or another session; `get_annotated_transcript` annotates a whole session and `create_session_handoff_doc` writes a takeover note.",
  'Input `{"conversation":"claude:latest","turns":16,"length_limit":3000,"max_tokens":12000,"format":"json"}`; every field is optional. Omit `conversation` for the active omp branch; otherwise `<harness>:<id|id prefix|latest|title words>` with harness omp, pi, claude, grok, codex, cursor, copilot, agentmux, hermes or opencode (an ambiguous or unknown session is refused, naming candidates).',
  "A turn opens with a user message and holds the replies after it. Harness noise (hooks, reminders, environment dumps) is dropped; interruptions and hook feedback come back as `system`.",
  "Keeps the newest `turns`, cuts each message to `length_limit` characters (`truncated`, `[cut]` in text), then drops the oldest turns until the estimate (characters / 4) fits `max_tokens`; the newest turn is always kept, so `over_max_tokens` is true when it alone is too big.",
  "`format` `text` renders `[turn N] from (time): text` lines instead of JSON.",
  "Read-only, no model call. NOT read: tool calls and results, Mastra chat threads, Codex `.jsonl.zst`, Cursor's legacy `store.db`, Grok compaction summaries.",
  "Returns `{conversation, harness, turns, estimated_tokens, over_max_tokens, dropped:{turns_for_limit,turns_beyond_count}, source:{path,total_turns,skipped_lines}}`.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  // pi.zod (omptype) has no .nullish(); models sometimes send null for an unused field.
  const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional();

  return {
    name: "get_recent_turns",
    label: "Recent conversation turns",
    description: DESCRIPTION,
    parameters: z.object({
      conversation: z.string().nullable().optional().describe("Omit for active OMP branch; otherwise <harness>:<session id|prefix|latest|title>."),
      turns: positiveInteger.describe("Number of newest conversation turns (default 16)."),
      length_limit: positiveInteger.describe("Unicode characters per message (default 3000)."),
      max_tokens: positiveInteger.describe("Estimated token budget (default 12000)."),
      format: z.enum(["json", "text"]).optional(),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      signal?.throwIfAborted();
      const bounds: Bounds = {
        turns: params.turns ?? DEFAULTS.turns,
        lengthLimit: params.length_limit ?? DEFAULTS.lengthLimit,
        maxTokens: params.max_tokens ?? DEFAULTS.maxTokens,
      };
      const active = `omp:${ctx.sessionManager.getSessionId()}`;
      const reference = params.conversation ?? active;
      const { harness, id } = parseReference(reference);
      let transcript: Transcript;
      if (reference === active) {
        transcript = fromBranch(ctx.sessionManager.getBranch() as unknown as JsonObject[], active,
          ctx.sessionManager.getSessionFile() ?? "<in-memory session>", bounds);
      } else if (harness === "hermes" || harness === "opencode") {
        transcript = await readDatabase(harness, id, bounds);
      } else {
        const candidate = await resolveCandidate(harness, id, signal);
        transcript = await readJsonl(harness, candidate, bounds, signal);
      }
      signal?.throwIfAborted();
      const selected = selectTurns(transcript, bounds);
      const output = {
        conversation: transcript.conversation,
        harness: transcript.harness,
        turns: selected.turns,
        estimated_tokens: selected.estimated_tokens,
        over_max_tokens: selected.over_max_tokens,
        dropped: selected.dropped,
        source: { path: transcript.path, total_turns: transcript.totalTurns, skipped_lines: transcript.skippedLines },
      };
      return {
        content: [{ type: "text", text: params.format === "text" ? render(output.turns) : JSON.stringify(output) }],
        details: output,
      };
    },
  };
};

export default factory;
