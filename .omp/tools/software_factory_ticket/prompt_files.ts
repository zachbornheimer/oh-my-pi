import { readFileSync } from "node:fs";

const promptCache = new Map<string, string>();

/** The text of a prompt shipped beside this module (`prompts/<name>`), read once. */
export function prompt(name: string): string {
  let text = promptCache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8");
    promptCache.set(name, text);
  }
  return text;
}
