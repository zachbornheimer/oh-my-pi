import { describe, expect, it } from "bun:test";
import type { SessionMetadata, TranscriptTurn } from "./reader/schemas.js";
import { sessionContextOf } from "./reader/session_context.js";
import type { SessionContext } from "./reader/session_context.js";

const user = (text: string, extra: Partial<TranscriptTurn> = {}): TranscriptTurn => ({ role: "user", text, ...extra });
const agent = (text: string): TranscriptTurn => ({ role: "agent", text });
const call = (name: string, input: Record<string, unknown>, id = "c1"): TranscriptTurn => ({
  role: "tool",
  text: "",
  tool_call: { id, name, input },
});
const result = (output: string, id = "c1", isError = false): TranscriptTurn => ({
  role: "tool",
  text: "",
  tool_result: { id, output, is_error: isError },
});
const bash = (command: string): TranscriptTurn[] => [call("Bash", { command })];
const contextOf = (turns: TranscriptTurn[], metadata?: SessionMetadata): SessionContext =>
  sessionContextOf({ turns, metadata });

describe("worktrees, branches and commits from git and wt commands (the Python tests of extract-context.py)", () => {
  it("git worktree add records the path", () => {
    expect(contextOf(bash("git worktree add .claude/worktrees/foo")).worktrees).toEqual([".claude/worktrees/foo"]);
  });

  it("git worktree add skips a branch flag and records the path", () => {
    expect(contextOf(bash("git worktree add -b wip/x /path/to/wt sha")).worktrees).toEqual(["/path/to/wt"]);
  });

  it("wt switch --create records the branch as worktree and branch", () => {
    const ctx = contextOf(bash("wt switch --create feature-x --no-cd --format=json"));
    expect(ctx.worktrees).toEqual(["feature-x"]);
    expect(ctx.git_branch).toBe("feature-x");
  });

  it("wt switch pr:12 records the PR ref, after wt's own -C flag", () => {
    const ctx = contextOf(bash("wt -C /repo switch pr:12 --no-cd"));
    expect(ctx.worktrees).toEqual(["pr:12"]);
    expect(ctx.git_branch).toBe("pr:12");
  });

  it("wt step commit is a committed side effect", () => {
    expect(contextOf(bash("wt step commit")).side_effects).toEqual(["committed"]);
  });

  it("git commit keeps a simple -m message", () => {
    expect(contextOf(bash("git commit -m \"fix: thing\"")).side_effects).toEqual(["committed: \"fix: thing\""]);
  });

  it("wt list is not a worktree", () => {
    expect(contextOf(bash("wt list")).worktrees).toEqual([]);
  });

  it("git checkout and switch name the branch; the last one wins; a flag's value is skipped by wt only", () => {
    expect(contextOf([...bash("git checkout main"), ...bash("git switch feature/y")]).git_branch).toBe("feature/y");
    expect(contextOf(bash("git checkout main && git pull")).git_branch).toBe("main");
  });
});

describe("side effects (extract-context.py's detection rules)", () => {
  it.each<[string, string, string[]]>([
    ["a push", "git push origin main", ["pushed to remote"]],
    ["a commit with a single-quoted message", "git commit -m 'feat: x'", ["committed: \"feat: x\""]],
    ["a commit whose message is a heredoc", "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"", ["committed"]],
    ["a pull request", "gh pr create --title \"Add thing\" --body x", ["opened PR: \"Add thing\""]],
    ["a pull request with no title", "gh pr create --fill", ["opened PR"]],
    ["a merge", "gh pr merge 12 --squash --title 'Ship it'", ["merged PR: \"Ship it\""]],
    ["atlas", "atlas migrate apply --env prod", ["applied migration"]],
    ["a make target", "make migrate", ["applied migration"]],
    ["a migration file", "psql -f migrations/0042_add.sql", ["applied migration"]],
    ["a push and a commit, in that order", "git commit -m \"a\" && git push", ["pushed to remote", "committed: \"a\""]],
    ["nothing", "ls -la", []],
  ])("%s", (_name, command, expected) => {
    expect(contextOf(bash(command)).side_effects).toEqual(expected);
  });

  it("does not repeat a side effect, and git worktree add is a worktree, not a side effect", () => {
    const ctx = contextOf([...bash("git push"), ...bash("git push"), ...bash("git worktree add ../wt")]);
    expect(ctx.side_effects).toEqual(["pushed to remote"]);
    expect(ctx.worktrees).toEqual(["../wt"]);
  });

  it("an agent's isolated worktree is recorded once", () => {
    const ctx = contextOf([
      call("Agent", { isolation: "worktree" }, "a"),
      call("Agent", { isolation: "worktree" }, "b"),
    ]);
    expect(ctx.worktrees).toEqual(["(auto-managed worktree)"]);
  });

  it("only a shell tool's command counts; prose and other tools that mention a command do not", () => {
    const ctx = contextOf([
      agent("then I will run git push"),
      call("Write", { file_path: "/tmp/notes.md", content: "git push" }),
      user("please git push"),
    ]);
    expect(ctx.side_effects).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["Bash", { command: "git push" }],
    ["Shell", { command: "git push" }],
    ["bash", { command: "git push", description: "push" }],
    ["run_terminal_command", { command: "git push" }],
    ["exec_command", { cmd: "git push" }],
    ["shell", { command: ["bash", "-lc", "git push"] }],
    ["exec", { raw: "const r = await tools.exec_command({cmd:\"git push\"});" }],
    ["mcp__agentmux__agentmux_run", { command: "git push" }],
    ["mcp__capability_agentmux_capability_run_command", { command: "git push" }],
    ["terminal", { command: "git push" }],
  ])("reads the command of the shell tool %s", (name, input) => {
    expect(contextOf([call(name, input)]).side_effects).toEqual(["pushed to remote"]);
  });
});

describe("the working directory and branch are what the harness recorded", () => {
  it("takes both from the metadata and never from commands for the directory", () => {
    const ctx = contextOf(bash("cd /elsewhere && git checkout other"), {
      cwd: "/Users/z/Developer/app",
      git_branch: "main",
    });
    expect(ctx.working_dir).toBe("/Users/z/Developer/app");
    expect(ctx.git_branch).toBe("main");
  });

  it("falls back to the branch a command named only when the harness recorded none", () => {
    expect(contextOf(bash("git checkout feat/z"), { cwd: "/Users/z/Developer/app" }).git_branch).toBe("feat/z");
  });

  it("leaves both unknown when nothing says", () => {
    const ctx = contextOf([user("hi"), agent("hello")]);
    expect(ctx.working_dir).toBeNull();
    expect(ctx.git_branch).toBeNull();
  });
});

describe("other projects", () => {
  const metadata = { cwd: "/Users/z/Developer/Personal/app" };

  it("records the project root (five path components) of a file outside the working directory", () => {
    const ctx = contextOf(
      [
        call("Read", { file_path: "/Users/z/Developer/Other/lib/src/x.ts" }),
        call("Edit", { file_path: "/Users/z/Developer/Other/lib/y.ts" }, "c2"),
      ],
      metadata,
    );
    expect(ctx.other_projects).toEqual(["/Users/z/Developer/Other"]);
  });

  it.each<[string, string]>([
    ["a file inside the working directory", "/Users/z/Developer/Personal/app/src/a.ts"],
    ["a file under a system directory", "/tmp/scratch/a/b/c.ts"],
    ["a file in a tool's config directory", "/Users/z/.claude/skills/x/SKILL.md"],
    ["a path too short to name a project", "/Users/z/notes.md"],
    ["a relative path", "src/a.ts"],
  ])("ignores %s", (_name, file_path) => {
    expect(contextOf([call("Read", { file_path })], metadata).other_projects).toEqual([]);
  });

  it("ignores a directory above the working directory, and everything when the directory is unknown", () => {
    expect(contextOf([call("Read", { file_path: "/Users/z/Developer/Personal/other.md" })], metadata).other_projects)
      .toEqual([]);
    expect(contextOf([call("Read", { file_path: "/Users/z/Developer/Other/lib/x.ts" })]).other_projects).toEqual([]);
  });

  it("reads the path of other harnesses' file tools", () => {
    expect(contextOf([call("read", { path: "/Users/z/Developer/Other/lib/x.ts" })], metadata).other_projects).toEqual([
      "/Users/z/Developer/Other",
    ]);
  });
});

describe("tests and errors", () => {
  it("Go: a --- FAIL line is failing and the output is an error; a later ok line does not undo it", () => {
    const ctx = contextOf([
      call("Bash", { command: "go test ./..." }),
      result("--- FAIL: TestX (0.00s)\nFAIL"),
      result("ok  \tpkg\t0.512s", "c2"),
    ]);
    expect(ctx.test_status).toBe("failing");
    expect(ctx.errors_seen).toEqual(["--- FAIL: TestX (0.00s)\nFAIL"]);
  });

  it("Go: an ok line is passing", () => {
    expect(contextOf([result("ok  \tgithub.com/z/pkg\t1.250s")]).test_status).toBe("passing");
  });

  it("FAILED on a test output is failing; PASSED is passing only while nothing is known", () => {
    expect(contextOf([result("3 tests FAILED")]).test_status).toBe("failing");
    expect(contextOf([result("all PASSED")]).test_status).toBe("passing");
    expect(contextOf([result("3 tests FAILED"), result("all PASSED", "c2")]).test_status).toBe("failing");
  });

  it("error, panic and fatal lines are errors, each cut to 500 characters, the last five kept", () => {
    const outputs = Array.from({ length: 7 }, (_, n) => result(`error: problem ${n} ${"x".repeat(600)}`, `c${n}`));
    const ctx = contextOf(outputs);
    expect(ctx.errors_seen).toHaveLength(5);
    expect(ctx.errors_seen[0]?.startsWith("error: problem 2")).toBe(true);
    expect(ctx.errors_seen.every((snippet) => snippet.length === 500)).toBe(true);
    expect(contextOf([result("panic: boom"), result("fatal: not a repo", "c2")]).errors_seen).toEqual([
      "panic: boom",
      "fatal: not a repo",
    ]);
  });

  it("a clean run is unknown, with no errors", () => {
    const ctx = contextOf([result("built in 2s")]);
    expect(ctx.test_status).toBe("unknown");
    expect(ctx.errors_seen).toEqual([]);
  });

  it("a transcript with no tool results (Cursor's) shows its test runs only in what the agent said", () => {
    expect(contextOf([agent("the suite FAILED: 2 tests broke")]).test_status).toBe("failing");
    // With tool results, agent prose is not evidence of a run.
    expect(contextOf([agent("the suite FAILED"), result("fine")]).test_status).toBe("unknown");
  });
});

describe("git status", () => {
  const statusCall = (
    output: string,
  ): TranscriptTurn[] => [call("Bash", { command: "git status" }, "s"), result(output, "s")];

  it("reads the last git status run: clean, dirty, long form or porcelain", () => {
    expect(contextOf(statusCall("On branch main\nnothing to commit, working tree clean")).git_status).toBe("clean");
    expect(contextOf(statusCall("On branch main\nChanges not staged for commit:\n\tmodified: a.ts")).git_status).toBe(
      "dirty",
    );
    expect(contextOf(statusCall(" M src/a.ts\n?? new.ts")).git_status).toBe("dirty");
    expect(
      contextOf([...statusCall(" M a.ts"), ...statusCall("nothing to commit, working tree clean").map((turn) => turn)])
        .git_status,
    ).toBe("clean");
  });

  it("is unknown when no git status ran, and a result of another command says nothing", () => {
    expect(contextOf([call("Bash", { command: "ls" }, "l"), result("Changes not staged for commit:", "l")]).git_status)
      .toBe("unknown");
  });
});

describe("the last user message is a person's, never the harness's", () => {
  it("skips hook feedback, interruptions, task notifications, reminders and synthetic turns (Stop-hook feedback is not the last message)", () => {
    const ctx = contextOf([
      user("deploy it"),
      agent("done"),
      user("Stop hook feedback:\nkeep going"),
      user("[Request interrupted by user]"),
      user("<task-notification>x</task-notification>"),
      user("<system-reminder>r</system-reminder>"),
      user("injected by a hook", { synthetic_reason: "hook" }),
    ]);
    expect(ctx.last_user_message).toBe("deploy it");
  });

  it("is the whole text of the last human turn, trimmed", () => {
    const long = `${"word ".repeat(500)}end`;
    expect(contextOf([user("first"), user(`  ${long}  `)]).last_user_message).toBe(long);
  });

  it("is null when no person spoke", () => {
    expect(contextOf([agent("hello")]).last_user_message).toBeNull();
  });
});

describe("how the session ended", () => {
  it.each<[string, TranscriptTurn[], SessionContext["session_end"]]>([
    ["an agent reply", [user("a"), agent("b")], "natural"],
    ["a user message", [user("a"), agent("b"), user("c")], "awaiting_response"],
    ["an agent's tool call", [user("a"), call("Bash", { command: "ls" })], "natural"],
    ["a tool result", [user("a"), call("Bash", { command: "ls" }), result("x")], "unknown"],
    ["no turns", [], "unknown"],
    ["a context marker after a reply", [user("a"), agent("b"), {
      role: "context",
      text: "",
      synthetic_reason: "run-ended",
    }], "natural"],
  ])("ending on %s is %s", (_name, turns, expected) => {
    expect(contextOf(turns).session_end).toBe(expected);
  });
});

describe("cost", () => {
  it("reads a session of 50,000 turns with large outputs in one linear pass", () => {
    const turns: TranscriptTurn[] = [];
    for (let n = 0; n < 50_000; n += 1) {
      turns.push(call("Bash", { command: `echo ${n}` }, `c${n}`), result("x".repeat(2000), `c${n}`));
    }
    const started = performance.now();
    expect(contextOf(turns, { cwd: "/Users/z/Developer/Personal/app" }).session_end).toBe("unknown");
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
