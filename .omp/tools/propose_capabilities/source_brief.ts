import type { Source } from "./types.js";

/** What every model call about a source starts from: where it is from, what the reader cut, what is registered, and its text. */
export function sourceBrief(source: Source, namespace?: string, siblings: readonly string[] = []): string {
  return [
    `Source: ${source.ref} (${source.kind})`,
    ...(namespace === undefined ? [] : [`Namespace: every name starts with "${namespace}."`]),
    ...(siblings.length === 0 ? [] : [registeredText(siblings)]),
    ...(source.truncated ? ["The text below is cut at its size limit: propose only what it shows."] : []),
    source.body,
  ].join("\n");
}

/** The capabilities that already exist, one per line, for a model that must not propose them again. */
export function registeredText(siblings: readonly string[]): string {
  return `Registered capabilities (they exist already):\n${siblings.map((name) => `- ${name}`).join("\n")}`;
}
