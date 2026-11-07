import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The statuses the factory writes, by the role it needs rather than by name: a workspace names its own. `triage` and
 * `unreviewed` are optional because a workspace need not have them (ZYS has no Triage).
 */
export interface WorkspaceStatuses {
  /** Where the ticket is ready to be worked. */
  ready: string;
  /** Where an undecipherable ticket or a remand is left. */
  notReady: string;
  /** Set while the factory implements the ticket. */
  inProgress: string;
  /** Set when a ready pull request is published. */
  pullRequest: string;
  /** Already complete, or finished with no pull request needed. */
  done: string;
  /** Not a real issue, obsolete, or superseded with no superseding ticket. */
  canceled: string;
  /** Superseded by a named ticket. */
  duplicate: string;
  triage?: string;
  unreviewed?: string;
}

/** One Linear workspace the factory works, and everything about it that is not the ticket. */
export interface Workspace {
  /** The Linear team key tickets are named by, such as SAH in SAH-123. */
  team: string;
  /** The environment variable that holds this workspace's Linear API key (`LINEAR_API_KEY` is the shared fallback). */
  apiKeyEnv: string;
  /** The local checkout roots, one directory per repository. */
  roots: string[];
  /** The GitHub organisations the workspace's repositories live in. */
  orgs: string[];
  statuses: WorkspaceStatuses;
  /** The statuses a sweep takes tickets from. */
  inputs: string[];
}

const SAH_STATUSES: WorkspaceStatuses = {
  triage: "Triage",
  unreviewed: "Unreviewed",
  ready: "Ready for Dev",
  notReady: "Not Ready for Dev",
  inProgress: "In Progress",
  pullRequest: "Pull Request",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

/** ZYS has no Triage and no Not Ready for Dev: `Initial Ticket Review` is where a ticket the factory cannot work is left. */
const ZYS_STATUSES: WorkspaceStatuses = {
  unreviewed: "Unreviewed",
  ready: "Ready for Development",
  notReady: "Initial Ticket Review",
  inProgress: "In Progress",
  pullRequest: "Pull Request",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

/** Every Linear workspace the factory works, by team key. Adding one is one entry here, and nothing else. */
export const WORKSPACES: readonly Workspace[] = [
  {
    team: "SAH",
    apiKeyEnv: "LINEAR_API_KEY_SAH",
    roots: [join(homedir(), "Developer", "Software-Automation-Holdings")],
    orgs: ["Software-Automation-Holdings-LLC"],
    statuses: SAH_STATUSES,
    inputs: [SAH_STATUSES.triage!, SAH_STATUSES.unreviewed!, SAH_STATUSES.ready],
  },
  {
    team: "ZYS",
    apiKeyEnv: "LINEAR_API_KEY_ZYS",
    roots: [
      join(homedir(), "Developer", "Personal"),
      join(homedir(), "Developer", "Zysys"),
      join(homedir(), "Developer", "Software-Automation-Holdings"),
    ],
    orgs: ["zachbornheimer"],
    statuses: ZYS_STATUSES,
    inputs: [ZYS_STATUSES.unreviewed!, ZYS_STATUSES.ready],
  },
];

const TEAM_IN_TICKET = /^([A-Za-z][A-Za-z0-9]*)-/;

/** The team keys the factory knows, as an error or a prompt names them. */
export function knownTeams(): string {
  return WORKSPACES.map((workspace) => workspace.team).join(", ");
}

/** Every GitHub organisation configured across the workspaces. A third-party repository is never in this set. */
export function isKnownOrg(org: string): boolean {
  return WORKSPACES.some((workspace) => workspace.orgs.includes(org));
}

/** Refuses a GitHub write against an organisation no workspace owns. */
export function assertKnownOrg(org: string): void {
  if (!isKnownOrg(org)) {
    const known = WORKSPACES.flatMap((workspace) => workspace.orgs).join(", ");
    throw new Error(`refusing to write to third-party GitHub organisation "${org}"; allowed: ${known}`);
  }
}

/** The workspace a team key names. */
export function workspaceOfTeam(team: string): Workspace {
  const found = WORKSPACES.find((workspace) => workspace.team.toLowerCase() === team.toLowerCase());
  if (found === undefined) {
    throw new Error(`"${team}" is no Linear workspace the software factory works; it works ${knownTeams()}`);
  }
  return found;
}

/** The workspace a ticket identifier names, by its prefix: `ZYS-45` is ZYS. */
export function workspaceFor(identifier: string): Workspace {
  return workspaceOfTeam(TEAM_IN_TICKET.exec(identifier)?.[1] ?? identifier);
}

/**
 * The workspace's primary checkout root: where its own organisations' repositories live when no other organisation says
 * otherwise. A workspace may hold further roots — the directories its tickets' work also lives under (ZYS also works
 * Zysys and SAH repositories) — and `checkoutRootFor` routes by organisation.
 */
export function primaryRoot(workspace: Workspace): string {
  const [root] = workspace.roots;
  if (root === undefined) throw new Error(`the ${workspace.team} workspace names no checkout root`);
  return root;
}

/** The one organisation a repository named without one belongs to. */
export function soleOrg(workspace: Workspace): string {
  const [org] = workspace.orgs;
  if (org === undefined || workspace.orgs.length > 1) {
    throw new Error(
      `the ${workspace.team} workspace holds ${workspace.orgs.length} organisations, so a repository it names must say which`,
    );
  }
  return org;
}

/**
 * The checkout root a repository of `org` belongs under: the ticket's own root when its workspace holds that organisation,
 * else the root of the workspace that does, so a clone lands beside the checkouts of its own organisation. A repository
 * whose organisation no workspace holds lands under the ticket's root.
 */
export function checkoutRootFor(workspace: Workspace, org: string | undefined): string {
  if (org === undefined || workspace.orgs.includes(org)) return primaryRoot(workspace);
  const holder = WORKSPACES.find((candidate) => candidate.orgs.includes(org));
  return primaryRoot(holder ?? workspace);
}
