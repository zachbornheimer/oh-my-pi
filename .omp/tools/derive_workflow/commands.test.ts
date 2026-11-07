import { describe, expect, it } from "bun:test";
import { commandLabel, commandOf, isReadOnlyCommand } from "./commands.ts";

describe("isReadOnlyCommand", () => {
  it.each([
    "cat README.md",
    "ls -la src",
    "rg -n deploy scripts | head -5",
    "grep -r foo .",
    "head -20 file.txt",
    "sed -n '1,20p' file.txt",
    "git status --short",
    "git log --oneline",
    "git diff HEAD~1",
    "cd /tmp && ls",
    "ls 2>/dev/null",
    "FOO=1 cat file",
  ])("%s only looks", (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    "mise run build",
    "git commit -m x",
    "git push",
    "sed -i 's/a/b/' file",
    "cat a > b",
    "ls && mise run test",
    "rg foo | tee out.txt",
    "webmaster check bpp",
  ])("%s changes something", (command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});

describe("commandOf", () => {
  it("reads a string command, a cmd, and an argv", () => {
    expect(commandOf({ command: "mise run test" })).toBe("mise run test");
    expect(commandOf({ cmd: "ls" })).toBe("ls");
    expect(commandOf({ command: ["bash", "-lc", "mise run test"] })).toBe("mise run test");
    expect(commandOf({ command: ["git", "status"] })).toBe("git status");
  });

  it("gives nothing for a call that names no command", () => {
    expect(commandOf({})).toBeUndefined();
    expect(commandOf({ command: "  " })).toBeUndefined();
    expect(commandOf({ command: [1, 2] })).toBeUndefined();
  });
});

describe("commandLabel", () => {
  it("names a command by its program and its subcommand", () => {
    expect(commandLabel("webmaster check {site} --format=md")).toBe("webmaster check");
    expect(commandLabel("FOO=1 scripts/smoke.sh shop.example.com")).toBe("scripts/smoke.sh");
    expect(commandLabel("cd x && mise run build")).toBe("cd x");
  });
});
