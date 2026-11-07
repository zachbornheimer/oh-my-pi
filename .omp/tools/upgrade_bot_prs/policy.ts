import { DEFAULT_LANES, DEPENDENCIES_CHECKED, LANES_ENV, RETRY_AFTER_MS } from "./constants.js";
import type { Hold, Pull, Registry, SearchRow } from "./schemas.js";

/** Pure rules: no clock, no file, no process. The tool hands in what it read. */

export const prKey = (repo: string, number: number): string => `${repo}#${number}`;

/** A bot by GitHub's own type, by the `[bot]` login suffix, or by the `app/` prefix `gh` gives an app. */
export function isBotAuthor(author: NonNullable<SearchRow["author"]>): boolean {
  return author.type === "Bot" || author.login.endsWith("[bot]") || author.login.startsWith("app/");
}

/** Open pull requests of a bot, not drafts, not yet carrying the label. Which bots is `upgrade_dependency`'s call. */
export function toPull(row: SearchRow): Pull | undefined {
  if (row.isDraft || row.author === null || !isBotAuthor(row.author)) return undefined;
  if (row.labels.some((label) => label.name === DEPENDENCIES_CHECKED)) return undefined;
  const repo = row.repository.nameWithOwner;
  return { pr: prKey(repo, row.number), repo, number: row.number, url: row.url, createdAt: row.createdAt };
}

/**
 * A hold is in force until `until` passes. Before that, a hold that names a head also lifts when the pull request's
 * head is not the one the hold was set on.
 * `head` is the pull request's current head, undefined when it was not read.
 */
export function holdInForce(hold: Hold, head: string | undefined, now: Date): boolean {
  if (Date.parse(hold.until) <= now.getTime()) return false;
  return hold.head === undefined || head === undefined || head === hold.head;
}

/** Whether `holdInForce` needs the live head to answer. */
export function holdNeedsHead(hold: Hold, now: Date): boolean {
  return hold.head !== undefined && Date.parse(hold.until) > now.getTime();
}

/** Never tried, or last tried at least RETRY_AFTER_MS before the tick started. */
export function triedLongEnoughAgo(registry: Registry, pr: string, tickStart: Date): boolean {
  const last = registry.lastTrys[pr];
  return last === undefined || Date.parse(last.at) <= tickStart.getTime() - RETRY_AFTER_MS;
}

/** The oldest pull request first, ties by number. */
export function oldestFirst(pulls: readonly Pull[]): Pull[] {
  return [...pulls].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
}

/**
 * The lanes a tick works with: LANES_ENV's value when it is a positive integer, DEFAULT_LANES when it is unset or
 * blank, and DEFAULT_LANES with `problem` saying why when it is anything else.
 */
export function lanesFrom(raw: string | undefined): { lanes: number; problem?: string } {
  const value = raw?.trim() ?? "";
  if (value === "") return { lanes: DEFAULT_LANES };
  if (/^[1-9][0-9]*$/.test(value)) return { lanes: Number(value) };
  return {
    lanes: DEFAULT_LANES,
    problem: `${LANES_ENV}=${JSON.stringify(raw)} is not a positive integer; using ${DEFAULT_LANES} lanes`,
  };
}
