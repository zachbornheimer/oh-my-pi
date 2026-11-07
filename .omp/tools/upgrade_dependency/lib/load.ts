import { NotesFromBody, PackagesFromBody, PackagesFromTitle } from "./body.js";
import { ClassifyPath } from "./files.js";
import type { CICheck, Facts, File, Package, Snapshot } from "./schemas.js";

// Go internal/depupgrade/load.go: a GitHub pull URL becomes one Snapshot. Load never fetches GitHub itself —
// the caller supplies the pull-requests port — and it owns no facts logic: Gather is injected, so the gather
// task lands independently.

/** One GitHub pull request as the host reports it (load.go PullRequest). */
export interface PullRequest {
  url: string;
  title: string;
  body: string;
  checks: CICheck[];
}

/** One file a pull request changes, with the diff GitHub reports for it (load.go ChangedFile). */
export interface ChangedFile {
  path: string;
  patch: string;
}

/** owner/repo#n parsed from a GitHub pull URL (load.go Ref). */
export interface Ref {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/** Reads a GitHub pull request (load.go PullRequests). */
export interface PullRequests {
  view(ref: Ref): Promise<PullRequest>;
  files(ref: Ref): Promise<ChangedFile[]>;
}

/** Wall time, so the stages of a load can be timed without reading the clock directly. */
export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

/** What Load reads: the pull request, and the Facts gather the caller composes. */
export interface LoadDependencies {
  pullRequests: PullRequests;
  /** Facts for the loaded Snapshot; the gather task's Gather in production, a stub in a test. */
  gather: (snapshot: Snapshot) => Promise<Facts> | Facts;
  /** Times the load_pull_request and gather_facts stages. Defaults to the system clock. */
  clock?: Clock;
}

/** The stages Load times, by the names agentmux reports. */
const STAGE_PULL_REQUEST = "load_pull_request";
const STAGE_FACTS = "gather_facts";

const GITHUB_HOST = "github.com";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value !== "") ?? "";
}

/** Reads owner, repo, and number from a GitHub pull URL, with or without a scheme. */
export function ParsePRURL(raw: string): Ref {
  const text = raw.trim();
  if (!text) throw new Error("depupgrade: empty pull request URL");

  const shorthand = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(text);
  let match = shorthand;

  if (!match) {
    const input = text.includes("://")
      ? text
      : `https://${text.replace(/^\/\//, "")}`;

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`depupgrade: invalid pull URL: ${text}`);
    }

    if (
      !["http:", "https:"].includes(url.protocol)
      || url.hostname !== GITHUB_HOST
      || url.username
      || url.password
      || url.port
    ) {
      throw new Error(`depupgrade: invalid GitHub pull URL: ${text}`);
    }

    match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url.pathname);
  }

  if (!match) {
    throw new Error(`depupgrade: invalid GitHub pull request: ${text}`);
  }

  const [, owner, repo, pullNumber] = match;
  const number = Number(pullNumber);

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`depupgrade: invalid pull number: ${pullNumber}`);
  }

  return {
    owner,
    repo,
    number,
    url: `https://${GITHUB_HOST}/${owner}/${repo}/pull/${number}`,
  };
}

/** Reports whether a string is a GitHub pull URL the CLI should expand. */
export function IsPRURL(value: string): boolean {
  try {
    ParsePRURL(value);
    return true;
  } catch {
    return false;
  }
}

/** One changed file as Go writes it: the path, then the patch, then the flags Go would set. */
function fileOf(changed: ChangedFile): File {
  const classified = ClassifyPath(changed.path);
  return {
    path: classified.path,
    ...(changed.patch === "" ? {} : { patch: changed.patch }),
    ...(classified.lockfile === true ? { lockfile: true } : {}),
    ...(classified.manifest === true ? { manifest: true } : {}),
    ...(classified.test === true ? { test: true } : {}),
  };
}

/** Builds a Snapshot, with its Facts, from a GitHub pull URL. */
export async function loadPullSnapshot(rawUrl: string, deps: LoadDependencies): Promise<Snapshot> {
  const ref = ParsePRURL(rawUrl);
  const clock = deps.clock ?? systemClock;
  const started = clock.now();
  const [viewed, listed] = await Promise.all([
    deps.pullRequests.view(ref).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    deps.pullRequests.files(ref).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (!viewed.ok) throw new Error(`depupgrade: load ${ref.url}: ${messageOf(viewed.error)}`);
  if (!listed.ok) throw new Error(`depupgrade: load ${ref.url} files: ${messageOf(listed.error)}`);
  const request = viewed.value;
  const changed = listed.value;
  const fromBody = PackagesFromBody(request.body);
  const packages: Package[] = fromBody.length > 0 ? fromBody : PackagesFromTitle(request.title);
  const notes = NotesFromBody(request.body);
  const url = firstNonEmpty(request.url, ref.url);
  const snapshot: Snapshot = {
    ...(url === "" ? {} : { url }),
    ...(request.title === "" ? {} : { title: request.title }),
    body: request.body,
    files: changed.map(fileOf),
    packages,
    ...(request.checks.length === 0 ? {} : { ci: request.checks }),
    ...(notes.length === 0 ? {} : { notes }),
  };
  const gathering = clock.now();
  snapshot.timings = [{ name: STAGE_PULL_REQUEST, wall_ms: Math.trunc(gathering - started) }];
  let facts: Facts;
  try {
    facts = await deps.gather(snapshot);
  } catch (error) {
    throw new Error(`depupgrade: load ${ref.url} facts: ${messageOf(error)}`, { cause: error });
  }
  snapshot.facts = facts;
  snapshot.timings.push({ name: STAGE_FACTS, wall_ms: Math.trunc(clock.now() - gathering) });
  return snapshot;
}
