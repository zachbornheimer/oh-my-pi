import { contentHash } from "../content_hash.js";
import type { Registry } from "../conventions.js";
import type { HostMachine } from "../machine.js";

/** The text of `path` in the repo, cut at `limit` characters, with the hash of the whole file; undefined when unreadable. */
export async function readExcerpt(
  machine: HostMachine,
  repo: string,
  path: string,
  limit: number,
): Promise<Registry | undefined> {
  const text = await machine.readTextFile(`${repo}/${path}`);
  if (text === undefined) return undefined;
  return { path, text: text.slice(0, limit), truncated: text.length > limit, sha256: contentHash(text) };
}

export const present = <T>(value: T | undefined): value is T => value !== undefined;
