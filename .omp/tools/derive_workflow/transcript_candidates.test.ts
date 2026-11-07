import { describe, expect, it } from "bun:test";
import { transcriptCandidates } from "./transcript_candidates.ts";
import type { TranscriptTurn } from "./schemas.ts";
import { fixtureTurns } from "./test_world.ts";

const call = (id: string, name: string, input: Record<string, unknown>): TranscriptTurn => ({
  role: "tool",
  text: "",
  tool_call: { id, name, input },
});
const result = (id: string, output: string, isError = false): TranscriptTurn => ({
  role: "tool",
  text: "",
  tool_result: { id, output, is_error: isError },
});
const bash = (id: string, command: string, output = "ok", isError = false): TranscriptTurn[] => [
  call(id, "Bash", { command }),
  result(id, output, isError),
];

describe("transcriptCandidates on the scrubbed session", () => {
  it("keeps the edit and the commands that ran, in order, and counts what it left out", async () => {
    const found = transcriptCandidates(await fixtureTurns());
    expect(found.candidates.map((candidate) => candidate.edit ?? candidate.command)).toEqual([
      "/Users/someone/src/app/types.ts",
      "mise run build",
      "/Users/someone/src/app/scripts/deploy.sh shop.example.com --prod",
      "curl -fsS https://shop.example.com/health",
      "scripts/smoke.sh shop.example.com",
    ]);
    expect(found.dropped).toEqual({ reads: 3, retries: 1, failed: 0 });
    expect(found.seen).toBe(9);
  });

  it("drops the pure reads: Read, ls and rg", async () => {
    const found = transcriptCandidates(await fixtureTurns());
    const commands = found.candidates.map((candidate) => candidate.command ?? "");
    expect(commands.some((command) => /^(ls|rg|cat)\b/.test(command))).toBe(false);
  });

  it("keeps the success of a command that failed first, once, marked retried, with its own evidence", async () => {
    const turns = await fixtureTurns();
    const build = transcriptCandidates(turns).candidates.filter((candidate) => candidate.command === "mise run build");
    expect(build).toHaveLength(1);
    expect(build[0]!.retried).toBe(true);
    const [evidence] = build[0]!.evidence;
    expect(evidence).toEqual({ turn_id: expect.any(Number), call_id: "toolu_06" });
    expect(turns[(evidence as { turn_id: number }).turn_id - 1]!.tool_call!.id).toBe("toolu_06");
  });

  it("titles a command by its description, else by what it runs", async () => {
    const titles = transcriptCandidates(await fixtureTurns()).candidates.map((candidate) => candidate.title);
    expect(titles).toEqual([
      "Edit types.ts",
      "Build the app",
      "Deploy to production",
      "Run curl",
      "Run scripts/smoke.sh",
    ]);
  });
});

describe("transcriptCandidates retries and failures", () => {
  it("keeps only the last of a command that succeeded twice", () => {
    const turns = [...bash("a", "mise run test"), ...bash("b", "mise run lint"), ...bash("c", "mise run test")];
    const found = transcriptCandidates(turns);
    expect(found.candidates.map((candidate) => candidate.command)).toEqual(["mise run lint", "mise run test"]);
    expect(found.candidates[1]!.retried).toBe(true);
    expect(found.dropped.retries).toBe(1);
  });

  it("collapses a command that failed twice then succeeded to the success", () => {
    const turns = [
      ...bash("a", "mise run  build", "Exit code 1", true),
      ...bash("b", "mise run build", "Exit code 2", true),
      ...bash("c", "mise run build"),
    ];
    const found = transcriptCandidates(turns);
    expect(found.candidates).toHaveLength(1);
    expect(found.candidates[0]!.evidence).toEqual([{ turn_id: 5, call_id: "c" }]);
    expect(found.dropped).toEqual({ reads: 0, retries: 2, failed: 0 });
  });

  it("drops a command that never succeeded, whether the harness flagged it or its output says so", () => {
    const turns = [...bash("a", "deploy.sh", "boom", true), ...bash("b", "other.sh", "Exit code 3\nnope")];
    const found = transcriptCandidates(turns);
    expect(found.candidates).toEqual([]);
    expect(found.dropped.failed).toBe(2);
  });

  it("keeps a command that succeeded and then failed once", () => {
    const turns = [...bash("a", "make"), ...bash("b", "make", "oops", true)];
    const found = transcriptCandidates(turns);
    expect(found.candidates.map((candidate) => candidate.evidence)).toEqual([[{ turn_id: 1, call_id: "a" }]]);
    expect(found.dropped.failed).toBe(1);
  });

  it("pairs a result that arrives after other calls", () => {
    const turns = [call("a", "Bash", { command: "make" }), ...bash("b", "make lint"), result("a", "bad", true)];
    const found = transcriptCandidates(turns);
    expect(found.candidates.map((candidate) => candidate.command)).toEqual(["make lint"]);
    expect(found.dropped.failed).toBe(1);
  });
});

describe("transcriptCandidates range and tools", () => {
  it("reads only the calls between from and to", () => {
    const turns = [...bash("a", "one"), ...bash("b", "two"), ...bash("c", "three")];
    const found = transcriptCandidates(turns, { from: 3, to: 4 });
    expect(found.candidates.map((candidate) => candidate.command)).toEqual(["two"]);
  });

  it("reads a codex shell argv and a Write as an edit of its file", () => {
    const turns = [
      call("a", "shell", { command: ["bash", "-lc", "mise run test"] }),
      call("b", "Write", { file_path: "/x/notes.md" }),
      call("c", "TodoWrite", { todos: [] }),
    ];
    const found = transcriptCandidates(turns);
    expect(found.candidates.map((candidate) => candidate.command ?? candidate.edit)).toEqual([
      "mise run test",
      "/x/notes.md",
    ]);
    expect(found.seen).toBe(2);
  });

  it("gives the model the ask that led to the command", () => {
    const turns: TranscriptTurn[] = [{ role: "user", text: "deploy the shop" }, ...bash("a", "make deploy")];
    expect(transcriptCandidates(turns).candidates[0]!.context).toBe("deploy the shop");
  });
});