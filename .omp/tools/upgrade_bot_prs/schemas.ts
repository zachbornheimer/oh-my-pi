/** Shapes the tick reads and writes, with hand-written validators (no schema library). */

export type Pull = { pr: string; repo: string; number: number; url: string; createdAt: string };
export type Skip = { pr: string; reason: string };
export type Listed = { dryRun?: boolean; pulls: Pull[]; skipped: Skip[] };
export type Launch = { pr: string; url: string; pid: number };
export type TickResult = {
  dryRun: boolean;
  repos: number;
  launched: Launch[];
  wouldLaunch: { pr: string; url: string }[];
  skipped: Skip[];
};
export type SearchRow = {
  repository: { nameWithOwner: string };
  number: number;
  url: string;
  author: { login: string; type?: string } | null;
  isDraft: boolean;
  labels: { name: string }[];
  createdAt: string;
};
export type LastTry = { at: string; pid: number; startedAt: string; head: string };
export type Hold = { until: string; reason: string; head?: string };
export type Registry = { lastTrys: Record<string, LastTry>; holds: Record<string, Hold> };
export type Owner = { pid: number; startedAt: string; token: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isString = (value: unknown): value is string => typeof value === "string";

/** Parses `gh search prs --json` output; throws with the offending row when a field is missing or mistyped. */
export function parseSearchRows(value: unknown): SearchRow[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value.map((row, index) => {
    const where = `row ${index}`;
    if (!isObject(row)) throw new Error(`${where} is not an object`);
    const repository = row.repository;
    if (!isObject(repository) || !isString(repository.nameWithOwner)) throw new Error(`${where}: repository.nameWithOwner`);
    if (!isInt(row.number)) throw new Error(`${where}: number`);
    if (!isString(row.url)) throw new Error(`${where}: url`);
    if (typeof row.isDraft !== "boolean") throw new Error(`${where}: isDraft`);
    if (!isString(row.createdAt)) throw new Error(`${where}: createdAt`);
    if (!Array.isArray(row.labels) || !row.labels.every((label) => isObject(label) && isString(label.name))) {
      throw new Error(`${where}: labels`);
    }
    let author: SearchRow["author"] = null;
    if (row.author !== null && row.author !== undefined) {
      if (!isObject(row.author) || !isString(row.author.login)) throw new Error(`${where}: author.login`);
      author = { login: row.author.login, type: isString(row.author.type) ? row.author.type : undefined };
    }
    return {
      repository: { nameWithOwner: repository.nameWithOwner },
      number: row.number,
      url: row.url,
      author,
      isDraft: row.isDraft,
      labels: (row.labels as { name: string }[]).map((label) => ({ name: label.name })),
      createdAt: row.createdAt,
    };
  });
}

/** Parses the registry file's JSON, or throws naming the first bad field. */
export function parseRegistry(value: unknown): Registry {
  if (!isObject(value) || !isObject(value.lastTrys) || !isObject(value.holds)) {
    throw new Error("expected { lastTrys, holds } objects");
  }
  const lastTrys: Registry["lastTrys"] = {};
  for (const [pr, run] of Object.entries(value.lastTrys)) {
    if (!isObject(run) || !isString(run.at) || !isInt(run.pid) || !isString(run.startedAt) || !isString(run.head)) {
      throw new Error(`lastTrys.${pr} needs at, pid, startedAt and head`);
    }
    lastTrys[pr] = { at: run.at, pid: run.pid, startedAt: run.startedAt, head: run.head };
  }
  const holds: Registry["holds"] = {};
  for (const [pr, hold] of Object.entries(value.holds)) {
    if (!isObject(hold) || !isString(hold.until) || !isString(hold.reason) || (hold.head !== undefined && !isString(hold.head))) {
      throw new Error(`holds.${pr} needs until and reason`);
    }
    holds[pr] = { until: hold.until, reason: hold.reason, ...(hold.head === undefined ? {} : { head: hold.head }) };
  }
  return { lastTrys, holds };
}

/** Parses a lock or guard file's owner, or returns undefined when it is malformed. */
export function parseOwner(value: unknown): Owner | undefined {
  if (!isObject(value) || !isInt(value.pid) || !isString(value.startedAt) || !isString(value.token)) return undefined;
  return { pid: value.pid, startedAt: value.startedAt, token: value.token };
}
