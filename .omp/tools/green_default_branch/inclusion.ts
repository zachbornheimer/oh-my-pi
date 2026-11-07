import { BILLING_HOLD_ENV, DEFAULT_BILLING_HOLD_OWNERS, PUSHABLE_PERMISSIONS, REPO_GREEN_CANARY } from "./constants.js";

export type ViewerPermission = "ADMIN" | "MAINTAIN" | "WRITE" | "READ" | "TRIAGE" | "NONE";

export type Listing = {
  nameWithOwner: string;
  archived: boolean;
  fork: boolean;
  viewerPermission: ViewerPermission;
  defaultBranch: string;
};

export type Exclusion = { nameWithOwner: string; reason: string };

export type Universe = { included: Listing[]; exclusions: Exclusion[] };

/**
 * The owners whose Actions billing is on hold; their repositories are left out of an account-wide run until the hold
 * lifts. `$REPO_GREEN_BILLING_HOLD_OWNERS` (comma-separated, empty for none) overrides the default.
 */
export function billingHoldOwners(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env[BILLING_HOLD_ENV];
  const owners = configured === undefined ? [...DEFAULT_BILLING_HOLD_OWNERS] : configured.split(",");
  return owners.map((owner) => owner.trim().toLowerCase()).filter((owner) => owner !== "");
}

/**
 * Pushable, not archived, outside the billing hold, and not the canary. A repository named on its own never comes
 * through here, so the canary and a held repository run when named.
 */
export function decideInclusion(listings: Listing[], holdOwners: readonly string[] = billingHoldOwners()): Universe {
  const included: Listing[] = [];
  const exclusions: Exclusion[] = [];
  const seen = new Set<string>();
  for (const repo of listings) {
    if (repo.nameWithOwner === "" || seen.has(repo.nameWithOwner)) continue;
    seen.add(repo.nameWithOwner);
    const exclusion = exclusionOf(repo, holdOwners);
    if (exclusion) exclusions.push(exclusion);
    else included.push(repo);
  }
  return { included, exclusions };
}

function exclusionOf(repo: Listing, holdOwners: readonly string[]): Exclusion | undefined {
  if (repo.nameWithOwner === REPO_GREEN_CANARY) {
    return { nameWithOwner: repo.nameWithOwner, reason: "canary excluded from an account-wide run" };
  }
  const owner = repo.nameWithOwner.split("/")[0]?.toLowerCase() ?? "";
  if (holdOwners.includes(owner)) {
    return { nameWithOwner: repo.nameWithOwner, reason: "billing hold until reset" };
  }
  if (repo.archived) return { nameWithOwner: repo.nameWithOwner, reason: "archived" };
  if (!(PUSHABLE_PERMISSIONS as readonly string[]).includes(repo.viewerPermission)) {
    return { nameWithOwner: repo.nameWithOwner, reason: `not pushable (${repo.viewerPermission})` };
  }
  return undefined;
}
