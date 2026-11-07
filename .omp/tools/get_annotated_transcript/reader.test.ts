import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { FakeMachine } from "./fake_machine_for_tests.js";
import { codexRecordTurns } from "./reader/codex.js";
import { claudeRecordTurns } from "./reader/claude.js";
import { conversationRefOf, namesMastraThread } from "./reader/conversation_ref.js";
import { cursorRecordTurns, stripCursorSystemInjection } from "./reader/cursor.js";
import { grokCompactionSummary, grokRecordTurns } from "./reader/grok.js";
import { type HostMachine, osHostMachine } from "./reader/host_machine.js";
import { jsonlTurns } from "./reader/jsonl_turns.js";
import { readTranscript } from "./reader/read_transcript.js";
import type { RecordParser } from "./reader/records.js";
import { COMPACTION_SUMMARY, CONVERSATION_REF, HARNESSES, TOOL_OUTPUT_HEAD_CHARS } from "./reader/schemas.js";
import type { Harness, Transcript, TranscriptTurn } from "./reader/schemas.js";
import { z } from "./reader/shape.js";
import { queryRows } from "./reader/sqlite_rows.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");

const HOME = "/home/zach";
const MINUTE = 60_000;
const lines = (...records: unknown[]): string => records.map((record) => JSON.stringify(record)).join("\n");
const machineWith = (files: Record<string, string>, modified: Record<string, number> = {}): FakeMachine =>
  new FakeMachine(HOME, files, modified);
const spoken = (turns: readonly TranscriptTurn[]): string[] => turns.map((turn) => `${turn.role}:${turn.text}`);
const tools = (turns: readonly TranscriptTurn[]): TranscriptTurn[] => turns.filter((turn) => turn.role === "tool");
const toolTurns = tools;

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(`${tmpdir()}/reader-test-`);
  temporaryDirectories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of temporaryDirectories) {
    try {
      chmodSync(directory, 0o755);
    } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A real SQLite file at `path` (its directory made), filled by `fill`. */
function database(path: string, fill: (db: Database) => void): string {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    fill(db);
  } finally {
    db.close();
  }
  return path;
}

// ---------------------------------------------------------------------------------------------------------------
// codex rollout

describe("a codex rollout", () => {
  const ID = "0199b2a1-7c3e-7d52-9a4f-1b6c2d3e4f50";
  const message = (role: string, type: string, text: string) => ({
    type: "response_item",
    payload: { type: "message", role, content: [{ type, text }] },
  });

  it("unwraps each response_item's payload into user and assistant turns and skips the AGENTS.md block and non-messages", async () => {
    const rollout = lines(
      { type: "session_meta", payload: { id: ID, cwd: "/work" } },
      message("user", "input_text", "# AGENTS.md instructions for /work\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>"),
      message("user", "input_text", "add a retry"),
      message("assistant", "output_text", "Added a retry."),
      { type: "event_msg", payload: { type: "token_count" } },
    );
    const machine = machineWith({ [`${HOME}/.codex/sessions/2026/10/21/rollout-2026-10-21T10-00-00-${ID}.jsonl`]: rollout });
    const { turns } = await readTranscript("codex", ID, machine);
    expect(turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual(["user:add a retry", "agent:Added a retry."]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// cursor

describe("cursor system-injection stripping", () => {
  it("prefers the <user_query> content of a message that starts with a system block", () => {
    const text =
      "<user_info>\nWorkspace Path: /w\n</user_info>\n<timestamp>Thu</timestamp>\n<user_query>\nreview the PR\n</user_query>";
    expect(stripCursorSystemInjection(text)).toBe("review the PR");
  });

  it("removes the system blocks and timestamps when there is no <user_query>", () => {
    const text = "<system_notification>build done</system_notification>\n<timestamp>Thu</timestamp>\nplease continue";
    expect(stripCursorSystemInjection(text)).toBe("please continue");
  });

  it("leaves prose with incidental tags alone", () => {
    const text = "why does <user_info> show up in my prompt?";
    expect(stripCursorSystemInjection(text)).toBe(text);
  });

  it("is nothing when only system blocks or an empty query remain", () => {
    expect(stripCursorSystemInjection("<plugin_info>x</plugin_info>\n<timestamp>t</timestamp>")).toBeUndefined();
    expect(stripCursorSystemInjection("<additional_data>x</additional_data><user_query>  </user_query>"))
      .toBeUndefined();
  });

  it("drops a user record with nothing real left and unwraps an ordinary ask", () => {
    const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } });
    expect(cursorRecordTurns(user("<user_info>Workspace Path: /w</user_info>"))).toEqual([]);
    expect(cursorRecordTurns(user("<timestamp>Thu</timestamp>\n<user_query>\nask\n</user_query>"))).toEqual([
      { role: "user", text: "ask" },
    ]);
  });
});

describe("cursor tool calls", () => {
  const ID = "80a12a40-a4b3-4e2e-804f-161e14f2a05b";

  it("emits a call turn for each tool_use block after the assistant's text, with a position-named id when it has none", () => {
    const turns = cursorRecordTurns({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", name: "Glob", input: { glob_pattern: "**/*.tf" } },
          { type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "budget" } },
        ],
      },
    });
    expect(turns).toEqual([
      { role: "agent", text: "Looking." },
      { role: "tool", text: "", tool_call: { id: "Glob#1", name: "Glob", input: { glob_pattern: "**/*.tf" } } },
      { role: "tool", text: "", tool_call: { id: "toolu_1", name: "Grep", input: { pattern: "budget" } } },
    ]);
  });

  it("emits calls for an assistant message that has no text, and readTranscript keeps them only on request", async () => {
    const path = `${HOME}/.cursor/projects/p/agent-transcripts/${ID}/${ID}.jsonl`;
    const machine = machineWith({
      [path]: JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "a" } }] },
      }),
    });
    expect((await readTranscript("cursor", ID, machine)).turns).toEqual([]);
    const withTools = await readTranscript("cursor", ID, machine, { toolCalls: true });
    expect(withTools.turns.map((turn) => turn.tool_call?.name)).toEqual(["Read"]);
  });
});

describe("cursor's legacy chat store", () => {
  const ID = "80a12a40-a4b3-4e2e-804f-161e14f2a05b";
  const rows = [
    { text: JSON.stringify({ role: "system", content: "You are a model." }) },
    { text: JSON.stringify({ role: "user", content: "<user_info>\nWorkspace Path: /Users/zach/app\n</user_info>" }) },
    {
      text: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "<timestamp>Thu</timestamp>\n<user_query>\nfix the login\n</user_query>" }],
      }),
    },
    { text: JSON.stringify({ role: "assistant", content: [{ type: "reasoning", text: "" }] }) },
    { text: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Fixed." }] }) },
    { text: "{\"role\":broken" },
  ];
  /** A real home with the legacy store as a real SQLite file; blobs hold the rows' text and one binary row that is no message. */
  function homeWithStore(): { home: string; store: string } {
    const home = temporaryDirectory();
    const store = database(`${home}/.cursor/chats/004bd084abea00097c82de0926775007/${ID}/store.db`, (db) => {
      db.run("CREATE TABLE blobs (id TEXT, data BLOB)");
      const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
      for (const [index, row] of rows.entries()) insert.run(`b${index}`, Buffer.from(row.text));
      insert.run("binary", Buffer.from([0, 1, 2, 3, 255, 254]));
    });
    return { home, store };
  }

  it("is read when there is no agent transcript: user and assistant text, stripped, with the workspace as cwd", async () => {
    const { home, store } = homeWithStore();
    const transcript = await readTranscript("cursor", ID, osHostMachine(home));
    expect(transcript.path).toBe(store);
    expect(transcript.turns).toEqual([
      { role: "user", text: "fix the login" },
      { role: "agent", text: "Fixed." },
    ]);
    expect(transcript.metadata).toEqual({ cwd: "/Users/zach/app" });
    expect(transcript.skipped_lines).toBe(1);
  });

  it("is not read when an agent transcript exists", async () => {
    const { home } = homeWithStore();
    const agent = `${home}/.cursor/projects/p/agent-transcripts/${ID}/${ID}.jsonl`;
    mkdirSync(dirname(agent), { recursive: true });
    writeFileSync(
      agent,
      JSON.stringify({ role: "user", message: { content: "<user_query>\nfrom the agent transcript\n</user_query>" } }),
    );
    const transcript = await readTranscript("cursor", ID, osHostMachine(home));
    expect(transcript.turns).toEqual([{ role: "user", text: "from the agent transcript" }]);
    expect(transcript.path).toBe(agent);
  });

  it("names the store's place among those tried when there is neither", async () => {
    await expect(readTranscript("cursor", ID, new FakeMachine(HOME))).rejects.toThrow(
      `${HOME}/.cursor/chats/*/${ID}/store.db`,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// grok

describe("grok sessions", () => {
  const ID = "01a107a2-06bd-7cb0-aea3-f574d120580d";
  const DIRECTORY = `${HOME}/.grok/sessions/%2Fwork%2Fg/${ID}`;

  const segment = (summary: string): string =>
    [
      "# Segment 000",
      "",
      "## Segment metadata",
      "- turns: 12",
      "",
      "## Summary (curated by compaction step)",
      "",
      summary,
      "",
      "## Verbatim turns",
      "",
      "VERBATIM-NOISE user said a very long thing",
    ].join("\n");

  const grokMachine = (files: Record<string, string>): FakeMachine =>
    machineWith({
      [`${DIRECTORY}/chat_history.jsonl`]: lines({ type: "user", content: "live ask" }, {
        type: "assistant",
        content: "live reply",
      }),
      ...files,
    });

  describe("compaction summaries", () => {
    it("puts the curated summary before the live turns and leaves the verbatim turns out", async () => {
      const machine = grokMachine({ [`${DIRECTORY}/compaction/segment_000.md`]: segment("We fixed the build.") });
      const { turns } = await readTranscript("grok", ID, machine);
      expect(turns).toEqual([
        {
          role: "context",
          text: "COMPACTED EARLIER TURNS (segment_000):\nWe fixed the build.",
          synthetic_reason: COMPACTION_SUMMARY,
        },
        { role: "user", text: "live ask" },
        { role: "agent", text: "live reply" },
      ]);
      expect(JSON.stringify(turns)).not.toContain("VERBATIM-NOISE");
    });

    it("lists several segments oldest first, skipping the index and segments with no summary", async () => {
      const machine = grokMachine({
        [`${DIRECTORY}/compaction/segment_002.md`]: segment("third"),
        [`${DIRECTORY}/compaction/INDEX.md`]: "# index",
        [`${DIRECTORY}/compaction/segment_000.md`]: segment("first"),
        [`${DIRECTORY}/compaction/segment_001.md`]: "# Segment 001\n\nno summary heading here",
        [`${DIRECTORY}/compaction/segment_003.md`]: segment("   "),
        [`${DIRECTORY}/compaction/segment_000.txt`]: segment("not a segment"),
      });
      const { turns } = await readTranscript("grok", ID, machine);
      expect(turns.filter((turn) => turn.role === "context").map((turn) => turn.text)).toEqual([
        "COMPACTED EARLIER TURNS (segment_000):\nfirst",
        "COMPACTED EARLIER TURNS (segment_002):\nthird",
      ]);
      expect(turns.map((turn) => turn.role)).toEqual(["context", "context", "user", "agent"]);
    });

    it("leaves the summaries out when the transcript is agentmux's captured copy, which still holds every turn", async () => {
      const machine = machineWith({
        [`${HOME}/.config/agentmux/transcripts/grok.${ID}.jsonl`]: lines({ type: "user", content: "an old ask" }, {
          type: "user",
          content: "live ask",
        }),
        [`${DIRECTORY}/compaction/segment_000.md`]: segment("earlier"),
        [`${DIRECTORY}/summary.json`]: JSON.stringify({ info: { cwd: "/work/app" } }),
      });
      const read = await readTranscript("grok", ID, machine);
      expect(read.turns.map((turn) => turn.text)).toEqual(["an old ask", "live ask"]);
      expect(read.metadata).toEqual({ cwd: "/work/app" });
    });

    it("takes the summary to the end of the file when no section follows it", () => {
      expect(grokCompactionSummary("## Summary (curated by compaction step)\n\nonly\n")).toBe("only");
    });
  });

  describe("user turns", () => {
    const userTurns = async (...records: unknown[]) => {
      const machine = machineWith({ [`${DIRECTORY}/chat_history.jsonl`]: lines(...records) });
      return (await readTranscript("grok", ID, machine)).turns;
    };

    it("strips <system-reminder> blocks, across lines and in any case, then unwraps <user_query>", async () => {
      const turns = await userTurns({
        type: "user",
        content:
          "<system-reminder>\nplan mode is on\n</system-reminder>\n<SYSTEM-REMINDER>x</SYSTEM-REMINDER>\n<user_query>\nfix the build\n</user_query>",
      });
      expect(turns).toEqual([{ role: "user", text: "fix the build" }]);
    });

    it("drops a turn that is only a reminder", async () => {
      expect(await userTurns({ type: "user", content: "<system-reminder>only this</system-reminder>" })).toEqual([]);
    });

    it("keeps a synthetic turn that has text left, marked with its reason, and strips its reminders too", async () => {
      const turns = await userTurns(
        { type: "user", synthetic_reason: "hook_feedback", content: "<system-reminder>r</system-reminder>hook said no" },
        { type: "user", synthetic_reason: "reminder", content: "<system-reminder>just a reminder</system-reminder>" },
      );
      expect(turns).toEqual([{ role: "user", text: "hook said no", synthetic_reason: "hook_feedback" }]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// copilot, pi, omp

describe("copilot: ~/.copilot/session-state/<id>/events.jsonl", () => {
  const COPILOT_ID = "167e953b-5c1f-4de7-af99-724407a787b4";
  const COPILOT_PATH = `${HOME}/.copilot/session-state/${COPILOT_ID}/events.jsonl`;
  const machine = machineWith({ [COPILOT_PATH]: fixture("copilot-events.jsonl") });
  const read = (conversation: string, m: FakeMachine, toolCalls = false): Promise<Transcript> =>
    transcriptFilesTurnSource(m).readTurns(conversation, { toolCalls });

  it("reads what the person typed and what the model said, each at its event's time", async () => {
    const transcript = await read(`copilot:${COPILOT_ID}`, machine);
    expect(transcript.path).toBe(COPILOT_PATH);
    expect(spoken(transcript.turns)).toEqual([
      "user:fix the failing test",
      "agent:One test fails on a stale snapshot. I will update it.",
      "agent:I could not edit the snapshot: permission was denied.",
      "user:[Scheduled prompt #1]\nretry the edit",
    ]);
    expect(transcript.turns[0]?.timestamp).toBe("2026-10-07T21:22:44Z");
  });

  it("does not read the prompt as the harness transformed it, the system prompt, reasoning or model calls", async () => {
    const text = (await read(`copilot:${COPILOT_ID}`, machine)).turns.map((turn) => turn.text).join("\n");
    expect(text).not.toMatch(/current_datetime|GitHub Copilot CLI|session-title|run it first/);
  });

  it("joins each tool request to its result by id, and marks a failed execution", async () => {
    const turns = tools((await read(`copilot:${COPILOT_ID}`, machine, true)).turns);
    expect(turns.map((turn) => turn.tool_call?.id ?? turn.tool_result?.id)).toEqual([
      "toolu_01",
      "toolu_01",
      "toolu_02",
      "toolu_02",
    ]);
    expect(turns[0]?.tool_call).toEqual({
      id: "toolu_01",
      name: "bash",
      input: { command: "npm test", description: "Run the tests" },
    });
    expect(turns[1]?.tool_result).toEqual({ id: "toolu_01", output: "1 failed, 4 passed", is_error: false });
    expect(turns[3]?.tool_result).toEqual({
      id: "toolu_02",
      output: "Permission denied and could not request permission from user",
      is_error: true,
    });
  });

  it("finds no transcript in a session directory that only has its workspace file", async () => {
    const stub = machineWith({ [`${HOME}/.copilot/session-state/${COPILOT_ID}/workspace.yaml`]: `id: ${COPILOT_ID}` });
    await expect(read(`copilot:${COPILOT_ID}`, stub)).rejects.toThrow(
      `no transcript found for copilot:${COPILOT_ID}; tried ${COPILOT_PATH}`,
    );
  });
});

describe("pi: ~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl", () => {
  const PI_ID = "01a15bf4-6088-7307-b815-67db11c0abc2";
  const PI_PATH = `${HOME}/.pi/agent/sessions/--home-user--/2026-10-21T00-55-04-586Z_${PI_ID}.jsonl`;
  const machine = machineWith({
    [PI_PATH]: fixture("pi-session.jsonl"),
    [`${HOME}/.pi/agent/sessions/--home-user--/2026-10-21T00-55-04-586Z_other-id.jsonl`]: "not this one",
    [`${HOME}/.pi/agent/sessions/--tmp--/2026-10-15T20-07-41-243Z_${PI_ID}-extra.jsonl`]: "not this one either",
  });
  const read = (conversation: string, toolCalls = false): Promise<Transcript> =>
    transcriptFilesTurnSource(machine).readTurns(conversation, { toolCalls });

  it("finds the session by the id at the end of its file name", async () => {
    const transcript = await read(`pi:${PI_ID}`);
    expect(transcript.path).toBe(PI_PATH);
    expect(spoken(transcript.turns)).toEqual([
      "user:set up the linter",
      "agent:I will look at the config.",
      "agent:The lint run timed out; trying again.",
      "user:check now",
    ]);
    expect(transcript.turns[1]?.timestamp).toBe("2026-10-21T01:10:05Z");
  });

  it("reads tool calls and results, and a result's isError", async () => {
    const turns = tools((await read(`pi:${PI_ID}`, true)).turns);
    expect(turns[0]?.tool_call).toEqual({ id: "call_01", name: "bash", input: { command: "ls -a" } });
    expect(turns[1]?.tool_result).toEqual({ id: "call_01", output: ".eslintrc\npackage.json", is_error: false });
    expect(turns[3]?.tool_result).toEqual({
      id: "call_02",
      output: "MCP request timed out after 60000ms",
      is_error: true,
    });
  });

  it("names the pattern it looked for when no file ends with the id", async () => {
    await expect(read("pi:nope")).rejects.toThrow(`tried ${HOME}/.pi/agent/sessions/*/*_nope.jsonl`);
  });
});

describe("omp: ~/.omp/agent/sessions/<cwd>/<time>_<id>.jsonl", () => {
  const OMP_ID = "01a16060-4ae3-72dd-a168-f334d0a05703";
  const OMP_PATH = `${HOME}/.omp/agent/sessions/-home-user-project/2026-10-21T21-31-25-795Z_${OMP_ID}.jsonl`;
  const machine = machineWith({
    [OMP_PATH]: fixture("omp-session.jsonl"),
    // What omp keeps beside a session: a lock file and a directory of the session's tool logs.
    [`${HOME}/.omp/agent/sessions/-home-user-project/.2026-10-21T21-31-25-795Z_${OMP_ID}.jsonl.lock.os`]: "",
    [`${HOME}/.omp/agent/sessions/-home-user-project/2026-10-21T21-31-25-795Z_${OMP_ID}/10.read.log`]: "log",
    // pi's store is not omp's.
    [`${HOME}/.pi/agent/sessions/--home-user--/2026-10-21T00-55-04-586Z_${OMP_ID}.jsonl`]: "pi's",
  });
  const read = (toolCalls = false): Promise<Transcript> =>
    transcriptFilesTurnSource(machine).readTurns(`omp:${OMP_ID}`, { toolCalls });

  it("finds the session in omp's own store and skips thinking, developer reminders and injected context", async () => {
    const transcript = await read();
    expect(transcript.path).toBe(OMP_PATH);
    expect(spoken(transcript.turns)).toEqual([
      "user:Please fix the build",
      "agent:The build fails on an undeclared name in x.ts.",
    ]);
    expect(transcript.skipped_lines).toBe(0);
  });

  it("keeps a tool call id that holds a pipe, joined to its result", async () => {
    const turns = tools((await read(true)).turns);
    expect(turns[0]?.tool_call).toEqual({
      id: "chatcmpl-tool-c337|fc_tmp_hto0",
      name: "read",
      input: { path: "ci.log" },
    });
    expect(turns[1]?.tool_result?.id).toBe("chatcmpl-tool-c337|fc_tmp_hto0");
    expect(turns[1]?.tool_result?.output).toBe("error TS2304: Cannot find name 'x'");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// session metadata

describe("the session metadata a harness recorded about where it ran", () => {
  const ID = "6513270e-269e-4d37-b2a7-4de452e6b438";
  const CAPTURED = `${HOME}/.config/agentmux/transcripts`;
  const metadataOf = async (harness: Harness, machine: FakeMachine) => (await readTranscript(harness, ID, machine)).metadata;

  it("claude: the last user record's cwd and gitBranch", async () => {
    const machine = machineWith({
      [`${CAPTURED}/claude-code.${ID}.jsonl`]: lines(
        { type: "user", cwd: "/work/old", gitBranch: "main", message: { role: "user", content: "one" } },
        { type: "assistant", cwd: "/ignored", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
        { type: "user", cwd: "/work/new", gitBranch: "feat/x", message: { role: "user", content: "three" } },
      ),
    });
    expect(await metadataOf("claude", machine)).toEqual({ cwd: "/work/new", git_branch: "feat/x" });
  });

  it("codex: session_meta's cwd and git branch, then a later turn_context's cwd", async () => {
    const machine = machineWith({
      [`${CAPTURED}/codex.${ID}.jsonl`]: lines(
        { type: "session_meta", payload: { id: ID, cwd: "/work/a", git: { branch: "main", commit_hash: "abc" } } },
        { type: "turn_context", payload: { cwd: "/work/b" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
      ),
    });
    expect(await metadataOf("codex", machine)).toEqual({ cwd: "/work/b", git_branch: "main" });
  });

  it("copilot: the session.start event's context cwd and branch", async () => {
    const machine = machineWith({
      [`${HOME}/.copilot/session-state/${ID}/events.jsonl`]: lines({
        type: "session.start",
        data: { sessionId: ID, context: { cwd: "/work/c", branch: "fix/y" } },
      }),
    });
    expect(await metadataOf("copilot", machine)).toEqual({ cwd: "/work/c", git_branch: "fix/y" });
  });

  for (const [harness, root] of [["pi", ".pi"], ["omp", ".omp"]] as const) {
    it(`${harness}: the session header's cwd and no branch`, async () => {
      const machine = machineWith({
        [`${HOME}/${root}/agent/sessions/--work--/2026-10-21T00-55-04_${ID}.jsonl`]: lines(
          { type: "title", title: "t" },
          { type: "session", version: 3, id: ID, cwd: "/work/p" },
        ),
      });
      expect(await metadataOf(harness, machine)).toEqual({ cwd: "/work/p" });
    });
  }

  it("cursor: only the Workspace Path line of a user message's user_info block", async () => {
    const machine = machineWith({
      [`${HOME}/.cursor/projects/Users-zach-app/agent-transcripts/${ID}/${ID}.jsonl`]: lines(
        {
          role: "user",
          message: {
            content: [{ type: "text", text: "<user_info>\nShell: zsh\nWorkspace Path: /Users/zach/app\n</user_info>" }],
          },
        },
        { role: "user", message: { content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }] } },
      ),
    });
    expect(await metadataOf("cursor", machine)).toEqual({ cwd: "/Users/zach/app" });
  });

  it("cursor: no metadata when no message names a workspace, and the project slug is never decoded", async () => {
    const machine = machineWith({
      [`${HOME}/.cursor/projects/Users-zach-app/agent-transcripts/${ID}/${ID}.jsonl`]: lines({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }] },
      }),
    });
    expect(await metadataOf("cursor", machine)).toBeUndefined();
  });

  it("omits metadata entirely when the harness recorded none", async () => {
    const machine = machineWith({
      [`${CAPTURED}/claude-code.${ID}.jsonl`]: lines({ type: "user", message: { role: "user", content: "one" } }),
    });
    const transcript = await readTranscript("claude", ID, machine);
    expect("metadata" in transcript).toBe(false);
  });

  it("grok: summary.json's info.cwd and head_branch beside chat_history.jsonl", async () => {
    const directory = `${HOME}/.grok/sessions/%2Fwork%2Fg/${ID}`;
    const machine = machineWith({
      [`${directory}/chat_history.jsonl`]: lines({ type: "user", content: "hi" }),
      [`${directory}/summary.json`]: JSON.stringify({ info: { id: ID, cwd: "/work/g" }, head_branch: "feat/g" }),
    });
    expect(await metadataOf("grok", machine)).toEqual({ cwd: "/work/g", git_branch: "feat/g" });
  });

  it("grok: finds the native session directory when the transcript is agentmux's captured copy", async () => {
    const directory = `${HOME}/.grok/sessions/%2Fwork%2Fg/${ID}`;
    const machine = machineWith({
      [`${CAPTURED}/grok.${ID}.jsonl`]: lines({ type: "user", content: "hi" }),
      [`${directory}/summary.json`]: JSON.stringify({ info: { cwd: "/work/g" } }),
    });
    const transcript = await readTranscript("grok", ID, machine);
    expect(transcript.path).toBe(`${CAPTURED}/grok.${ID}.jsonl`);
    expect(transcript.metadata).toEqual({ cwd: "/work/g" });
  });

  it("grok: no metadata when there is no native session directory or summary.json is not JSON", async () => {
    const captured = { [`${CAPTURED}/grok.${ID}.jsonl`]: lines({ type: "user", content: "hi" }) };
    expect(await metadataOf("grok", machineWith(captured))).toBeUndefined();
    const broken = machineWith({ ...captured, [`${HOME}/.grok/sessions/w/${ID}/summary.json`]: "{not json" });
    expect(await metadataOf("grok", broken)).toBeUndefined();
  });

  it("hermes: the session row's cwd and git_branch", async () => {
    const home = temporaryDirectory();
    hermesDatabase(home, [{ id: "20261013_220639_7aa8a1", cwd: "/work/h", git_branch: "main" }], [
      { session_id: "20261013_220639_7aa8a1", role: "user", content: "ask" },
    ]);
    const transcript = await readTranscript("hermes", "20261013_220639_7aa8a1", osHostMachine(home));
    expect(transcript.metadata).toEqual({ cwd: "/work/h", git_branch: "main" });
    expect(transcript.turns).toEqual([{ role: "user", text: "ask" }]);
  });

  it("hermes: a session row with null cwd and git_branch has no metadata", async () => {
    const home = temporaryDirectory();
    hermesDatabase(home, [{ id: "20261013_220639_7aa8a1", cwd: null, git_branch: null }], [
      { session_id: "20261013_220639_7aa8a1", role: "user", content: "ask" },
    ]);
    const transcript = await readTranscript("hermes", "20261013_220639_7aa8a1", osHostMachine(home));
    expect(transcript.metadata).toBeUndefined();
  });

  it("opencode: the session's directory", async () => {
    const home = temporaryDirectory();
    opencodeDatabase(
      home,
      [{ id: "ses_abc", directory: "/work/o" }],
      [{ id: "m1", session: "ses_abc", role: "user", created: 1000, parts: [{ type: "text", text: "ask" }] }],
    );
    const transcript = await readTranscript("opencode", "ses_abc", osHostMachine(home));
    expect(transcript.metadata).toEqual({ cwd: "/work/o" });
    expect(transcript.turns.map((turn) => turn.text)).toEqual(["ask"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// real-SQLite fixtures for hermes and opencode

interface HermesSession {
  id: string;
  cwd?: string | null;
  git_branch?: string | null;
  title?: string | null;
  last_activity_at?: number | null;
  started_at?: number;
}
interface HermesMessage {
  session_id: string;
  role: string;
  content?: string | null;
  active?: number;
  display_kind?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  timestamp?: number | null;
}
function hermesDatabase(home: string, sessions: HermesSession[], messages: HermesMessage[] = []): string {
  return database(`${home}/.hermes/state.db`, (db) => {
    db.run(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, git_branch TEXT, title TEXT, last_activity_at REAL, started_at REAL)",
    );
    db.run(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, active INTEGER, display_kind TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL)",
    );
    for (const s of sessions) {
      db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", [
        s.id,
        s.cwd ?? null,
        s.git_branch ?? null,
        s.title ?? null,
        s.last_activity_at ?? null,
        s.started_at ?? 0,
      ]);
    }
    for (const m of messages) {
      db.run(
        "INSERT INTO messages (session_id, role, content, active, display_kind, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        [m.session_id, m.role, m.content ?? null, m.active ?? 1, m.display_kind ?? null, m.tool_call_id ?? null, m.tool_calls ?? null, m.timestamp ?? null],
      );
    }
  });
}

interface OpencodeSession {
  id: string;
  directory?: string | null;
  title?: string | null;
  updated?: number;
  parent_id?: string | null;
}
interface OpencodeMessage {
  id: string;
  session: string;
  role: string;
  created: number;
  parts: Record<string, unknown>[];
}
function opencodeDatabase(home: string, sessions: OpencodeSession[], messages: OpencodeMessage[] = []): string {
  return database(`${home}/.local/share/opencode/opencode.db`, (db) => {
    db.run(
      "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)",
    );
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    for (const s of sessions) {
      db.run("INSERT INTO session VALUES (?, ?, ?, ?, ?)", [
        s.id,
        s.directory ?? null,
        s.title ?? null,
        s.updated ?? 0,
        s.parent_id ?? null,
      ]);
    }
    for (const m of messages) {
      db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [m.id, m.session, m.created, JSON.stringify({ role: m.role })]);
      for (const [index, part] of m.parts.entries()) {
        db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [`${m.id}_p${index}`, m.id, m.session, m.created, JSON.stringify(part)]);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// opencode tool parts

describe("opencode tool parts", () => {
  const ID = "ses_ee697c116ffejwIjCSsjJym1vW";
  const LONG = "y".repeat(TOOL_OUTPUT_HEAD_CHARS + 500);
  const toolPart = (callID: string, status: string, input: unknown, output: unknown): Record<string, unknown> => ({
    type: "tool",
    tool: "read",
    callID,
    state: { status, input, ...(output === undefined ? {} : status === "error" ? { error: output } : { output }) },
  });
  function machine(): HostMachine {
    const home = temporaryDirectory();
    opencodeDatabase(
      home,
      [{ id: ID, directory: "/work/o" }],
      [
        { id: "m1", session: ID, role: "user", created: 1000, parts: [{ type: "text", text: "read the README" }] },
        {
          id: "m2",
          session: ID,
          role: "assistant",
          created: 2000,
          parts: [
            toolPart("c1", "completed", { filePath: "/w/README.md" }, "# Title"),
            toolPart("c2", "error", { filePath: "/w/missing.md" }, "File not found"),
            toolPart("c3", "running", { filePath: "/w/slow.md" }, undefined),
            toolPart("c4", "completed", { filePath: "/w/big.md" }, LONG),
            { type: "text", text: "Done." },
          ],
        },
      ],
    );
    return osHostMachine(home);
  }

  it("emits a call then its result, in order among the text parts, with is_error for a failed call", async () => {
    const { turns } = await readTranscript("opencode", ID, machine(), { toolCalls: true });
    expect(turns.map((turn) => turn.tool_call?.id ?? turn.tool_result?.id ?? `${turn.role}:${turn.text}`)).toEqual([
      "user:read the README",
      "c1",
      "c1",
      "c2",
      "c2",
      "c3",
      "c4",
      "c4",
      "agent:Done.",
    ]);
    expect(turns[1]!.tool_call).toEqual({ id: "c1", name: "read", input: { filePath: "/w/README.md" } });
    expect(turns[2]!.tool_result).toEqual({ id: "c1", output: "# Title", is_error: false });
    expect(turns[4]!.tool_result).toEqual({ id: "c2", output: "File not found", is_error: true });
  });

  it("leaves the tool turns out unless the caller asks for them", async () => {
    const { turns } = await readTranscript("opencode", ID, machine());
    expect(turns.map((turn) => turn.text)).toEqual(["read the README", "Done."]);
  });

  it("asks the database for only the head of a tool's output", async () => {
    const { turns } = await readTranscript("opencode", ID, machine(), { toolCalls: true });
    const big = turns.find((turn) => turn.tool_result?.id === "c4")!.tool_result!;
    expect(big.output).toBe("y".repeat(TOOL_OUTPUT_HEAD_CHARS));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// conversation refs

describe("conversationRefOf", () => {
  const THREAD = "a3927124-9c47-4d02-b417-133c06c71385";
  const THREAD_URL = `https://stable.capability-replicas.localhost/agents/code-improver/threads/${THREAD}`;
  const HARNESS_PHRASE = /is not a conversation ref; it must be "<harness>:<id>" where harness is one of .*copilot, pi, omp/;

  const KEPT = [
    "copilot:167e953b-5c1f-4de7-af99-724407a787b4",
    "pi:01a15bf4-6088-7307-b815-67db11c0abc2",
    "omp:01a163c9-b346-7624-ab2b-700c677e70f8",
    "claude:6513270e-269e-4d37-b2a7-4de452e6b438",
  ];
  for (const ref of KEPT) {
    it(`keeps ${ref} as it is`, () => {
      expect(conversationRefOf(ref)).toBe(ref);
    });
  }

  const MASTRA: [string, string][] = [
    ["a Mastra thread ref", `mastra:thread:${THREAD}`],
    ["a thread's page", THREAD_URL],
    ["a trailing slash", `${THREAD_URL}/`],
    ["a query", `${THREAD_URL}?tab=traces`],
    ["a fragment", `${THREAD_URL}#latest`],
    ["plain http and a port", `http://localhost:4111/agents/code-improver/threads/${THREAD}`],
  ];
  for (const [name, input] of MASTRA) {
    it(`refuses ${name} as a Mastra chat thread this tool cannot read`, () => {
      expect(namesMastraThread(input)).toBe(true);
      expect(() => conversationRefOf(input)).toThrow(/is a Mastra chat thread; this tool reads harness session files and databases only/);
    });
  }

  const REFUSED: [string, string][] = [
    ["a bare id", THREAD],
    ["a Mastra trace ref, which is not a conversation", "mastra:0f3c1d5a7b9e"],
    ["a thread URL with no thread id", "https://stable.capability-replicas.localhost/agents/code-improver/threads/"],
    ["an agent's page", "https://stable.capability-replicas.localhost/agents/code-improver"],
    ["a page under another path", `https://stable.capability-replicas.localhost/workflows/plan/threads/${THREAD}`],
    ["a thread URL with a path after the id", `${THREAD_URL}/traces/1`],
    ["a URL of another scheme", `ftp://stable.capability-replicas.localhost/agents/code-improver/threads/${THREAD}`],
    ["a URL with no host", `https:///agents/code-improver/threads/${THREAD}`],
    ["an unknown harness", "vim:x"],
    ["a harness with no id", "pi:"],
    ["text around a ref", ` pi:${THREAD}`],
  ];
  for (const [name, input] of REFUSED) {
    it(`refuses ${name}, naming the accepted form`, () => {
      expect(namesMastraThread(input)).toBe(false);
      expect(() => conversationRefOf(input)).toThrow(HARNESS_PHRASE);
    });
  }

  it("names every harness in the conversation ref", () => {
    for (const harness of HARNESSES) expect(CONVERSATION_REF.test(`${harness}:abc`)).toBe(true);
    for (const harness of ["grok", "claude", "codex", "copilot", "pi", "omp"]) expect(HARNESSES).toContain(harness as Harness);
  });

  it("does not offer a Mastra harness", () => {
    expect(HARNESSES as readonly string[]).not.toContain("mastra");
  });

  describe("what an identifier may hold", () => {
    const MAY = ["grok:fix the build", "omp:DOCK: MCP Docker", "claude:6513270e", "copilot:latest", "cursor:Push facades (v2)"];
    const MAY_NOT = [
      "grok:a/b",
      "grok:a;b",
      "grok:a\\b",
      "grok:a$b",
      "grok:a\"b",
      "grok:a'b",
      "grok:a|b",
      "grok:a&b",
      "grok:a<b",
      "grok:a>b",
      "grok: leading space",
      "grok:trailing space ",
      "grok:two\nlines",
      "grok:",
    ];
    for (const ref of MAY) {
      it(`accepts ${JSON.stringify(ref)}`, () => {
        expect(conversationRefOf(ref)).toBe(ref);
      });
    }
    for (const ref of MAY_NOT) {
      it(`refuses ${JSON.stringify(ref)}, naming the accepted forms`, () => {
        expect(() => conversationRefOf(ref)).toThrow(
          /the start of one, "latest", or words of the session's title \(titles: grok, cursor, copilot, omp, hermes, opencode\)/,
        );
      });
    }

    it("refuses a character that could reach a query before it searches anything", async () => {
      const home = temporaryDirectory();
      const machine = osHostMachine(home);
      const source = transcriptFilesTurnSource(machine);
      await expect(source.readTurns("opencode:x'OR'1'='1")).rejects.toThrow(/is not a conversation ref/);
      await expect(readTranscript("opencode", "x'OR'1'='1", machine)).rejects.toThrow(/session identifier "x'OR'1'='1"/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// finding a session by prefix, latest or title

describe("finding a session", () => {
  const NOW = 1_800_000_000_000;
  type Entry = readonly [path: string, text: string, minutesAgo: number];

  interface Layout {
    files: Record<string, string>;
    modified: Record<string, number>;
  }
  function layout(entries: readonly Entry[]): Layout {
    return {
      files: Object.fromEntries(entries.map(([path, text]) => [path, text])),
      modified: Object.fromEntries(entries.map(([path, , minutesAgo]) => [path, NOW - minutesAgo * MINUTE])),
    };
  }
  const machineOf = ({ files, modified }: Layout): FakeMachine => machineWith(files, modified);
  const read = (conversation: string, machine: FakeMachine): Promise<Transcript> =>
    transcriptFilesTurnSource(machine).readTurns(conversation);
  const asks = (transcript: Transcript): string[] => transcript.turns.map((turn) => turn.text);
  const failure = async (promise: Promise<unknown>): Promise<Error> => {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a rejection");
  };

  const claudeLine = (text: string): string => JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const ompUser = (text: string): string =>
    JSON.stringify({ type: "message", id: "m", message: { role: "user", content: [{ type: "text", text }] } });

  const GROK = `${HOME}/.grok/sessions`;
  function grokSession(id: string, minutesAgo: number, summary: Record<string, unknown> | undefined): Entry[] {
    const directory = `${GROK}/%2Fwork%2Fapp/${id}`;
    return [
      [`${directory}/chat_history.jsonl`, JSON.stringify({ type: "user", content: id }), minutesAgo],
      ...(summary === undefined ? [] : [[`${directory}/summary.json`, JSON.stringify(summary), minutesAgo] as Entry]),
    ];
  }
  const GROK_HOME = layout([
    ...grokSession("0aa11111-0000-0000-0000-000000000001", 50, { generated_title: "Fix the Build", info: { cwd: "/work/app" } }),
    ...grokSession("0aa22222-0000-0000-0000-000000000002", 40, {
      generated_title: "Fix the flaky login test",
      info: { cwd: "/work/app" },
    }),
    ...grokSession("0bb33333-0000-0000-0000-000000000003", 30, { session_summary: "Plan the release", info: { cwd: "/work/app" } }),
    // The newest session of all is a subagent's: `latest` and a title search never take it.
    ...grokSession("0cc44444-0000-0000-0000-000000000004", 5, {
      generated_title: "Fix the build (subagent)",
      session_kind: "subagent",
    }),
  ]);

  describe("grok: an id prefix, latest, or a title", () => {
    it("reads a unique id prefix and names the session by its full id", async () => {
      const transcript = await read("grok:0bb3", machineOf(GROK_HOME));
      expect(transcript.conversation).toBe("grok:0bb33333-0000-0000-0000-000000000003");
      expect(asks(transcript)).toEqual(["0bb33333-0000-0000-0000-000000000003"]);
    });

    it("refuses an ambiguous prefix, listing each candidate's id, title and time, newest first", async () => {
      const message = (await failure(read("grok:0aa", machineOf(GROK_HOME)))).message;
      expect(message).toContain("2 sessions start with \"0aa\" for grok:0aa");
      expect(message.indexOf("0aa22222")).toBeLessThan(message.indexOf("0aa11111"));
      expect(message).toContain("0aa22222-0000-0000-0000-000000000002  2027-01-15T07:20Z  Fix the flaky login test  (/work/app)");
      expect(message).toContain("0aa11111-0000-0000-0000-000000000001  2027-01-15T07:10Z  Fix the Build");
    });

    it("takes the newest top-level session for latest, not a subagent's", async () => {
      const transcript = await read("grok:latest", machineOf(GROK_HOME));
      expect(transcript.conversation).toBe("grok:0bb33333-0000-0000-0000-000000000003");
    });

    it("still reads a subagent's session by its id or its id prefix", async () => {
      const byId = await read("grok:0cc44444-0000-0000-0000-000000000004", machineOf(GROK_HOME));
      expect(byId.conversation).toBeUndefined();
      expect((await read("grok:0cc4", machineOf(GROK_HOME))).conversation).toBe("grok:0cc44444-0000-0000-0000-000000000004");
    });

    it("finds a session by words of its title, ignoring case", async () => {
      expect((await read("grok:plan the RELEASE", machineOf(GROK_HOME))).conversation).toBe(
        "grok:0bb33333-0000-0000-0000-000000000003",
      );
      expect((await read("grok:FLAKY login", machineOf(GROK_HOME))).conversation).toBe(
        "grok:0aa22222-0000-0000-0000-000000000002",
      );
    });

    it("refuses a title that several top-level sessions share, and never counts the subagent", async () => {
      const error = await failure(read("grok:fix the", machineOf(GROK_HOME)));
      expect(error.message).toContain("2 sessions have a title containing \"fix the\" for grok:fix the");
      expect(error.message).not.toContain("0cc44444");
    });

    it("says what it looked for and lists the recent top-level sessions when nothing matches", async () => {
      const error = await failure(read("grok:zzz", machineOf(GROK_HOME)));
      expect(error.message).toContain("no transcript found for grok:zzz; tried");
      expect(error.message).toContain("no grok session id starts with \"zzz\" and no top-level session's title contains it");
      const recent = error.message.slice(error.message.indexOf("Recent sessions:"));
      expect(recent.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0])).toEqual([
        "0bb33333-0000-0000-0000-000000000003",
        "0aa22222-0000-0000-0000-000000000002",
        "0aa11111-0000-0000-0000-000000000001",
      ]);
    });

    it("reads a full id without dating or describing any session", async () => {
      const machine = machineOf(GROK_HOME);
      const touched: string[] = [];
      const modifiedAtMs = machine.modifiedAtMs.bind(machine);
      const readTextFile = machine.readTextFile.bind(machine);
      machine.modifiedAtMs = (path) => (touched.push(path), modifiedAtMs(path));
      machine.readTextFile = (path) => (touched.push(path), readTextFile(path));
      const transcript = await transcriptFilesTurnSource(machine).readTurns("grok:0aa11111-0000-0000-0000-000000000001");
      expect(asks(transcript)).toEqual(["0aa11111-0000-0000-0000-000000000001"]);
      expect(touched).toEqual([`${HOME}/.grok/sessions/%2Fwork%2Fapp/0aa11111-0000-0000-0000-000000000001/summary.json`]);
    });
  });

  const CLAUDE = `${HOME}/.claude/projects/-work-app`;
  const CAPTURED = `${HOME}/.config/agentmux/transcripts`;
  const CLAUDE_HOME = layout([
    [`${CLAUDE}/6513270e-1111-4d37-b2a7-4de452e6b438.jsonl`, claudeLine("older"), 90],
    [`${CLAUDE}/6513ffff-2222-4d37-b2a7-4de452e6b438.jsonl`, claudeLine("other"), 80],
    [`${CLAUDE}/a0000000-3333-4d37-b2a7-4de452e6b438.jsonl`, claudeLine("newest"), 10],
    // Subagent transcripts sit in a directory beside the session's file and are not sessions.
    [`${CLAUDE}/a0000000-3333-4d37-b2a7-4de452e6b438/subagents/agent-1.jsonl`, claudeLine("sub"), 1],
    // agentmux's copy of a session whose own file is gone is still a session.
    [`${CAPTURED}/claude-code.c0ffee00-4444-4d37-b2a7-4de452e6b438.jsonl`, claudeLine("captured only"), 20],
  ]);

  describe("claude: an id prefix or latest; there are no titles", () => {
    it("reads a unique prefix", async () => {
      const transcript = await read("claude:6513270e", machineOf(CLAUDE_HOME));
      expect(transcript.conversation).toBe("claude:6513270e-1111-4d37-b2a7-4de452e6b438");
      expect(asks(transcript)).toEqual(["older"]);
    });

    it("refuses a prefix of two sessions", async () => {
      await expect(read("claude:6513", machineOf(CLAUDE_HOME))).rejects.toThrow(/2 sessions start with "6513" for claude:6513/);
    });

    it("takes the most recently modified session for latest", async () => {
      expect((await read("claude:latest", machineOf(CLAUDE_HOME))).conversation).toBe(
        "claude:a0000000-3333-4d37-b2a7-4de452e6b438",
      );
    });

    it("finds a session only agentmux's captured copy holds", async () => {
      expect(asks(await read("claude:c0ffee", machineOf(CLAUDE_HOME)))).toEqual(["captured only"]);
    });

    it("does not search titles: a word that is no id's start finds nothing", async () => {
      const error = await failure(read("claude:older", machineOf(CLAUDE_HOME)));
      expect(error.message).toContain("no claude session id starts with \"older\"");
      expect(error.message).not.toContain("title");
    });
  });

  const OMP = `${HOME}/.omp/agent/sessions/-work-app`;
  const ompFile = (id: string, title: string, cwd = "/work/app") =>
    [
      JSON.stringify({ type: "title", v: 1, title, source: "auto", pad: "     " }),
      JSON.stringify({ type: "session", version: 3, id, cwd }),
      ompUser(`ask of ${id.slice(0, 8)}`),
    ].join("\n");
  const OMP_HOME = layout([
    [
      `${OMP}/2026-10-21T21-31-25-795Z_01a16060-4ae3-72dd-a168-f334d0a05703.jsonl`,
      ompFile("01a16060-4ae3-72dd-a168-f334d0a05703", "DOCK: MCP Docker not loading"),
      60,
    ],
    [
      `${OMP}/2026-10-21T21-47-41-919Z_01a1606f-2fdf-77e5-9965-7e25cf09d19c.jsonl`,
      ompFile("01a1606f-2fdf-77e5-9965-7e25cf09d19c", "DOCK: Plan the cleanup"),
      30,
    ],
    [
      `${OMP}/2026-10-22T12-50-04-410Z_01a163a9-55fa-76b3-a5d1-6b5e148e6c63.jsonl`,
      ompFile("01a163a9-55fa-76b3-a5d1-6b5e148e6c63", ""),
      5,
    ],
    // omp's lock file and its directory of tool logs are not sessions.
    [`${OMP}/.2026-10-22T12-50-04-410Z_01a163a9-55fa-76b3-a5d1-6b5e148e6c63.jsonl.lock.os`, "", 1],
    [`${OMP}/2026-10-22T12-50-04-410Z_01a163a9-55fa-76b3-a5d1-6b5e148e6c63/10.read.log`, "log", 1],
  ]);

  describe("omp: an id prefix, latest, or the title in the first line", () => {
    it("reads a unique prefix", async () => {
      expect(asks(await read("omp:01a1606f", machineOf(OMP_HOME)))).toEqual(["ask of 01a1606f"]);
    });

    it("refuses the shared prefix of every session, listing them with their titles and the empty one untitled", async () => {
      const error = await failure(read("omp:01a1", machineOf(OMP_HOME)));
      expect(error.message).toContain("3 sessions start with \"01a1\" for omp:01a1");
      expect(error.message).toContain("01a163a9-55fa-76b3-a5d1-6b5e148e6c63  2027-01-15T07:55Z  (untitled)  (/work/app)");
      expect(error.message).toContain("DOCK: MCP Docker not loading");
    });

    it("takes the newest for latest, and finds a title with a colon and spaces in it", async () => {
      expect((await read("omp:latest", machineOf(OMP_HOME))).conversation).toBe("omp:01a163a9-55fa-76b3-a5d1-6b5e148e6c63");
      expect((await read("omp:DOCK: MCP Docker", machineOf(OMP_HOME))).conversation).toBe(
        "omp:01a16060-4ae3-72dd-a168-f334d0a05703",
      );
    });

    it("refuses a title two sessions share", async () => {
      await expect(read("omp:dock:", machineOf(OMP_HOME))).rejects.toThrow(/2 sessions have a title containing "dock:"/);
    });
  });

  describe("pi: an id prefix or latest; the header holds no title", () => {
    const PI_HOME = layout([
      [
        `${HOME}/.pi/agent/sessions/--work-app--/2026-10-21T00-55-04-586Z_01a15bf4-6088-7307-b815-67db11c0abc2.jsonl`,
        [
          JSON.stringify({ type: "session", version: 3, id: "01a15bf4-6088-7307-b815-67db11c0abc2", cwd: "/work/app" }),
          JSON.stringify({ type: "message", id: "a", message: { role: "user", content: "hello pi" } }),
        ].join("\n"),
        10,
      ],
    ]);

    it("resolves a prefix and latest to the same session", async () => {
      expect(asks(await read("pi:01a15bf4", machineOf(PI_HOME)))).toEqual(["hello pi"]);
      expect((await read("pi:latest", machineOf(PI_HOME))).conversation).toBe("pi:01a15bf4-6088-7307-b815-67db11c0abc2");
    });
  });

  describe("copilot: an id prefix, latest, or the name in workspace.yaml", () => {
    const SESSION = `${HOME}/.copilot/session-state`;
    const event = (text: string) =>
      JSON.stringify({ type: "user.message", data: { content: text }, timestamp: "2026-10-07T21:22:44.160Z" });
    const COPILOT_HOME = layout([
      [`${SESSION}/aaaa1111-0000-0000-0000-000000000001/events.jsonl`, event("first"), 20],
      [`${SESSION}/aaaa1111-0000-0000-0000-000000000001/workspace.yaml`, "id: aaaa1111\ncwd: /work/app\nname: /pr automerge\n", 20],
      // A session directory with only its workspace file has no transcript and is never the latest.
      [`${SESSION}/bbbb2222-0000-0000-0000-000000000002/workspace.yaml`, "id: bbbb2222\nname: stub\n", 1],
    ]);

    it("takes the newest session that has a transcript for latest, and finds one by its name", async () => {
      expect((await read("copilot:latest", machineOf(COPILOT_HOME))).conversation).toBe(
        "copilot:aaaa1111-0000-0000-0000-000000000001",
      );
      expect(asks(await read("copilot:pr automerge", machineOf(COPILOT_HOME)))).toEqual(["first"]);
    });

    it("does not find a stub by its name", async () => {
      await expect(read("copilot:stub", machineOf(COPILOT_HOME))).rejects.toThrow(/no copilot session id starts with "stub"/);
    });
  });

  describe("cursor: titles come from the editor's database, by exact key, for the newest 60 sessions", () => {
    const home = temporaryDirectory();
    const PROJECT = `${home}/.cursor/projects/work-app/agent-transcripts`;
    const STATE = `${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
    const idOf = (n: number): string => `c${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
    const SESSIONS = Array.from({ length: 70 }, (_, n) => n);
    const titles: Record<number, string> = {
      3: "Refactor the billing module",
      40: "Refactor the invoice view",
      65: "Rename the legacy table",
    };
    // Session n changed n minutes ago; the 60 newest are 0..59. The transcripts are fake files, the state database a real one.
    const { files, modified } = layout([
      [STATE, "sqlite", 0],
      ...SESSIONS.map((n) => [`${PROJECT}/${idOf(n)}/${idOf(n)}.jsonl`, claudeLine(`ask ${n}`), n] as Entry),
    ]);
    database(STATE, (db) => {
      db.run("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
      for (const n of SESSIONS) {
        db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
          `composerData:${idOf(n)}`,
          // A value that is a decoy: the title is searched only by exact key, never by a scan of the values.
          JSON.stringify({ name: titles[n] ?? null, text: `value of ${n} mentions Refactor` }),
        ]);
      }
    });
    const machine = (): FakeMachine => new FakeMachine(home, files, modified);

    it("finds a session by its title among the newest 60", async () => {
      expect((await read("cursor:billing", machine())).conversation).toBe(`cursor:${idOf(3)}`);
    });

    it("refuses a title that two of the newest sessions share", async () => {
      await expect(read("cursor:refactor", machine())).rejects.toThrow(/2 sessions have a title containing "refactor"/);
    });

    it("does not look past the 60 newest sessions for a title", async () => {
      await expect(read("cursor:legacy table", machine())).rejects.toThrow(/no cursor session id starts with "legacy table"/);
    });

    it("takes the most recently modified transcript for latest and a prefix needs no database", async () => {
      expect((await read("cursor:latest", machine())).conversation).toBe(`cursor:${idOf(0)}`);
      const noDatabase = new FakeMachine(
        home,
        Object.fromEntries(Object.entries(files).filter(([path]) => path !== STATE)),
        modified,
      );
      expect((await read("cursor:c0000042", noDatabase)).conversation).toBe(`cursor:${idOf(42)}`);
    });
  });

  describe("hermes and opencode: titles and parents come from one query of their database", () => {
    const message = async (home: string, ref: string): Promise<string> =>
      (await failure(transcriptFilesTurnSource(osHostMachine(home)).readTurns(ref))).message;

    it("opencode: latest and a title skip a session a task tool started, which a prefix still finds", async () => {
      const home = temporaryDirectory();
      const user = (id: string, session: string, text: string): OpencodeMessage => ({
        id,
        session,
        role: "user",
        created: 1000,
        parts: [{ type: "text", text }],
      });
      opencodeDatabase(
        home,
        [
          { id: "ses_newest_child", title: "Refactor tests (@general subagent)", directory: "/work", updated: 3000, parent_id: "ses_parent" },
          { id: "ses_parent", title: "Refactor tests", directory: "/work", updated: 2000, parent_id: null },
          { id: "ses_old", title: "Write the docs", directory: "/work", updated: 1000, parent_id: null },
        ],
        [user("m1", "ses_newest_child", "child ask"), user("m2", "ses_parent", "parent ask"), user("m3", "ses_old", "old ask")],
      );
      const machine = osHostMachine(home);
      const source = transcriptFilesTurnSource(machine);
      expect((await source.readTurns("opencode:latest")).conversation).toBe("opencode:ses_parent");
      expect((await source.readTurns("opencode:docs")).conversation).toBe("opencode:ses_old");
      const byPrefix = await source.readTurns("opencode:ses_newest");
      expect(byPrefix.conversation).toBe("opencode:ses_newest_child");
      expect(byPrefix.turns.map((turn) => turn.text)).toEqual(["child ask"]);
      expect(await message(home, "opencode:ses_")).toContain("3 sessions start with \"ses_\"");
    });

    it("hermes: latest is the newest by last activity, a title is found, an ambiguous one is listed", async () => {
      const home = temporaryDirectory();
      hermesDatabase(
        home,
        [
          { id: "20261022_100000_aaaaaa", title: "Write commit message #1", cwd: "/work", last_activity_at: 1_000.5 },
          { id: "20261022_110000_bbbbbb", title: "Write commit message #2", cwd: "/work", last_activity_at: 2_000.5 },
          { id: "20261022_120000_cccccc", title: null, cwd: null, last_activity_at: 3_000.5 },
        ],
        [
          { session_id: "20261022_110000_bbbbbb", role: "user", content: "ask b" },
          { session_id: "20261022_120000_cccccc", role: "user", content: "ask c" },
        ],
      );
      const source = transcriptFilesTurnSource(osHostMachine(home));
      expect((await source.readTurns("hermes:latest")).conversation).toBe("hermes:20261022_120000_cccccc");
      expect(await message(home, "hermes:commit message")).toContain("2 sessions have a title containing \"commit message\"");
      const byTitle = await source.readTurns("hermes:commit message #2");
      expect(byTitle.conversation).toBe("hermes:20261022_110000_bbbbbb");
      expect(byTitle.turns.map((turn) => turn.text)).toEqual(["ask b"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// tool calls across harness record parsers

describe("transcript tool calls", () => {
  const linesOf = async function* (text: string): AsyncGenerator<string> {
    yield* text.split("\n");
  };
  async function turnsOf(text: string, parse: RecordParser): Promise<TranscriptTurn[]> {
    return (await jsonlTurns(linesOf(text), parse)).turns;
  }
  const LONG_OUTPUT_CHARS = 5000;
  const TOOL_FIXTURE = fixture("claude-tool-calls.jsonl");

  describe("claude", () => {
    it("emits a tool turn for every tool_use and tool_result block, paired by id", async () => {
      const turns = toolTurns(await turnsOf(TOOL_FIXTURE, claudeRecordTurns));
      const calls = turns.filter((turn) => turn.tool_call !== undefined);
      const results = turns.filter((turn) => turn.tool_result !== undefined);
      expect(calls).toHaveLength(9);
      expect(results.map((turn) => turn.tool_result!.id)).toEqual(calls.map((turn) => turn.tool_call!.id));
      expect(calls[2]!.tool_call).toEqual({ id: "toolu_03", name: "Bash", input: { command: "rg -n deploy scripts" } });
      expect(turns.every((turn) => turn.text === "")).toBe(true);
    });

    it("marks a failed result and keeps its output", async () => {
      const turns = toolTurns(await turnsOf(TOOL_FIXTURE, claudeRecordTurns));
      const failed = turns.find((turn) => turn.tool_result?.id === "toolu_04")!.tool_result!;
      expect(failed).toEqual({ id: "toolu_04", output: "Exit code 1\nerror: missing type", is_error: true });
    });

    it("cuts a long output to the head", async () => {
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(LONG_OUTPUT_CHARS) }] },
      });
      const [turn] = await turnsOf(line, claudeRecordTurns);
      expect(turn!.tool_result!.output).toHaveLength(TOOL_OUTPUT_HEAD_CHARS);
    });

    it("reads a result whose content is text blocks", async () => {
      const blocks = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: blocks }] },
      });
      const [turn] = await turnsOf(line, claudeRecordTurns);
      expect(turn!.tool_result).toEqual({ id: "t", output: "a\nb", is_error: false });
    });
  });

  describe("codex", () => {
    const item = (payload: object): string => JSON.stringify({ type: "response_item", payload });
    const call = (id: string, command: string[]): string =>
      item({ type: "function_call", name: "shell", call_id: id, arguments: JSON.stringify({ command }) });

    it("emits function_call and its output, failing on a non-zero exit code", async () => {
      const failedOutput = JSON.stringify({ output: "boom", metadata: { exit_code: 2 } });
      const text = [
        call("c1", ["bash", "-lc", "mise run test"]),
        item({ type: "function_call_output", call_id: "c1", output: failedOutput }),
        call("c2", ["ls"]),
        item({ type: "function_call_output", call_id: "c2", output: "file.txt" }),
      ].join("\n");
      const turns = await turnsOf(text, codexRecordTurns);
      expect(turns.map((turn) => turn.tool_call ?? turn.tool_result)).toEqual([
        { id: "c1", name: "shell", input: { command: ["bash", "-lc", "mise run test"] } },
        { id: "c1", output: "boom", is_error: true },
        { id: "c2", name: "shell", input: { command: ["ls"] } },
        { id: "c2", output: "file.txt", is_error: false },
      ]);
    });
  });

  describe("grok", () => {
    it("emits an assistant item's tool_calls after its text, then the tool_result item", async () => {
      const text = [
        JSON.stringify({
          type: "assistant",
          content: "running",
          tool_calls: [{ id: "g1", name: "run_terminal_cmd", arguments: "{\"command\":\"mise run test\"}" }],
        }),
        JSON.stringify({ type: "tool_result", tool_call_id: "g1", content: "ok" }),
      ].join("\n");
      const turns = await turnsOf(text, grokRecordTurns);
      expect(turns.map((turn) => turn.role)).toEqual(["agent", "tool", "tool"]);
      expect(turns[1]!.tool_call).toEqual({ id: "g1", name: "run_terminal_cmd", input: { command: "mise run test" } });
      expect(turns[2]!.tool_result).toEqual({ id: "g1", output: "ok", is_error: false });
    });
  });

  describe("readTranscript", () => {
    const machine = machineWith({ [`${HOME}/.claude/projects/-app/abc.jsonl`]: TOOL_FIXTURE });

    it("drops tool turns unless asked", async () => {
      const plain = await readTranscript("claude", "abc", machine);
      expect(toolTurns(plain.turns)).toEqual([]);
      const withTools = await readTranscript("claude", "abc", machine, { toolCalls: true });
      expect(toolTurns(withTools.turns)).toHaveLength(18);
    });

    it("reads the claude, codex and grok conversation fixtures with no tool turn unless asked", async () => {
      const cases: [string, RecordParser][] = [
        ["claude.jsonl", claudeRecordTurns],
        ["codex.jsonl", codexRecordTurns],
        ["grok.jsonl", grokRecordTurns],
      ];
      for (const [name, parse] of cases) {
        const parsed = await jsonlTurns(linesOf(fixture(name)), parse);
        expect(parsed.turns.length).toBeGreaterThan(0);
        expect(parsed.turns.filter((turn) => turn.role === "user" || turn.role === "agent").length).toBeGreaterThan(0);
      }
      const { turns } = await readTranscript("claude", "abc", machineWith({ [`${HOME}/.claude/projects/-app/abc.jsonl`]: fixture("claude.jsonl") }));
      expect(toolTurns(turns)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// sqlite rows

describe("queryRows on a real SQLite database", () => {
  const ROW = z.object({ id: z.string(), n: z.number().optional() });

  it("returns the rows, each validated by its shape", async () => {
    const home = temporaryDirectory();
    const path = database(`${home}/rows.db`, (db) => {
      db.run("CREATE TABLE t (id TEXT, n INTEGER)");
      db.run("INSERT INTO t VALUES ('a', 1), ('b', NULL)");
    });
    const rows = await queryRows(osHostMachine(home), path, "SELECT id, n FROM t ORDER BY id", z.object({ id: z.string(), n: z.number().nullable() }));
    expect(rows).toEqual([{ id: "a", n: 1 }, { id: "b", n: null }]);
  });

  it("throws a clear error naming the database when a row does not match its shape", async () => {
    const home = temporaryDirectory();
    const path = database(`${home}/rows.db`, (db) => {
      db.run("CREATE TABLE t (id TEXT)");
      db.run("INSERT INTO t VALUES ('a')");
      db.run("INSERT INTO t VALUES (NULL)");
    });
    await expect(queryRows(osHostMachine(home), path, "SELECT id FROM t ORDER BY rowid", ROW)).rejects.toThrow(
      `sqlite on ${path} returned rows this reader does not understand: row 1.id: expected a string, got null`,
    );
  });

  it("throws naming the database when the path cannot be opened", async () => {
    const home = temporaryDirectory();
    const path = `${home}/missing/state.db`;
    await expect(queryRows(osHostMachine(home), path, "SELECT 1", ROW)).rejects.toThrow(`sqlite on ${path} failed:`);
  });

  it("throws naming the query's own failure and does not retry it", async () => {
    const home = temporaryDirectory();
    const path = database(`${home}/rows.db`, (db) => db.run("CREATE TABLE t (id TEXT)"));
    await expect(queryRows(osHostMachine(home), path, "SELECT id FROM nope", ROW)).rejects.toThrow("no such table: nope");
  });

  it("opens a write-ahead-log database that has no -shm file by retrying it as immutable, with a path that needs escaping", async () => {
    const root = temporaryDirectory();
    const source = database(`${root}/source.db`, (db) => {
      db.run("PRAGMA journal_mode = WAL");
      db.run("CREATE TABLE t (id TEXT)");
      db.run("INSERT INTO t VALUES ('wal')");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    });
    // The directory is read-only and holds the main file alone: a read-only connection cannot create the -shm it needs.
    const directory = `${root}/x?v=1#a%/locked`;
    mkdirSync(directory, { recursive: true });
    const path = `${directory}/state.db`;
    copyFileSync(source, path);
    chmodSync(directory, 0o555);
    try {
      expect(await queryRows(osHostMachine(root), path, "SELECT id FROM t", ROW)).toEqual([{ id: "wal" }]);
    } finally {
      chmodSync(directory, 0o755);
    }
  });
});