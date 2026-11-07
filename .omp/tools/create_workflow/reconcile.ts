import { type AgreedLeaf, agreementOf } from "./consensus.js";
import type { StepContext } from "./context.js";
import { askJson } from "./omp_model.js";
import { modelPrompt, RECONCILE } from "./prompts.js";
import { MAX_LEAVES, proposalProblem } from "./proposal_checks.js";
import type { ProposalFrame } from "./propose_leaves.js";
import { arrayAt, kindAt, memberAt, namesAt, recordAt, replyField, stringAt } from "./reply.js";
import { registeredText } from "./source_brief.js";
import { type Leaf, type LeafKind, MAX_SAMPLES, type Member, type Source } from "./types.js";

/** The most concepts one source can show: every sample at its own most. */
export const MAX_CLUSTERS = MAX_LEAVES * MAX_SAMPLES;
const MISSING_SHOWN = 5;

/** One cluster as the model replies it. */
export interface ClusterReply {
  readonly name: string;
  readonly purpose: string;
  readonly kind: LeafKind;
  readonly input_fields: readonly string[];
  readonly output_fields: readonly string[];
  readonly evidence: readonly string[];
  readonly members: readonly Member[];
}

function clusterAt(value: unknown, path: string): ClusterReply {
  const cluster = recordAt(value, path);
  const members = arrayAt(cluster.members, `${path}.members`);
  if (members.length === 0) throw new Error(`${path}.members must hold at least one entry`);
  return {
    name: stringAt(cluster.name, `${path}.name`),
    purpose: stringAt(cluster.purpose, `${path}.purpose`, true),
    kind: kindAt(cluster.kind, `${path}.kind`),
    input_fields: namesAt(cluster.input_fields, `${path}.input_fields`),
    output_fields: namesAt(cluster.output_fields, `${path}.output_fields`),
    evidence: namesAt(cluster.evidence, `${path}.evidence`),
    members: members.map((member, index) => memberAt(member, `${path}.members[${index}]`)),
  };
}

const memberKey = (member: Member): string => `${member.sample}|${member.name}`;
const listed = (values: readonly string[]): string => values.join(", ");

function proposalText(sample: number, leaf: Leaf): string {
  return [
    `Sample ${sample} | ${leaf.name}`,
    `Kind: ${leaf.kind}`,
    `Purpose: ${leaf.purpose}`,
    `Input fields: ${listed(leaf.input_fields)}`,
    `Output fields: ${listed(leaf.output_fields)}`,
    `Evidence: ${listed(leaf.evidence)}`,
  ].join("\n");
}

function reconcileInput(samples: readonly (readonly Leaf[])[], source: Source, frame: ProposalFrame): string {
  return [
    `Source: ${source.ref} (${source.kind})`,
    ...(frame.namespace === undefined ? [] : [`Namespace: every name starts with "${frame.namespace}."`]),
    ...(frame.siblings.length === 0 ? [] : [registeredText(frame.siblings)]),
    `Samples: ${samples.length}`,
    "Proposals:",
    samples.flatMap((leaves, at) => leaves.map((leaf) => proposalText(at + 1, leaf))).join("\n\n"),
  ].join("\n");
}

/** Each of one sample's proposals as a concept of one member, for a run with a single sample to reconcile. */
export function singleSampleClusters(leaves: readonly Leaf[]): AgreedLeaf[] {
  return leaves.map((leaf) => ({ ...leaf, agreement: 1, members: [{ sample: 1, name: leaf.name }] }));
}

const fieldCount = (leaf: Leaf): number => leaf.input_fields.length + leaf.output_fields.length;

/** The member's proposal a cluster draws its summaries and reason from: the fullest, the earliest of equals. */
const fullestMember = (members: readonly Leaf[]): Leaf =>
  members.reduce((best, leaf) => (fieldCount(leaf) > fieldCount(best) ? leaf : best));

function missingMember(reply: readonly ClusterReply[], proposed: ReadonlyMap<string, Leaf>): string | undefined {
  const named = new Set(reply.flatMap((cluster) => cluster.members.map(memberKey)));
  const missing = [...proposed.keys()].filter((key) => !named.has(key));
  if (missing.length === 0) return undefined;
  const shown = missing.slice(0, MISSING_SHOWN).map((key) => `sample ${key.replace("|", " ")}`).join(", ");
  return `${missing.length} proposals are in no cluster (${shown}${
    missing.length > MISSING_SHOWN ? ", ..." : ""
  }): every proposal belongs to at least one cluster`;
}

/**
 * The concepts a reply names, as leaves; throws the reason, written for the model, when a member was not proposed by
 * the sample it names, a canonical name breaks the name rules, or a proposal is in no cluster.
 */
export function clustersFrom(
  reply: readonly ClusterReply[],
  samples: readonly (readonly Leaf[])[],
  source: Source,
  frame: ProposalFrame,
): AgreedLeaf[] {
  const proposed = new Map<string, Leaf>(
    samples.flatMap((leaves, at) =>
      leaves.map((leaf): [string, Leaf] => [memberKey({ sample: at + 1, name: leaf.name }), leaf])
    ),
  );
  const clusters = reply.map((cluster): AgreedLeaf => {
    const members = [...new Map(cluster.members.map((member) => [memberKey(member), member])).values()];
    const drawn = members.map((member) => {
      const leaf = proposed.get(memberKey(member));
      if (leaf === undefined) {
        throw new Error(
          `cluster "${cluster.name}" lists "${member.name}" as sample ${member.sample}'s proposal, which it is not: give each member's sample number and name exactly as written`,
        );
      }
      return leaf;
    });
    const { name, purpose, kind, input_fields, output_fields, evidence } = cluster;
    return {
      ...fullestMember(drawn),
      name,
      purpose,
      kind,
      input_fields,
      output_fields,
      evidence,
      agreement: agreementOf(members),
      members,
    };
  });
  const problem = proposalProblem(clusters, source, frame.namespace, frame.siblings, MAX_CLUSTERS)
    ?? missingMember(reply, proposed);
  if (problem !== undefined) throw new Error(problem);
  return clusters;
}

/**
 * One model call: the proposals of all samples grouped by concept, each group named once under the name rules.
 * Everything it returns is checked against what the samples really proposed. One sample needs no call.
 */
export async function reconcileProposals(
  samples: readonly (readonly Leaf[])[],
  source: Source,
  frame: ProposalFrame,
  ctx: StepContext,
): Promise<AgreedLeaf[]> {
  if (samples.length === 1) return singleSampleClusters(samples[0]!);
  ctx.progress(`${source.ref}: grouping the samples' proposals by concept`);
  const prompt = modelPrompt(RECONCILE, reconcileInput(samples, source, frame));
  return askJson(ctx.step, prompt, (reply) => {
    const clusters = arrayAt(replyField(reply, RECONCILE.field), RECONCILE.field).map((value, index) =>
      clusterAt(value, `${RECONCILE.field}[${index}]`)
    );
    return clustersFrom(clusters, samples, source, frame);
  }, { signal: ctx.signal });
}
