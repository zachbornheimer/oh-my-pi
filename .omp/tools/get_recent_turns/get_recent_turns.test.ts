import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadZod } from "./zod_for_tests.js";

// The tool reads `$HOME` once, when it loads, so it cannot be imported statically: point $HOME at a scratch home for the
// import (a runtime-ordered module load, the case the dynamic-import rule allows), then put the real one back.
const home = mkdtempSync(join(tmpdir(), "get-recent-turns-"));
const realHome = process.env.HOME;
process.env.HOME = home;
const { default: factory } = await import("./index.js");
process.env.HOME = realHome;

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const put = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const jsonl = (...records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

interface Out {
  conversation: string;
  harness: string;
  turns: { id: number; messages: { from: string; timestamp: string | null; content: string; truncated?: boolean }[] }[];
  estimated_tokens: number;
  over_max_tokens: boolean;
  dropped: { turns_for_limit: number; turns_beyond_count: number };
  source: { path: string; total_turns: number; skipped_lines: number };
}

interface Session {
  getSessionId(): string;
  getBranch(): unknown[];
  getSessionFile(): string | undefined;
}

async function call(params: Record<string, unknown>, session?: Session): Promise<{ text: string; out: Out }> {
  const tool = factory({ zod: await loadZod() } as never) as unknown as {
    execute(id: string, params: unknown, onUpdate: undefined, ctx: unknown, signal: undefined): Promise<{
      content: { text: string }[];
      details: Out;
    }>;
  };
  const ctx = { sessionManager: session ?? { getSessionId: () => "active-1", getBranch: () => [], getSessionFile: () => undefined } };
  const result = await tool.execute("call-1", params, undefined, ctx, undefined);
  return { text: result.content[0]!.text, out: result.details };
}

beforeAll(() => {
  put(join(home, ".config/agentmux/transcripts/claude-code.claude-fixture-1.jsonl"), fixture("claude.jsonl"));
  put(join(home, ".config/agentmux/transcripts/grok.grok-fixture-0001.jsonl"), fixture("grok.jsonl"));
  put(join(home, ".config/agentmux/transcripts/codex.codex-fixture-0001.jsonl"), fixture("codex.jsonl"));
  put(join(home, ".config/agentmux/transcripts/claude-code.hook-feedback-1.jsonl"), fixture("claude-hook-feedback.jsonl"));
  put(join(home, ".cursor/projects/app/agent-transcripts/cursor-fixture-1/cursor-fixture-1.jsonl"), fixture("cursor.jsonl"));
  put(join(home, ".config/agentmux/projects/project-one/transcript.jsonl"), fixture("agentmux-project.jsonl"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const EVERYTHING = 1_000_000;
interface Excerpt {
  unclipped: { role: "user" | "agent"; text: string }[];
  clipped_to_1000: { role: "user" | "agent"; text: string }[];
}
const excerptOf = (name: string): Excerpt => JSON.parse(fixture(`${name}.agentmux-excerpt.json`)) as Excerpt;

describe("agentmux's conversationExcerpt is the reference for the three captured fixtures", () => {
  it.each([
    ["claude", "claude-fixture-1", "claude"],
    ["grok", "grok-fixture-0001", "grok"],
    ["codex", "codex-fixture-0001", "codex"],
  ])("%s: the same messages in the same order when nothing is clipped", async (harness, id, name) => {
    const { out } = await call({ conversation: `${harness}:${id}`, turns: EVERYTHING, length_limit: EVERYTHING, max_tokens: EVERYTHING });
    const kept = out.turns.flatMap((turn) =>
      turn.messages.filter((message) => message.from !== "system").map((message) => ({ role: message.from, text: message.content })),
    );
    expect(kept).toEqual(excerptOf(name).unclipped);
    expect(kept.length).toBeGreaterThan(5);
    expect(out.conversation).toBe(`${harness}:${id}`);
  });

  it.each([
    ["claude", "claude-fixture-1"],
    ["grok", "grok-fixture-0001"],
    ["codex", "codex-fixture-0001"],
  ])("%s: clips every user message to 1000 characters as agentmux does", async (harness, id) => {
    const { out } = await call({ conversation: `${harness}:${id}`, turns: EVERYTHING, length_limit: 1000, max_tokens: EVERYTHING });
    const users = out.turns.flatMap((turn) => turn.messages.filter((message) => message.from === "user").map((m) => m.content));
    expect(users).toEqual(excerptOf(harness).clipped_to_1000.filter((message) => message.role === "user").map((m) => m.text));
    expect(out.turns.some((turn) => turn.messages.some((message) => message.truncated))).toBe(true);
  });
});

describe("speakers and turns", () => {
  it("lands hook feedback and an interruption as system messages inside the turn they happened in, with the recorded times", async () => {
    const { out } = await call({ conversation: "claude:hook-feedback-1", turns: EVERYTHING, length_limit: EVERYTHING, max_tokens: EVERYTHING });
    expect(out.turns.map((turn) => turn.id)).toEqual([1, 2]);
    expect(out.turns[0]!.messages).toEqual([
      { from: "user", timestamp: "2026-10-14T04:50:01Z", content: "user message 1.", truncated: false },
      { from: "agent", timestamp: "2026-10-14T04:50:02Z", content: "assistant message 1.", truncated: false },
      { from: "system", timestamp: "2026-10-14T04:50:03Z", content: "Stop hook feedback:\nhook feedback message 1.", truncated: false },
      { from: "agent", timestamp: "2026-10-14T04:50:04Z", content: "assistant message 2.", truncated: false },
      { from: "system", timestamp: "2026-10-14T04:50:05Z", content: "[Request interrupted by user]", truncated: false },
    ]);
    expect(out.turns[1]!.messages.map((message) => message.from)).toEqual(["user", "agent"]);
  });

  it("drops noise a human did not write and unwraps Cursor's <user_query>", async () => {
    const { out } = await call({ conversation: "cursor:cursor-fixture-1", turns: EVERYTHING, length_limit: EVERYTHING, max_tokens: EVERYTHING });
    const texts = out.turns.flatMap((turn) => turn.messages.map((message) => message.content));
    expect(texts[0]).toBe("user message 1.");
    expect(texts.every((text) => !text.includes("<timestamp>") && !text.includes("<user_info>"))).toBe(true);
  });

  it("agentmux project: each line is read as the harness that wrote it, and interleaved sessions stay in separate turns", async () => {
    const { out } = await call({ conversation: "agentmux:project-one", turns: EVERYTHING, length_limit: EVERYTHING, max_tokens: EVERYTHING });
    expect(out.harness).toBe("agentmux");
    expect(out.turns.length).toBeGreaterThan(2);
    expect(out.source.skipped_lines).toBe(0);
  });
});

describe("bounds", () => {
  const long = "x".repeat(50);
  beforeAll(() => {
    const records = Array.from({ length: 6 }, (_, index) => [
      { type: "user", timestamp: `2026-10-20T10:0${index}:00Z`, message: { role: "user", content: `ask ${index} ${long}` } },
      { type: "assistant", timestamp: `2026-10-20T10:0${index}:30Z`, message: { role: "assistant", content: [{ type: "text", text: `reply ${index}` }] } },
    ]).flat();
    put(join(home, ".config/agentmux/transcripts/claude-code.bounds-0001.jsonl"), jsonl(...records));
  });

  it("keeps the newest turns, counts the rest, and keeps whole-transcript turn ids", async () => {
    const { out } = await call({ conversation: "claude:bounds-0001", turns: 2 });
    expect(out.turns.map((turn) => turn.id)).toEqual([5, 6]);
    expect(out.dropped).toEqual({ turns_for_limit: 0, turns_beyond_count: 4 });
    expect(out.source.total_turns).toBe(6);
  });

  it("cuts each message to length_limit characters, marks it, and says so in the text rendering", async () => {
    const { out, text } = await call({ conversation: "claude:bounds-0001", turns: 1, length_limit: 10, format: "text" });
    const user = out.turns[0]!.messages[0]!;
    expect(user.truncated).toBe(true);
    expect(user.content.endsWith(" …")).toBe(true);
    expect(text).toContain("[turn 6] user (2026-10-20T10:05:00Z): ask 5 xxxx … [cut]");
    expect(text).toContain("[turn 6] agent (2026-10-20T10:05:30Z): reply 5");
  });

  it("drops the oldest turns until the estimate fits max_tokens, and keeps one turn that is over by itself", async () => {
    const fit = await call({ conversation: "claude:bounds-0001", max_tokens: 40 });
    expect(fit.out.dropped.turns_for_limit).toBeGreaterThan(0);
    expect(fit.out.estimated_tokens).toBeLessThanOrEqual(40);
    expect(fit.out.over_max_tokens).toBe(false);
    const single = await call({ conversation: "claude:bounds-0001", max_tokens: 1 });
    expect(single.out.turns).toHaveLength(1);
    expect(single.out.over_max_tokens).toBe(true);
  });

  it("estimates tokens as characters divided by four, rounded up", async () => {
    const { out } = await call({ conversation: "claude:bounds-0001", turns: 1 });
    const characters = out.turns.flatMap((turn) => turn.messages).reduce((sum, message) => sum + Array.from(message.content).length, 0);
    expect(out.estimated_tokens).toBe(Math.ceil(characters / 4));
  });

  it("treats null limits as the defaults", async () => {
    const { out } = await call({ conversation: "claude:bounds-0001", turns: null, length_limit: null, max_tokens: null });
    expect(out.turns).toHaveLength(6);
  });
});

describe("finding a session", () => {
  beforeAll(() => {
    put(join(home, ".omp/agent/sessions/-proj/2026-10-20T10-00-00-000Z_aaaa1111-0000-0000-0000-000000000001.jsonl"),
      jsonl({ type: "session", id: "aaaa1111", cwd: "/p" },
        { type: "title", title: "Fix the flaky login test" },
        { type: "message", id: "m1", parentId: null, timestamp: "2026-10-20T10:00:01Z", message: { role: "user", content: "first session" } }));
    put(join(home, ".omp/agent/sessions/-proj/2026-10-20T11-00-00-000Z_aaaa1111-0000-0000-0000-000000000002.jsonl"),
      jsonl({ type: "session", id: "aaaa1111", cwd: "/p" },
        { type: "message", id: "m1", parentId: null, timestamp: "2026-10-20T11:00:01Z", message: { role: "user", content: "second session" } }));
  });

  it("a full id is read directly", async () => {
    const { out } = await call({ conversation: "omp:aaaa1111-0000-0000-0000-000000000002" });
    expect(out.turns[0]!.messages[0]!.content).toBe("second session");
  });

  it("an id prefix shared by two sessions is refused, naming them", async () => {
    await expect(call({ conversation: "omp:aaaa1111" })).rejects.toThrow(/Ambiguous omp session 'aaaa1111'.*000000000001.*000000000002/);
  });

  it("title words find the one session whose title holds them", async () => {
    const { out } = await call({ conversation: "omp:flaky login" });
    expect(out.turns[0]!.messages[0]!.content).toBe("first session");
  });

  it("an unknown session is refused with the number of files checked", async () => {
    await expect(call({ conversation: "omp:no-such-session-here" })).rejects.toThrow(/No omp session matched/);
  });

  it("latest takes the newest top-level session", async () => {
    const newest = join(home, ".omp/agent/sessions/-proj/2026-10-20T11-00-00-000Z_aaaa1111-0000-0000-0000-000000000002.jsonl");
    const later = new Date(Date.now() + 60_000);
    // Make the second session the most recently written one.
    utimesSync(newest, later, later);
    const { out } = await call({ conversation: "omp:latest" });
    expect(out.turns[0]!.messages[0]!.content).toBe("second session");
  });

  it("refuses a reference with no harness, an unknown harness, or a character a path or shell would use", async () => {
    for (const bad of ["just-an-id", "nope:abc12345", "claude:a/b", "claude:a;b", "claude:..", "claude: spaced "]) {
      await expect(call({ conversation: bad })).rejects.toThrow(/Expected <harness>:<session id/);
    }
  });
});

describe("the active omp branch", () => {
  const entries = [
    { type: "session", id: "root" },
    { type: "message", id: "a", parentId: null, timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2026-10-20T10:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }, { type: "thinking", text: "hidden" }] } },
    { type: "message", id: "c", parentId: "b", timestamp: "2026-10-20T10:00:10Z", message: { role: "user", content: "<system-reminder>noise</system-reminder>" } },
  ];
  const session: Session = { getSessionId: () => "sess-1", getBranch: () => entries, getSessionFile: () => "/tmp/sess-1.jsonl" };

  it("reads the live branch when conversation is omitted, with no file lookup", async () => {
    const { out } = await call({}, session);
    expect(out.conversation).toBe("omp:sess-1");
    expect(out.source.path).toBe("/tmp/sess-1.jsonl");
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.messages.map((message) => [message.from, message.content])).toEqual([["user", "hello"], ["agent", "hi there"]]);
  });

  it("reads the live branch when conversation names the active session", async () => {
    const { out } = await call({ conversation: "omp:sess-1" }, session);
    expect(out.turns[0]!.messages).toHaveLength(2);
  });
});

describe("databases", () => {
  it("hermes: reads the row's Unix-seconds timestamp, skips inactive and non-conversation rows", async () => {
    const path = join(home, ".hermes/state.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, archived INTEGER, hidden INTEGER, last_activity_at REAL)");
    db.run("CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER, display_kind TEXT)");
    db.run("INSERT INTO sessions VALUES ('h1', 'Hermes chat', 'cli', 0, 0, 1792415700)");
    db.run("INSERT INTO messages VALUES ('h1','user','ask',1792415639.45327,1,NULL)");
    db.run("INSERT INTO messages VALUES ('h1','assistant','reply',1792415677.8215,1,NULL)");
    db.run("INSERT INTO messages VALUES ('h1','assistant','no time',NULL,1,NULL)");
    db.run("INSERT INTO messages VALUES ('h1','assistant','retracted',1792415680,0,NULL)");
    db.run("INSERT INTO messages VALUES ('h1','tool','ls output',1792415681,1,NULL)");
    db.close();
    const { out } = await call({ conversation: "hermes:latest" });
    expect(out.conversation).toBe("hermes:h1");
    expect(out.turns[0]!.messages.map((message) => [message.timestamp, message.content])).toEqual([
      ["2026-10-19T13:13:59Z", "ask"],
      ["2026-10-19T13:14:37Z", "reply"],
      [null, "no time"],
    ]);
  });

  it("opencode: reads text parts with the message's millisecond time", async () => {
    const path = join(home, ".local/share/opencode/opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("CREATE TABLE session (id TEXT, title TEXT, parent_id TEXT, time_updated INTEGER)");
    db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)");
    db.run("CREATE TABLE part (id TEXT, message_id TEXT, data TEXT)");
    db.run("INSERT INTO session VALUES ('o1', 'Open chat', NULL, 1774710200000)");
    db.run("INSERT INTO message VALUES ('m1','o1','{\"role\":\"user\"}',1774710115430)");
    db.run("INSERT INTO message VALUES ('m2','o1','{\"role\":\"assistant\"}',NULL)");
    db.run("INSERT INTO part VALUES ('p1','m1','{\"type\":\"text\",\"text\":\"ask\"}')");
    db.run("INSERT INTO part VALUES ('p2','m2','{\"type\":\"text\",\"text\":\"reply\"}')");
    db.run("INSERT INTO part VALUES ('p3','m2','{\"type\":\"tool\",\"text\":\"ignored\"}')");
    db.close();
    const { out } = await call({ conversation: "opencode:o1" });
    expect(out.turns[0]!.messages.map((message) => [message.timestamp, message.content])).toEqual([
      ["2026-03-28T15:01:55Z", "ask"],
      [null, "reply"],
    ]);
  });
});

describe("loading against omp's own pi.zod", () => {
  it("returns a tool object and accepts a valid input, null optionals and rejects an invalid value", async () => {
    const tool = factory({ zod: await loadZod() } as never) as unknown as {
      name: string;
      description: string;
      parameters: { parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean } };
    };
    expect(tool.name).toBe("get_recent_turns");
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    const check = (value: unknown): boolean => {
      try {
        const parsed = tool.parameters.safeParse?.(value);
        if (parsed !== undefined) return parsed.success;
        tool.parameters.parse?.(value);
        return true;
      } catch {
        return false;
      }
    };
    expect(check({ conversation: "claude:latest", turns: 4, length_limit: 100, max_tokens: 500, format: "text" })).toBe(true);
    expect(check({ conversation: null, turns: null, length_limit: null, max_tokens: null })).toBe(true);
    expect(check({})).toBe(true);
    expect(check({ turns: 0 })).toBe(false);
    expect(check({ format: "yaml" })).toBe(false);
  });
});
