import { DEPENDENCIES_CHECKED, SEARCH_FIELDS, SEARCH_LIMIT } from "./constants.js";
import type { UpgradeBotHost } from "./host.js";
import { toPull } from "./policy.js";
import { type Listed, type Pull, parseSearchRows, type Skip } from "./schemas.js";

/**
 * The open pull requests of every bot across the account's owners (the `gh` user and each of its orgs), one
 * search per owner. An owner whose search comes back at the limit is refused whole: a partial list would hide
 * the pull requests past it. A failed owner or listing is a skip, never a throw (except cancellation).
 */
export async function listOpenBotPrs(host: UpgradeBotHost, input: { dryRun?: boolean }): Promise<Listed> {
  const skipped: Skip[] = [];
  const pulls: Pull[] = [];
  let owners: string[];
  try {
    owners = await ownersOf(host);
  } catch (error) {
    host.signal?.throwIfAborted();
    return { dryRun: input.dryRun, pulls, skipped: [{ pr: "owners", reason: (error as Error).message }] };
  }
  for (const owner of owners) {
    try {
      pulls.push(...(await searchOpenBotPulls(host, { owner })));
    } catch (error) {
      host.signal?.throwIfAborted();
      skipped.push({ pr: owner, reason: (error as Error).message });
    }
  }
  return { dryRun: input.dryRun, pulls, skipped };
}

async function ownersOf(host: UpgradeBotHost): Promise<string[]> {
  const user = (await gh(host, ["api", "user", "--jq", ".login"])).trim();
  if (user === "") throw new Error("gh api user returned no login");
  const orgs = await gh(host, ["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
  const logins = [user, ...orgs.split("\n")].map((login) => login.trim()).filter((login) => login !== "");
  return [...new Set(logins)];
}

/**
 * Draft and already-checked pull requests are left out by the search itself so the 1000-result ceiling is reached by
 * far fewer scopes; the rows are filtered again here, because the filter is the contract and the query is a saving.
 * A scope is every repository of an owner, or one repository (what a lane lists again after each run).
 */
export async function searchOpenBotPulls(
  host: UpgradeBotHost,
  scope: { owner: string } | { repo: string },
): Promise<Pull[]> {
  const { flag, name } = "owner" in scope
    ? { flag: "--owner", name: scope.owner }
    : { flag: "--repo", name: scope.repo };
  const stdout = await gh(host, [
    "search",
    "prs",
    flag,
    name,
    "--state",
    "open",
    "--archived=false",
    "--draft=false",
    "--limit",
    String(SEARCH_LIMIT),
    "--json",
    SEARCH_FIELDS,
    "--",
    `-label:${DEPENDENCIES_CHECKED}`,
  ]);
  let rows;
  try {
    rows = parseSearchRows(JSON.parse(stdout));
  } catch (error) {
    throw new Error(`gh search prs for ${name} returned an unexpected shape: ${(error as Error).message}`);
  }
  if (rows.length >= SEARCH_LIMIT) {
    throw new Error(
      `gh search prs for ${name} returned ${rows.length} results, the limit of ${SEARCH_LIMIT}: refusing it instead of working from a partial list`,
    );
  }
  return rows.flatMap((row) => toPull(row) ?? []);
}

async function gh(host: UpgradeBotHost, args: string[]): Promise<string> {
  const ran = await host.exec("gh", args);
  if (ran.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} exited ${ran.status}: ${ran.stderr.trim()}`);
  return ran.stdout;
}
