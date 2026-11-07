import { type Asset, assetLabel } from "./asset.ts";
import { type SecurityFinding, securityFinding } from "./check.ts";
import {
  FACT_DESCRIPTIONS,
  FACTS,
  type Fact,
  isServerFact,
  isSiteFact,
  MAX_PACKAGES,
} from "./inventory_facts.ts";
import type { AssetInventory, InventoryFact } from "./inventory_types.ts";
import type {
  AdvisoryProfile,
  AdvisorySource,
  AssetVerdict,
  ConditionResult,
  Verdict,
  VerdictCounts,
} from "./types.ts";

/**
 * The parts of the risk check that are plain computation: what the model is shown, what it is refused for, and how
 * the verdict follows from the conditions it decided. The model decides each condition from a quoted fact; code decides
 * what that means for the asset, so a verdict is never the model's guess.
 */

const SOURCE_CHARS_EACH = 20_000;
const SOURCE_CHARS_ALL = 60_000;

/** Whitespace collapsed, so a quote is matched against output however the lines were wrapped. */
export const squashed = (text: string): string => text.replace(/\s+/g, " ").trim();

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** The facts the model may choose from, one line each. */
export const factMenu = (): string => FACTS.map((fact) => `- ${fact}: ${FACT_DESCRIPTIONS[fact]}`).join("\n");

/** What the model reads to profile the advisory: the owner's words, every source, and the fact menu. */
export function renderProfileInput(text: string, sources: readonly AdvisorySource[]): string {
  let budget = SOURCE_CHARS_ALL;
  const blocks = sources.map((source) => {
    const body = source.text === "" ? `(nothing was read: ${source.error ?? "empty"})` : source.text.slice(0, Math.min(SOURCE_CHARS_EACH, Math.max(budget, 0)));
    budget -= body.length;
    return `### ${source.kind} ${source.url} (${source.status === 0 ? "no answer" : `HTTP ${source.status}`})\n${body}`;
  });
  return [
    `The owner's words:\n${text}`,
    `## Sources\n\n${blocks.join("\n\n")}`,
    `## Facts that can be read (choose only from these ids)\n${factMenu()}`,
  ].join("\n\n");
}

/** Why a profile is refused, or the profile when it stands. The reason is shown to the model, which answers again. */
export function checkedProfile(profile: AdvisoryProfile): AdvisoryProfile {
  const ids = profile.conditions.map((condition) => condition.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) throw new Error(`condition id "${repeated}" is used twice: every condition needs its own id`);
  if (!profile.conditions.some((condition) => condition.necessary)) {
    throw new Error("give at least one necessary condition: without one no asset could ever be called safe or affected");
  }
  const packageNames = unique(profile.components.flatMap((component) => component.package_names));
  if (packageNames.length > MAX_PACKAGES) {
    throw new Error(`name at most ${MAX_PACKAGES} package names in all; keep the ones that matter`);
  }
  const needsPackages = profile.conditions.find((condition) => condition.facts.includes("packages"));
  if (needsPackages !== undefined && packageNames.length === 0) {
    throw new Error(
      `condition "${needsPackages.id}" reads the \`packages\` fact, but no component names a package: add package_names to the component`,
    );
  }
  return profile;
}

/** The package names to read: every component's, once. */
export const packageNamesOf = (profile: AdvisoryProfile): string[] =>
  unique(profile.components.flatMap((component) => component.package_names)).slice(0, MAX_PACKAGES);

/** The facts to read from one kind of asset: a small baseline, and the facts the conditions name that the kind has. */
export function factsFor(profile: AdvisoryProfile, kind: Asset["kind"]): Fact[] {
  const baseline: Fact[] = kind === "server" ? ["os_release", "kernel"] : ["web_headers"];
  const named = profile.conditions.flatMap((condition) => condition.facts);
  return unique([...baseline, ...named]).filter((fact) => kind === "server" ? isServerFact(fact) : isSiteFact(fact));
}

const describeAsset = (asset: Asset): string =>
  asset.kind === "server"
    ? `${assetLabel(asset)} (${asset.hostname ?? asset.target}${asset.port === undefined ? "" : `:${asset.port}`}${asset.sites.length === 0 ? "" : `, hosts ${asset.sites.join(", ")}`})`
    : `${assetLabel(asset)} (${asset.url}${asset.platform === undefined ? "" : `, ${asset.platform}`})`;

/** What the model reads to decide the conditions for one asset: the problem, the conditions, and every fact read. */
export function renderConditionsInput(
  profile: AdvisoryProfile,
  asset: Asset,
  facts: readonly InventoryFact[],
): string {
  const conditions = profile.conditions.map((condition) =>
    `- ${condition.id} (${condition.necessary ? "necessary" : "not necessary"}): ${condition.statement} (settled by: ${condition.facts.join(", ")})`
  );
  const fixed = profile.components.filter((component) => component.fixed_in !== null).map((component) =>
    `${component.name} ${component.fixed_in}`
  );
  const read = facts.filter((fact) => fact.code !== -1).map((fact) =>
    `### Fact ${fact.fact} (exit ${fact.code})\n${fact.output === "" ? "(printed nothing)" : fact.output}`
  );
  const notRead = facts.filter((fact) => fact.code === -1).map((fact) => `- ${fact.fact}: ${fact.output}`);
  return [
    `Problem: ${profile.title}\n${profile.summary}${fixed.length === 0 ? "" : `\nFixed in: ${fixed.join(", ")}`}`,
    `## Conditions to decide\n${conditions.join("\n")}`,
    `## Asset: ${describeAsset(asset)}`,
    read.join("\n\n"),
    notRead.length === 0 ? "" : `### Facts that could not be read\n${notRead.join("\n")}`,
  ].filter((part) => part !== "").join("\n\n");
}

/**
 * Why the model's results are refused, or the results when they stand: one per condition, in order; a `met` or
 * `not_met` names a fact that was read and quotes it exactly; an `unknown` says what is missing.
 */
export function checkedResults(
  profile: AdvisoryProfile,
  facts: readonly InventoryFact[],
  results: readonly ConditionResult[],
): ConditionResult[] {
  const wanted = profile.conditions.map((condition) => condition.id);
  if (results.length !== wanted.length || results.some((result, index) => result.condition !== wanted[index])) {
    throw new Error(`answer exactly one result per condition, in this order: ${wanted.join(", ")}`);
  }
  for (const result of results) {
    if (result.result === "unknown") {
      if (result.note.trim() === "") throw new Error(`condition "${result.condition}" is unknown: say in note what is missing`);
      continue;
    }
    const fact = facts.find((each) => each.fact === result.fact && each.code !== -1);
    if (result.fact === null || fact === undefined) {
      const read = facts.filter((each) => each.code !== -1).map((each) => each.fact).join(", ");
      throw new Error(
        `condition "${result.condition}" is ${result.result} but names ${result.fact === null ? "no fact" : `fact "${result.fact}"`}, which was not read: name one of ${read}, or answer unknown`,
      );
    }
    if (squashed(result.quote) === "" || !squashed(fact.output).includes(squashed(result.quote))) {
      throw new Error(
        `condition "${result.condition}": the quote ${JSON.stringify(result.quote)} is not in the output of fact "${fact.fact}": copy a piece of that output exactly, or answer unknown`,
      );
    }
  }
  return [...results];
}

/** What the decided conditions mean for the asset: one necessary condition that fails clears it, one that is unknown leaves it open. */
export function verdictOf(
  profile: AdvisoryProfile,
  results: readonly ConditionResult[],
): { readonly verdict: Extract<Verdict, "affected" | "not_affected" | "unmeasured">; readonly reason: string } {
  const necessary = profile.conditions.filter((condition) => condition.necessary).map((condition) =>
    ({ condition, result: results.find((each) => each.condition === condition.id) })
  );
  const failed = necessary.find(({ result }) => result?.result === "not_met");
  if (failed !== undefined) {
    return { verdict: "not_affected", reason: `${failed.condition.id}: ${failed.result?.note ?? failed.condition.statement}` };
  }
  const open = necessary.filter(({ result }) => result === undefined || result.result === "unknown");
  if (open.length > 0) {
    return {
      verdict: "unmeasured",
      reason: `cannot tell: ${open.map(({ condition, result }) => `${condition.id} (${result?.note ?? "not decided"})`).join("; ")}`,
    };
  }
  return {
    verdict: "affected",
    reason: `every necessary condition holds: ${necessary.map(({ condition }) => condition.id).join(", ")}`,
  };
}

/** A verdict for an asset no model was asked about. */
export const settled = (asset: Asset, verdict: Verdict, reason: string): AssetVerdict => ({
  asset: assetLabel(asset),
  verdict,
  reason,
  conditions: [],
});

const slugOf = (profile: AdvisoryProfile): string =>
  (profile.cves[0] ?? profile.title).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/** The finding for an affected asset: the conditions that hold with their quotes, the workaround, and the fix. */
export function findingFor(profile: AdvisoryProfile, verdict: AssetVerdict): SecurityFinding {
  const holds = verdict.conditions.filter((result) => result.result === "met").map((result) => {
    const statement = profile.conditions.find((condition) => condition.id === result.condition)?.statement ?? result.condition;
    return `${statement} (${result.fact}: "${result.quote}")`;
  });
  return securityFinding(
    `security.advisory.${slugOf(profile)}`,
    profile.severity,
    `${verdict.asset} is affected by ${profile.title}: ${holds.join("; ")}.`,
    profile.workaround[0] ?? profile.remediation[0] ?? "Treat the asset as exposed until the vendor's fix is installed.",
    profile.remediation.length > 0 ? profile.remediation.join(" ") : "Install the vendor's fix.",
  );
}

const ORDER: readonly Verdict[] = ["affected", "unmeasured", "not_affected", "not_applicable"];

/** Affected first, then what could not be judged, then the rest; each group keeps its order. */
export const byVerdict = (a: Pick<AssetVerdict, "verdict">, b: Pick<AssetVerdict, "verdict">): number =>
  ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict);

/** How the verdicts count up. */
export function countsOf(verdicts: readonly Pick<AssetVerdict, "verdict">[]): VerdictCounts {
  const count = (verdict: Verdict) => verdicts.filter((each) => each.verdict === verdict).length;
  return {
    affected: count("affected"),
    not_affected: count("not_affected"),
    unmeasured: count("unmeasured"),
    not_applicable: count("not_applicable"),
  };
}

/** One line: how the assets came out. */
export function headlineOf(counts: VerdictCounts): string {
  const total = counts.affected + counts.not_affected + counts.unmeasured + counts.not_applicable;
  return `${counts.affected} affected, ${counts.unmeasured} unmeasured, ${counts.not_affected} not affected, ${counts.not_applicable} not applicable, across ${total} assets`;
}

/** The inventory's facts when it was read; empty when it was not. */
export const factsOf = (inventory: AssetInventory): InventoryFact[] =>
  inventory.status === "measured" ? inventory.facts : [];
