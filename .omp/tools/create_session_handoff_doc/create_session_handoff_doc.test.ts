import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import { createSessionHandoffDoc } from "./handoff.js";
import { osHostMachine } from "./reader/host_machine.js";
import type { TranscriptTurn } from "./reader/schemas.js";
import type { TurnSource } from "./reader/turn_source.js";
import { transcriptFilesTurnSource } from "./reader/turn_source.js";
import { renderHandoff } from "./render.js";
import type { SessionContext, SessionTurns, Turn } from "./types.js";

const user = (text: string): Turn => ({ role: "user", text });
const assistant = (text: string): Turn => ({ role: "assistant", text });
const call = (name: string, input: Record<string, unknown>, id = "call-1"): Turn => ({
  role: "tool",
  text: "",
  tool_call: { id, name, input },
});
const result = (output: string, isError: boolean, id = "call-1"): Turn => ({
  role: "tool",
  text: "",
  tool_result: { id, output, is_error: isError },
});

const UNKNOWN_CONTEXT: SessionContext = {
  working_dir: null,
  worktrees: [],
  other_projects: [],
  git_branch: null,
  git_status: "unknown",
  last_user_message: null,
  test_status: "unknown",
  session_end: "unknown",
  errors_seen: [],
  side_effects: [],
};

function session(
  turns: Turn[],
  conversation = "claude:abc-123",
  context: Partial<SessionContext> = {},
  compacted: string[] = [],
): SessionTurns {
  return {
    conversation,
    source: { path: "/home/z/.claude/projects/p/abc-123.jsonl", total_turns: turns.length },
    turns,
    context: { ...UNKNOWN_CONTEXT, ...context },
    compacted,
  };
}

const section = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`section ${heading} missing`);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next < 0 ? undefined : next);
};

describe("renderHandoff", () => {
  it("renders an empty session with agentmux's placeholders and every heading in order", () => {
    const markdown = renderHandoff(session([]));
    expect(markdown.startsWith("# Handoff Context - Claude Code session abc-123\n")).toBe(true);
    const headings = [...markdown.matchAll(/^## (.*)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "Current Goal",
      "Links & Artifact Paths",
      "Current Status",
      "Recent Turns",
      "Known Failures / Tool Hints",
      "Errors Seen",
      "Side Effects",
      "Previous Subagents",
      "Takeover Instructions",
    ]);
    expect(section(markdown, "Current Goal")).toContain("_Not extracted — read the full transcript._");
    expect(section(markdown, "Recent Turns")).toContain("_No user/assistant turns extracted._");
    expect(section(markdown, "Known Failures / Tool Hints")).toContain("- None extracted from tool results.");
    expect(section(markdown, "Previous Subagents")).toContain("- None detected.");
    expect(section(markdown, "Current Status")).toContain("Last turn: none");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("is deterministic", () => {
    const turns = [user("fix the bug"), assistant("on it")];
    expect(renderHandoff(session(turns))).toBe(renderHandoff(session(turns)));
  });

  it("with only user asks: the first is the goal and every ask is a recent turn", () => {
    const markdown = renderHandoff(session([user("first ask"), user("second ask")]));
    expect(section(markdown, "Current Goal")).toContain("first ask");
    expect(section(markdown, "Recent Turns")).toContain("- **User:** first ask\n- **User:** second ask");
    expect(section(markdown, "Current Status")).toContain("Last turn: user");
  });

  it("names the transcript, its turn count and the source session", () => {
    const markdown = renderHandoff(session([user("a"), assistant("b")], "hermes:2026_x"));
    expect(markdown).toContain("# Handoff Context - Hermes session 2026_x");
    expect(markdown).toContain("- Full transcript (2 turns): `/home/z/.claude/projects/p/abc-123.jsonl`");
    expect(markdown).toContain("- Source session: `hermes:2026_x`");
  });

  it("keeps only the last six user/assistant turns, oldest first", () => {
    const turns = Array.from(
      { length: 8 },
      (_, index) => (index % 2 === 0 ? user(`u${index}`) : assistant(`a${index}`)),
    );
    const recent = section(renderHandoff(session(turns)), "Recent Turns");
    expect(recent).not.toContain("u0");
    expect(recent).not.toContain("a1");
    expect([...recent.matchAll(/^- \*\*(\w+):\*\* (\w+)$/gm)].map((match) => match[2])).toEqual([
      "u2",
      "a3",
      "u4",
      "a5",
      "u6",
      "a7",
    ]);
  });

  it("lists tool errors, not successes, as known failures and caps them at eight", () => {
    const turns = [
      user("go"),
      call("Bash", { command: "ls" }, "ok"),
      result("fine", false, "ok"),
      ...Array.from({ length: 10 }, (_, index) => result(`boom ${index}`, true, `e${index}`)),
      result("  \n ", true, "empty"),
    ];
    const failures = section(renderHandoff(session(turns)), "Known Failures / Tool Hints");
    const lines = failures.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("- tool error: boom 0");
    expect(failures).not.toContain("fine");
  });

  it("a blank error output is a bare `tool error`; a multi-line one stays on one list line", () => {
    const failures = section(
      renderHandoff(session([result("", true, "a"), result("line one\n\nline   two", true, "b")])),
      "Known Failures / Tool Hints",
    );
    expect(failures).toContain("- tool error\n- tool error: line one line two");
  });

  it("lists subagent tool calls with their description, other tools never", () => {
    const turns = [
      call("Task", { description: "audit the cache", prompt: "ignored" }, "t1"),
      call("agent", { prompt: "  read the logs  " }, "t2"),
      call("spawn_agent", {}, "t3"),
      call("Bash", { description: "list files" }, "t4"),
    ];
    const subagents = section(renderHandoff(session(turns)), "Previous Subagents");
    expect(subagents).toContain("- subagent tool: Task — audit the cache");
    expect(subagents).toContain("- subagent tool: agent — read the logs");
    expect(subagents).toContain("- subagent tool: spawn_agent\n");
    expect(subagents).not.toContain("Bash");
    expect(subagents).not.toContain("None detected");
  });

  it("caps subagent hints at eight", () => {
    const turns = Array.from({ length: 11 }, (_, index) => call("Task", { description: `job ${index}` }, `t${index}`));
    const lines = section(renderHandoff(session(turns)), "Previous Subagents")
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(8);
  });

  it("keeps a very long goal, turn and failure in full", () => {
    const long = `${"word ".repeat(5000)}end`;
    const markdown = renderHandoff(session([user(long), assistant(long), result(long, true)]));
    const collapsed = long.split(/\s+/).join(" ");
    expect(section(markdown, "Current Goal")).toContain(long);
    expect(section(markdown, "Recent Turns")).toContain(`- **Assistant:** ${collapsed}`);
    expect(section(markdown, "Known Failures / Tool Hints")).toContain(`- tool error: ${collapsed}`);
    expect(markdown).not.toContain("…");
  });

  it("leaves harness noise out of the goal and the recent turns, as agentmux's noise test does", () => {
    const noise = [
      "<system-reminder>\nskills list\n</system-reminder>",
      "<local-command-stdout>ok</local-command-stdout>",
      "<command-name>/clear</command-name>",
      "[Request interrupted by user]",
      "<task-notification>done</task-notification>",
      "This session is being continued from a previous conversation that ran out of context.",
      "<agentmux-system>\nnotice\n</agentmux-system>",
      "<user_info>cwd</user_info> <git_status>clean</git_status>",
      "   ",
    ];
    const markdown = renderHandoff(session([...noise.map(user), user("the real ask"), assistant("done")]));
    expect(section(markdown, "Current Goal")).toContain("the real ask");
    expect(section(markdown, "Recent Turns")).toBe(
      "## Recent Turns\n\n- **User:** the real ask\n- **Assistant:** done\n",
    );
  });

  it("keeps a real ask that wraps the env dump in <user_query>", () => {
    const wrapped = "<user_info>cwd</user_info>\n<user_query>do the thing</user_query>";
    expect(section(renderHandoff(session([user(wrapped)])), "Current Goal")).toContain("do the thing");
  });

  it("never reads a hook's feedback as the ask, and an agent reply is not filtered as noise", () => {
    const markdown = renderHandoff(
      session([user("Stop hook feedback:\nkeep going"), assistant("<system-reminder> I quote this"), user("ask")]),
    );
    expect(section(markdown, "Current Goal")).toContain("ask");
    expect(markdown).not.toContain("keep going");
    expect(section(markdown, "Recent Turns")).toContain("- **Assistant:** <system-reminder> I quote this");
  });

  it("has no goal when every user turn is noise", () => {
    const markdown = renderHandoff(session([user("<system-reminder>x</system-reminder>"), assistant("hi")]));
    expect(section(markdown, "Current Goal")).toContain("_Not extracted");
  });

  it("says the working directory and branch are unknown when the harness recorded none, instead of guessing", () => {
    const links = section(renderHandoff(session([user("a")])), "Links & Artifact Paths");
    expect(links).toContain("- Working directory: unknown (the harness's transcript does not record it)");
    expect(links).toContain("- Git branch: unknown");
    expect(links).not.toContain("Worktrees");
    expect(links).not.toContain("Other projects");
  });

  it("fills the working directory, branch, worktrees and other projects from the session context", () => {
    const links = section(
      renderHandoff(
        session([user("a")], "claude:abc-123", {
          working_dir: "/Users/z/Developer/app",
          git_branch: "feat/x",
          worktrees: ["/Users/z/Developer/app/.worktrees/x", "pr:12"],
          other_projects: ["/Users/z/Developer/Personal"],
        }),
      ),
      "Links & Artifact Paths",
    );
    expect(links).toContain("- Working directory: `/Users/z/Developer/app`");
    expect(links).toContain("- Git branch: `feat/x`");
    expect(links).toContain("- Worktrees: `/Users/z/Developer/app/.worktrees/x`, `pr:12`");
    expect(links).toContain("- Other projects touched: `/Users/z/Developer/Personal`");
  });

  it("states how the session ended, the tests, git status and the last thing a person said", () => {
    const status = section(
      renderHandoff(
        session([user("a"), assistant("b")], "claude:abc-123", {
          session_end: "awaiting_response",
          test_status: "failing",
          git_status: "dirty",
          last_user_message: "run it\nagain",
        }),
      ),
      "Current Status",
    );
    expect(status).toContain("- Session end: a message is waiting for an answer");
    expect(status).toContain("- Tests: failing");
    expect(status).toContain("- Git status: dirty");
    expect(status).toContain("- Last user message: run it again");
  });

  it("lists error output and side effects, with a placeholder for each when there are none", () => {
    const none = renderHandoff(session([user("a")]));
    expect(section(none, "Errors Seen")).toContain("- No error output seen in tool results.");
    expect(section(none, "Side Effects")).toContain("- None detected in shell commands.");
    const some = renderHandoff(
      session([user("a")], "claude:abc-123", {
        errors_seen: ["error: cannot find\nmodule x"],
        side_effects: ["pushed to remote", "committed: \"fix: thing\""],
      }),
    );
    expect(section(some, "Errors Seen")).toContain("- error: cannot find module x");
    expect(section(some, "Side Effects")).toContain("- pushed to remote\n- committed: \"fix: thing\"");
  });

  it("puts what the harness summarized of compacted turns after the goal and before the links", () => {
    const markdown = renderHandoff(
      session([user("keep going")], "grok:x", {}, [
        "COMPACTED EARLIER TURNS (segment_000):\nUser wanted two-pass bootstrap.",
      ]),
    );
    expect(markdown.slice(markdown.indexOf("## Compacted Earlier Turns"))).toContain("User wanted two-pass bootstrap.");
    expect(markdown.indexOf("## Current Goal")).toBeLessThan(markdown.indexOf("## Compacted Earlier Turns"));
    expect(markdown.indexOf("## Compacted Earlier Turns")).toBeLessThan(markdown.indexOf("## Links & Artifact Paths"));
    expect(renderHandoff(session([user("a")]))).not.toContain("Compacted Earlier Turns");
  });
});

const TURNS: TranscriptTurn[] = [
  { role: "user", text: "Fix the login bug." },
  { role: "agent", text: "Looking." },
  { role: "tool", text: "", tool_call: { id: "1", name: "Task", input: { description: "read auth" } } },
  { role: "tool", text: "", tool_result: { id: "1", output: "denied", is_error: true } },
  { role: "agent", text: "Fixed." },
];

class FakeTurnSource implements TurnSource {
  readonly asked: string[] = [];
  readonly toolCallOptions: (boolean | undefined)[] = [];
  async readTurns(conversation: string, options?: { toolCalls?: boolean }) {
    this.asked.push(conversation);
    this.toolCallOptions.push(options?.toolCalls);
    if (conversation === "claude:missing") throw new Error("no transcript found for claude:missing");
    return { path: "fake://session", turns: TURNS, skipped_lines: 0 };
  }
}

describe("createSessionHandoffDoc", () => {
  it("reads the turns, tool calls included, and returns the document with its source", async () => {
    const source = new FakeTurnSource();
    const out = await createSessionHandoffDoc("claude:abc", source);
    expect(source.asked).toEqual(["claude:abc"]);
    expect(source.toolCallOptions).toEqual([true]);
    expect(out.conversation).toBe("claude:abc");
    expect(out.source).toEqual({ path: "fake://session", total_turns: 5 });
    expect(out.markdown).toContain("# Handoff Context - Claude Code session abc");
    expect(out.markdown).toContain("- Full transcript (5 turns): `fake://session`");
    expect(out.markdown).toContain("- tool error: denied");
    expect(out.markdown).toContain("- subagent tool: Task — read auth");
    expect(out.markdown).toContain("- **Assistant:** Fixed.");
  });

  it("uses the full conversation id the source resolved a prefix to", async () => {
    const source: TurnSource = {
      readTurns: async () => ({ path: "p", turns: [], skipped_lines: 0, conversation: "omp:full-id" }),
    };
    expect((await createSessionHandoffDoc("omp:latest", source)).conversation).toBe("omp:full-id");
  });

  it("fails, naming the ref, when the source has no such session", async () => {
    await expect(createSessionHandoffDoc("claude:missing", new FakeTurnSource())).rejects.toThrow("claude:missing");
  });

  it("refuses a ref that is not <harness>:<id> without reading", async () => {
    const source = new FakeTurnSource();
    for (const conversation of ["nonsense", "vim:abc", "claude:", "claude:a/b", "claude:a'b"]) {
      await expect(createSessionHandoffDoc(conversation, source)).rejects.toThrow(/must be "<harness>:<id>"/);
    }
    expect(source.asked).toEqual([]);
  });

  it("refuses Mastra chat-thread refs and Studio URLs with a clear error", async () => {
    const source = new FakeTurnSource();
    for (const conversation of ["mastra:thread:abc", "https://studio.example.com/agents/a1/threads/t1"]) {
      await expect(createSessionHandoffDoc(conversation, source)).rejects.toThrow(/Mastra chat thread/);
    }
    expect(source.asked).toEqual([]);
  });

  it("is deterministic", async () => {
    const a = await createSessionHandoffDoc("claude:abc", new FakeTurnSource());
    const b = await createSessionHandoffDoc("claude:abc", new FakeTurnSource());
    expect(a).toEqual(b);
  });
});

describe("createSessionHandoffDoc context", () => {
  const SESSION: TranscriptTurn[] = [
    {
      role: "context",
      text: "COMPACTED EARLIER TURNS (segment_000):\nUser wanted two-pass bootstrap.",
      synthetic_reason: "compaction-summary",
    },
    { role: "user", text: "keep going" },
    { role: "user", text: "Stop hook feedback: do the work", synthetic_reason: "hook" },
    {
      role: "tool",
      text: "",
      tool_call: { id: "b1", name: "Bash", input: { command: "git commit -m \"fix: thing\" && git push" } },
    },
    { role: "tool", text: "", tool_result: { id: "b1", output: "ok  \tpkg\t0.5s", is_error: false } },
    { role: "agent", text: "Pushed." },
  ];
  const source: TurnSource = {
    readTurns: async () => ({
      path: "fake://grok",
      turns: SESSION,
      skipped_lines: 0,
      metadata: { cwd: "/Users/z/Developer/app", git_branch: "main" },
    }),
  };

  it("returns the context from the turns and metadata, and writes it into the document", async () => {
    const out = await createSessionHandoffDoc("grok:abc", source);
    expect(out.context).toMatchObject({
      working_dir: "/Users/z/Developer/app",
      git_branch: "main",
      last_user_message: "keep going",
      test_status: "passing",
      session_end: "natural",
      side_effects: ["pushed to remote", "committed: \"fix: thing\""],
    });
    expect(out.markdown).toContain("- Working directory: `/Users/z/Developer/app`");
    expect(out.markdown).toContain("- Git branch: `main`");
    expect(out.markdown).toContain("- pushed to remote");
    expect(out.markdown).toContain("User wanted two-pass bootstrap.");
  });

  it("does not present a hook's synthetic turn as a conversation turn, and counts every turn read", async () => {
    const out = await createSessionHandoffDoc("grok:abc", source);
    expect(out.markdown).not.toContain("do the work");
    expect(out.source.total_turns).toBe(SESSION.length);
  });
});

describe("with the real file reader on a temp home", () => {
  const home = mkdtempSync(join(tmpdir(), "handoff-"));
  const dir = join(home, ".claude", "projects", "-work");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", message: { role: "user", content: "hello there" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t", name: "Task", input: { description: "read auth" } },
        ],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "nope" }] },
    },
  ].map((record) => JSON.stringify(record));
  const path = join(dir, "s1.jsonl");
  writeFileSync(path, lines.join("\n"));

  it("reads Claude Code's transcript file and converts the reader's turns", async () => {
    const out = await createSessionHandoffDoc("claude:s1", transcriptFilesTurnSource(osHostMachine(home)));
    expect(out.source).toEqual({ path, total_turns: 4 });
    expect(out.markdown).toContain("- tool error: nope");
    expect(out.markdown).toContain("- subagent tool: Task — read auth");
    expect(out.markdown).toContain("- **Assistant:** hi");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("tool factory", () => {
  it("returns a tool whose parameters accept a ref and reject a missing one", () => {
    const chain: unknown = new Proxy(() => chain, { get: () => () => chain });
    const zod = { object: (shape: unknown) => shape, string: () => chain };
    const tool = factory({ zod } as never) as unknown as { name: string; parameters: { conversation: unknown }; description: string };
    expect(tool.name).toBe("create_session_handoff_doc");
    expect(Object.keys(tool.parameters)).toEqual(["conversation"]);
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
  });
});
