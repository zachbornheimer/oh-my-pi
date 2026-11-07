import { DEFAULT_MIN_SEVERITY, type Severity } from "./constants.js";
import type { SecurityPorts } from "./ports.js";
import type { Result, State } from "./schemas.js";
import {
  createMissingGhsecTickets,
  indexExistingGhsecTickets,
  listGhSecurityItems,
  reconcileGhsecTickets,
  resolveSecurityScope,
  settleResolvedGhsecTickets,
  summarizeSecurityTicketRun,
} from "./steps.js";
import type { Workspace } from "./workspaces.js";

export type RunInput = { target: string; dryRun?: boolean; minSeverity?: Severity };

/**
 * The seven steps in order, each stopping where a dry run must: scope, list GitHub alerts, index existing tickets,
 * reconcile (pure), create, settle, summarize. A dry run reads GitHub and Linear and writes nothing.
 */
export async function fileGhSecurityTickets(
  ports: SecurityPorts,
  input: RunInput,
  table?: readonly Workspace[],
): Promise<Result> {
  ports.progress("resolving scope");
  const scope = await resolveSecurityScope(ports, { target: input.target }, table);
  const state: State = {
    target: input.target,
    dryRun: input.dryRun ?? false,
    minSeverity: input.minSeverity ?? DEFAULT_MIN_SEVERITY,
    owner: scope.owner,
    workspace: scope.workspace,
    visitedRepos: scope.visitedRepos,
    skippedRepos: scope.skippedRepos,
    unlisted: [],
    listed: [],
    items: [],
    index: {},
    toCreate: [],
    toSettle: [],
    existing: 0,
    created: [],
    settled: [],
    failed: [],
  };

  const listing = await listGhSecurityItems(ports, { visitedRepos: state.visitedRepos });
  state.items = listing.items;
  state.skippedRepos = [...state.skippedRepos, ...listing.skipped];
  state.listed = listing.listed;
  state.unlisted = listing.unlisted;

  ports.progress("reading existing Linear tickets");
  state.index = await indexExistingGhsecTickets(ports, { workspace: state.workspace });

  const diff = reconcileGhsecTickets({
    items: state.items,
    index: state.index,
    visitedRepos: state.visitedRepos,
    minSeverity: state.minSeverity,
    unlisted: state.unlisted,
  });
  state.toCreate = diff.toCreate;
  state.toSettle = diff.toSettle;
  state.existing = diff.existing;

  if (!state.dryRun) {
    const creation = await createMissingGhsecTickets(ports, { workspace: state.workspace, toCreate: state.toCreate });
    state.created = creation.created;
    state.failed.push(...creation.failed);
    const settlement = await settleResolvedGhsecTickets(ports, {
      workspace: state.workspace,
      toSettle: state.toSettle,
      listed: state.listed,
    });
    state.settled = settlement.settled;
    state.failed.push(...settlement.failed);
  }
  return summarizeSecurityTicketRun(state);
}
