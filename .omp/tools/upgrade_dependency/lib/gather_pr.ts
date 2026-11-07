import { gatherFacts } from "./facts.js";
import { GitHub } from "./github.js";
import type { HostMachine } from "./host_machine.js";
import { loadPullSnapshot, ParsePRURL } from "./load.js";
import { gatherPorts } from "./machine.js";
import { osHostMachine } from "./os_host_machine.js";
import type { Facts, Snapshot } from "./schemas.js";

// The input gatherer for upgrade_dependency (Mastra runtime/cli/gather/upgrade_dependency.ts plus depupgrade
// Load): a GitHub pull URL becomes the Snapshot the flow judges. The pull request is read with `gh ... --json`, the
// working copy at the checkout directory is searched with `rg` for how the code uses each bumped package, and the
// first failed check's log is excerpted. Every read goes through one HostMachine rooted at the checkout.

/** How many log lines the failed-check excerpt keeps. */
const LOG_LINES = 40;
const GH_BIN = "gh";

/** The failed-check excerpt. Empty when CI is green or the log cannot be read. Never throws. */
async function redLogOf(machine: HostMachine, snapshot: Snapshot): Promise<string> {
  const failed = (snapshot.ci ?? []).filter((check) => !check.passed);
  if (failed.length === 0 || snapshot.url === undefined) return "";
  let ref;
  try {
    ref = ParsePRURL(snapshot.url);
  } catch {
    return "";
  }
  const repo = `${ref.owner}/${ref.repo}`;
  const view = await machine.run(GH_BIN, [
    "pr",
    "view",
    String(ref.number),
    "--repo",
    repo,
    "--json",
    "statusCheckRollup",
    "--jq",
    "[.statusCheckRollup[]? | select(.conclusion == \"FAILURE\") | .detailsUrl // \"\"]",
  ]);
  if (view.code !== 0) return "";
  const runIds = failedRunIds(view.stdout);
  const excerpts = await Promise.all(runIds.map(async (id) => {
    const log = await machine.run(GH_BIN, ["run", "view", id, "--repo", repo, "--log-failed"]);
    return log.code === 0 ? log.stdout : "";
  }));
  return excerpts.join("\n").split("\n").filter((line) => /error|fail|exception/i.test(line)).slice(0, LOG_LINES).join(
    "\n",
  );
}

/**
 * The distinct Actions run ids in the failed checks' details URLs. `gh ... --jq` prints a JSON array of URLs; the
 * unfiltered `{statusCheckRollup: [...]}` shape is read too, keeping only checks that concluded in FAILURE.
 */
function failedRunIds(raw: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  let urls: unknown[] = [];
  if (Array.isArray(decoded)) urls = decoded;
  else if (typeof decoded === "object" && decoded !== null) {
    const rollup = (decoded as { statusCheckRollup?: unknown }).statusCheckRollup;
    if (Array.isArray(rollup)) {
      urls = (rollup as { conclusion?: unknown; detailsUrl?: unknown }[])
        .filter((check) => String(check?.conclusion ?? "").toUpperCase() === "FAILURE")
        .map((check) => check.detailsUrl ?? "");
    }
  }
  const ids = new Set<string>();
  for (const url of urls) {
    const match = /\/actions\/runs\/(\d+)/.exec(String(url));
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  return [...ids];
}

/** The Facts for a loaded Snapshot: the tree search and the red-log fetch start together. */
async function factsFromMachine(snapshot: Snapshot, machine: HostMachine): Promise<Facts> {
  const [facts, redLog] = await Promise.all([
    gatherFacts(snapshot, gatherPorts(machine, machine.workingDirectory)),
    redLogOf(machine, snapshot),
  ]);
  if (redLog !== "") facts.red_log = redLog;
  return facts;
}

/**
 * Builds the Snapshot of a pull request through `machine`, whose working directory is the checkout of the PR head.
 * Throws when the pull request or its files cannot be read, or the facts cannot be gathered (a failed `rg`).
 */
export async function gatherSnapshotOnMachine(prUrl: string, machine: HostMachine): Promise<Snapshot> {
  const snapshot = await loadPullSnapshot(prUrl, {
    pullRequests: new GitHub(machine),
    gather: (loaded) => factsFromMachine(loaded, machine),
  });
  if (snapshot.facts === undefined) throw new Error(`depupgrade: ${prUrl}: no facts were gathered`);
  return snapshot;
}

/**
 * Expands a GitHub pull URL into the full Snapshot (with facts) the upgrade flow judges. `options.checkout` returns
 * the directory of a clean checkout of the PR head, which is only read. Throws, and never returns a Snapshot without
 * facts, when the URL is not a pull URL or any read fails.
 */
export async function gatherPullRequestSnapshot(
  prUrl: string,
  options: { checkout: (prUrl: string) => Promise<string>; signal?: AbortSignal },
): Promise<Snapshot> {
  const ref = ParsePRURL(prUrl);
  options.signal?.throwIfAborted();
  const directory = await options.checkout(ref.url);
  options.signal?.throwIfAborted();
  return await gatherSnapshotOnMachine(ref.url, osHostMachine(directory, { signal: options.signal }));
}
