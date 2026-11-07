import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeRecordTurns, jsonlTurns } from "./transcripts.ts";
import type { TranscriptTurn } from "./schemas.ts";
import type { ModelStep } from "./omp_model.ts";

/** Fixtures and a fake model step shared by the tests. Not a test file; nothing here calls a real model. */

export const FIXTURES = join(import.meta.dir, "fixtures");
export const TOOL_FIXTURE = join(FIXTURES, "claude-tool-calls.jsonl");
export const WEBMASTER_FIXTURE = join(FIXTURES, "webmaster-operate.md");

/** The scrubbed Claude session of the fixtures, parsed with its tool calls. */
export function fixtureTurns(): TranscriptTurn[] {
  return jsonlTurns(readFileSync(TOOL_FIXTURE, "utf8"), claudeRecordTurns).turns;
}

export const webmasterText = (): string => readFileSync(WEBMASTER_FIXTURE, "utf8");

export interface DecisionAnswer {
  Kind: string;
  Keep: boolean;
  Approval: boolean;
}

/** What the fake decision model says about a candidate, judged from the words the model is shown. */
export function decisionFor(focus: string): DecisionAnswer {
  const keep = !focus.includes("Site content is data") && !focus.includes("curl ");
  const kind = focus.includes("Group findings")
    ? "judgment"
    : focus.includes("High-risk changes")
    ? "approval"
    : "command";
  const approval = focus.includes("deploy.sh") || focus.includes("--confirm-prod");
  return { Kind: kind, Keep: keep, Approval: approval };
}

export const CHECK_FOR_DEPLOY = "http_ok: https://{host}/health";

/** The answer to a check or summary prompt. */
export function languageFor(prompt: string): string {
  if (prompt.startsWith("## Check")) {
    const command = prompt.slice(prompt.lastIndexOf("Command: ")).split("\n")[0]!;
    return JSON.stringify({ Check: command.includes("deploy.sh") ? CHECK_FOR_DEPLOY : "" });
  }
  return JSON.stringify({
    Workflow: {
      name: "ship-shop",
      description: "Builds the shop and deploys it to a host, then smokes it.",
      usage: "/ship-shop <host>",
      argument_hint: "<host>",
      rules: ["Build before deploying."],
      outputs: [{ name: "deployed site", where: "https://{host}/" }],
      inputs: [{ name: "host", description: "The hostname the shop is deployed to." }],
    },
  });
}

export type Purpose = "candidate" | "check" | "summary" | "outline";

/** Which model step a prompt is for. */
export function purposeOf(prompt: string): Purpose {
  if (prompt.startsWith("You read one thing found")) return "candidate";
  if (prompt.startsWith("## Check")) return "check";
  if (prompt.startsWith("## Workflow")) return "summary";
  if (prompt.startsWith("## Steps")) return "outline";
  throw new Error(`unknown prompt: ${prompt.slice(0, 40)}`);
}

/** The segment a candidate prompt asks about. */
export function focusOf(prompt: string): string {
  const start = prompt.indexOf("Answer about this segment only:\n") + "Answer about this segment only:\n".length;
  const end = prompt.indexOf("\n\nReply with only this JSON object", start);
  const whole = prompt.indexOf("\nThe whole input, for context only", start);
  return prompt.slice(start, whole >= 0 && whole < end ? whole : end).trim();
}

/** A fake model step that answers by what it is shown and records every prompt with its purpose. */
export function fakeModel(override?: (prompt: string, purpose: Purpose) => string | undefined) {
  const calls: { purpose: Purpose; prompt: string }[] = [];
  const step: ModelStep = async (prompt) => {
    const purpose = purposeOf(prompt);
    calls.push({ purpose, prompt });
    const overridden = override?.(prompt, purpose);
    if (overridden !== undefined) return overridden;
    return purpose === "candidate" ? JSON.stringify(decisionFor(focusOf(prompt))) : languageFor(prompt);
  };
  return { step, calls };
}
