import type { Workspace } from "./types.js";

/** A Linear ticket identifier: a team key, a dash, a number. */
export const TICKET_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

const SAH_STATUSES = {
  triage: "Triage",
  unreviewed: "Unreviewed",
  ready: "Ready for Dev",
  notReady: "Not Ready for Dev",
  inProgress: "In Progress",
  pullRequest: "Pull Request",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as const;

/** ZYS has no Triage and no Not Ready for Dev: `Initial Ticket Review` is where a ticket the relay cannot finish is left. */
const ZYS_STATUSES = {
  unreviewed: "Unreviewed",
  ready: "Ready for Development",
  notReady: "Initial Ticket Review",
  inProgress: "In Progress",
  pullRequest: "Pull Request",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as const;

/** Every Linear workspace the relay works, by team key. Adding one is one entry here. */
export const WORKSPACES: readonly Workspace[] = [
  { team: "SAH", orgs: ["Software-Automation-Holdings-LLC"], statuses: SAH_STATUSES },
  { team: "ZYS", orgs: ["zachbornheimer"], statuses: ZYS_STATUSES },
];

const TEAM_IN_TICKET = /^([A-Za-z][A-Za-z0-9]*)-/;

/** The team keys the relay knows, as an error names them. */
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

/** The workspace a ticket identifier names, by its prefix: `ZYS-45` is ZYS. */
export function workspaceFor(identifier: string): Workspace {
  const team = TEAM_IN_TICKET.exec(identifier)?.[1] ?? identifier;
  const found = WORKSPACES.find((workspace) => workspace.team.toLowerCase() === team.toLowerCase());
  if (found === undefined) throw new Error(`"${team}" is no Linear workspace the relay works; it works ${knownTeams()}`);
  return found;
}
