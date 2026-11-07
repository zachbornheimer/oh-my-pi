import { describe, expect, it } from "bun:test";
import {
  parseSkillSteps,
  renderSkill,
  type WorkflowRecord,
} from "./render_skill.ts";

const record: WorkflowRecord = {
  name: "ship-shop",
  description: "Builds the shop: then deploys it.",
  trigger: { usage: "/ship-shop <host>", argument_hint: "<host>" },
  inputs: [{ name: "host", description: "Where the shop goes.", example: "shop.example.com" }],
  steps: [
    {
      key: "build",
      title: "Build the app",
      kind: "command",
      run: "mise run build",
      requires: [],
      check: "run: test -f dist/index.html",
      on_failure: "retry_once",
      evidence: [{ turn_id: 12, call_id: "toolu_06" }],
    },
    {
      key: "approve_deploy",
      title: "Approve the deploy",
      kind: "approval",
      requires: ["build"],
      on_failure: "ask",
      evidence: [{ line: 7 }],
    },
    {
      key: "deploy",
      title: "Deploy",
      kind: "command",
      run: "scripts/deploy.sh {host}\n  --prod",
      needs: ["host"],
      requires: ["approve_deploy"],
      on_failure: "stop",
      evidence: [{ line: 7 }],
    },
    {
      key: "fix_types",
      title: "Fix types",
      kind: "edit",
      requires: ["deploy"],
      on_failure: "ask",
      evidence: [{ line: 9 }],
    },
    {
      key: "triage",
      title: "Triage",
      kind: "judgment",
      requires: ["fix_types"],
      on_failure: "ask",
      evidence: [{ line: 10 }],
    },
  ],
  rules: ["Build before deploying."],
  outputs: [{ name: "site", where: "https://{host}/" }],
  literals: { host: "shop.example.com" },
  source: {
    path: "/x/SKILL.md",
    candidates_seen: 9,
    candidates_kept: 5,
    dropped: { reads: 1, retries: 2, failed: 0, incidental: 1 },
  },
};

describe("renderSkill", () => {
  const markdown = renderSkill(record);

  it("opens with the frontmatter a skill needs", () => {
    expect(markdown.split("\n").slice(0, 7)).toEqual([
      "---",
      "name: ship-shop",
      "description: \"Builds the shop: then deploys it.\"",
      "user-invokable: true",
      "argument-hint: \"<host>\"",
      "---",
      "",
    ]);
  });

  it("writes the sections in order", () => {
    const headings = markdown.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual([
      "# ship-shop",
      "## Usage",
      "## Rules",
      "## Steps",
      "## Checks",
      "## Outputs",
      "## Provenance",
    ]);
  });

  it("numbers the steps, fences each command and marks the rest", () => {
    expect(markdown).toContain(
      "1. **Build the app** `build`\n   ```sh\n   mise run build\n   ```\n   On failure: retry once.",
    );
    expect(markdown).toContain("2. **Approve the deploy** `approve_deploy` (approval)\n   Requires: `build`.");
    expect(markdown).toContain("4. **Fix types** `fix_types` (edit)");
    expect(markdown).toContain("5. **Triage** `triage` (judgment)");
  });

  it("lists checks, outputs and where each step came from", () => {
    expect(markdown).toContain("- `build`: `run: test -f dist/index.html`");
    expect(markdown).toContain("- **site**: https://{host}/");
    expect(markdown).toContain("- `build`: turn 12 (call toolu_06)");
    expect(markdown).toContain("- `deploy`: line 7");
    expect(markdown).toContain(
      "Steps kept 5 of 9 candidates; dropped 1 reads, 2 retries, 0 failed attempts, 1 incidental.",
    );
  });

  it("is a pure function of the record", () => {
    expect(renderSkill(record)).toBe(markdown);
  });

  it("round-trips: parsing the steps back gives the same keys, kinds and runs", () => {
    expect(parseSkillSteps(markdown)).toEqual([
      { key: "build", kind: "command", run: "mise run build" },
      { key: "approve_deploy", kind: "approval" },
      { key: "deploy", kind: "command", run: "scripts/deploy.sh {host}\n  --prod" },
      { key: "fix_types", kind: "edit" },
      { key: "triage", kind: "judgment" },
    ]);
  });
});
