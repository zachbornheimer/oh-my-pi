/**
 * The Linear workspaces the software factory works, copied from the Mastra factory's `workspaces.ts`: each names the
 * Linear team key its tickets carry, the MCP server that serves it, its own names for the statuses the factory sets, and
 * the statuses a sweep takes tickets from. Adding a workspace is one entry here.
 */
export interface WorkspaceStatuses {
  readonly notReady: string;
  readonly pullRequest: string;
  readonly done: string;
  readonly canceled: string;
  readonly duplicate: string;
  readonly unreviewed: string;
  readonly ready: string;
  readonly triage?: string;
}

export interface Workspace {
  /** The Linear team key tickets are named by, such as SAH in SAH-123. */
  readonly team: string;
  /** The MCP server that serves the workspace's Linear, such as linear-sah. */
  readonly server: string;
  /** The GitHub organisations the workspace's repositories live in. */
  readonly orgs: readonly string[];
  readonly statuses: WorkspaceStatuses;
  /** The statuses a sweep takes tickets from. */
  readonly inputs: readonly string[];
}

const SAH_STATUSES = {
  triage: "Triage",
  unreviewed: "Unreviewed",
  ready: "Ready for Dev",
  notReady: "Not Ready for Dev",
  pullRequest: "Pull Request",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as const satisfies WorkspaceStatuses;

/** ZYS has no Triage and no Not Ready for Dev: `Initial Ticket Review` is where a ticket the factory cannot work is left. */
const ZYS_STATUSES = {
  unreviewed: "Unreviewed",
  ready: "Ready for Development",
  notReady: "Initial Ticket Review",
  pullRequest: "Pull Request",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as const satisfies WorkspaceStatuses;

export const WORKSPACES: readonly Workspace[] = [
  {
    team: "SAH",
    server: "linear-sah",
    orgs: ["Software-Automation-Holdings-LLC"],
    statuses: SAH_STATUSES,
    inputs: [SAH_STATUSES.triage, SAH_STATUSES.unreviewed, SAH_STATUSES.ready],
  },
  {
    team: "ZYS",
    server: "linear-personal",
    orgs: ["zachbornheimer"],
    statuses: ZYS_STATUSES,
    inputs: [ZYS_STATUSES.unreviewed, ZYS_STATUSES.ready],
  },
];

const TEAM_IN_TICKET = /^([A-Za-z][A-Za-z0-9]*)-/;

/** The team keys the factory knows, as an error names them. */
export function knownTeams(): string {
  return WORKSPACES.map((workspace) => workspace.team).join(", ");
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
