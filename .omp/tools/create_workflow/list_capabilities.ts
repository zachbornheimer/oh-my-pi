import { confirmLeaves } from "./confirm.js";
import { type AgreedLeaf, partitionByAgreement, requiredAgreement } from "./consensus.js";
import type { StepContext } from "./context.js";
import { type ProposalFrame, proposeSamples } from "./propose_leaves.js";
import { reconcileProposals } from "./reconcile.js";
import type { Merged, Rejected, Source } from "./types.js";

/** What phase 1 works from: the proposal frame and how many samples must agree on a concept. */
export interface ListFrame extends ProposalFrame {
  readonly minAgreement: number;
}

export interface PhaseOneResult {
  readonly kept: AgreedLeaf[];
  readonly merged: Merged[];
  readonly rejected: Rejected[];
  readonly calls: { readonly propose: number; readonly reconcile: number; readonly confirm: number };
}

/**
 * Phase 1 for one source: propose it several times, have one call group the proposals by concept under one name each,
 * keep the concepts enough samples proposed, then have each judged against the criteria. Everything a concept lost on
 * is reported.
 */
export async function listCapabilities(source: Source, frame: ListFrame, ctx: StepContext): Promise<PhaseOneResult> {
  const samples = await proposeSamples(source, frame, ctx);
  const clusters = await reconcileProposals(samples, source, frame, ctx);
  const { kept: agreed, merged, rejected: unagreed } = partitionByAgreement(
    clusters,
    requiredAgreement(frame.minAgreement, frame.samples),
    frame.samples,
  );
  const confirmed = await confirmLeaves(agreed, source, frame, ctx);
  return {
    kept: confirmed.kept,
    merged,
    rejected: [...unagreed, ...confirmed.rejected],
    calls: { propose: frame.samples, reconcile: frame.samples > 1 ? 1 : 0, confirm: confirmed.calls },
  };
}
