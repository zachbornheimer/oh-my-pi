import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CACHE_KEY_PATTERN, type Item, parseRecord, type ResearchRecord } from "./schemas.js";

/**
 * The research store: one JSON record per key, under the run state directory (`RESEARCH_STORE_DIR`, else the directory
 * the Mastra twin used, so records already researched stay cache hits).
 *
 * The key is content-addressed: source identity, the version of the source this run saw, and the version of the
 * question that produced the record. A changed source or a changed question produces a different key and a fresh run;
 * keying on the id alone would serve stale research as current.
 */

/** Bump when the question changes in a way that makes an older answer wrong to reuse. */
export const QUESTION_VERSION = "1";

export function researchRoot(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  return env.RESEARCH_STORE_DIR ?? join(home, ".local", "state", "capability-replicas", "research");
}

/** Whether a source has changed since a record was written: its own timestamp, else its body. */
export const versionOf = (item: Item): string => item.updated_at ?? item.body;

export function cacheKeyOf(item: Item): string {
  const material = [item.kind, item.id, versionOf(item), QUESTION_VERSION].join("\u0000");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function recordPathOf(key: string, root: string = researchRoot()): string {
  if (!CACHE_KEY_PATTERN.test(key)) {
    throw new Error(`cache_key must match ${CACHE_KEY_PATTERN} (letters, digits, "_" and "-"), not "${key}"`);
  }
  return join(root, `${key}.json`);
}

/**
 * The stored record for a key, or undefined when there is none this run may reuse: no file, or a file that is not a
 * valid record (the run then researches again and its atomic write replaces it). Any other read failure throws.
 */
export async function readRecord(key: string, root: string = researchRoot()): Promise<ResearchRecord | undefined> {
  const path = recordPathOf(key, root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parseRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Writes the record through a temp file and a rename, so a reader never sees half a record; answers where it landed. */
export async function writeRecord(record: ResearchRecord, root: string = researchRoot()): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = recordPathOf(record.key, root);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return path;
}
