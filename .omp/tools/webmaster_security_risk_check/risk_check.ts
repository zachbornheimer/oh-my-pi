import { type Asset, assetLabel } from "./asset.ts";
import { type InventoryDeps, measureAsset } from "./asset_inventory.ts";
import { listAssets, narrowAssets } from "./assets.ts";
import { researchAdvisory, type ResearchDeps } from "./advisory_sources.ts";
import {
  byVerdict,
  checkedProfile,
  checkedResults,
  countsOf,
  factsFor,
  factsOf,
  findingFor,
  headlineOf,
  packageNamesOf,
  renderConditionsInput,
  renderProfileInput,
  settled,
  verdictOf,
} from "./judgment.ts";
import type { Machine } from "./machine.ts";
import { askJson, mapLimit, type ModelStep } from "./omp_model.ts";
import { languagePrompt, questionOf } from "./question.ts";
import { type AdvisoryProfile, type AssetVerdict, bySeverity, parseConditionsReply, parseProfileReply, type RiskCheckResult } from "./types.ts";

/** How many assets are read and judged at once: each server is one SSH session. */
export const ASSETS_AT_ONCE = 4;

export interface RiskRequest {
  readonly text: string;
  readonly servers?: readonly string[] | undefined;
  readonly sites?: readonly string[] | undefined;
}

export interface RiskDeps {
  readonly machine: Machine;
  readonly model: ModelStep;
  readonly research?: ResearchDeps;
  readonly inventory?: InventoryDeps;
  readonly signal?: AbortSignal;
}

export const noSourceReason = (text: string, errors: readonly string[]): string =>
  `nothing could be read about "${text}"${errors.length === 0 ? "" : `: ${errors.join("; ")}`}. `
  + "Give a URL, a domain or a CVE id that can be fetched, or describe the problem in a sentence the web can find.";

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/**
 * Takes a newly reported security problem in the owner's words and says which of the owner's servers and sites it
 * hurts. It reads the advisory (the pages and CVE records the words point at, or a web search), lists the assets, has a
 * model turn the sources into conditions a fixed fact can settle, reads those facts from each asset over a fixed
 * read-only command list, and decides each asset's verdict from conditions the model decided against quoted facts. An
 * asset whose facts could not be read is `unmeasured`, never safe. It never fixes, changes or messages anything.
 */
export async function runRiskCheck(request: RiskRequest, deps: RiskDeps): Promise<RiskCheckResult> {
  const { text } = request;
  const sources = await researchAdvisory(text, deps.research);
  deps.signal?.throwIfAborted();
  const all = await listAssets(deps.machine);
  const assets = narrowAssets(all, {
    ...(request.servers === undefined ? {} : { servers: request.servers }),
    ...(request.sites === undefined ? {} : { sites: request.sites }),
  });
  if (!sources.some((source) => source.text !== "")) {
    throw new Error(noSourceReason(text, sources.flatMap((source) => (source.error === undefined ? [] : [`${source.url}: ${source.error}`]))));
  }
  if (assets.length === 0) {
    throw new Error("there are no servers or sites to check: the SSH config and the site files list none (or `servers` and `sites` name none of them)");
  }

  const profile: AdvisoryProfile = await askJson(
    deps.model,
    languagePrompt(questionOf("Profile"), renderProfileInput(text, sources)),
    (reply) => checkedProfile(parseProfileReply(reply)),
    deps.signal === undefined ? {} : { signal: deps.signal },
  );

  const packages = packageNamesOf(profile);
  const verdicts: { asset: Asset; verdict: AssetVerdict }[] = await mapLimit(assets, ASSETS_AT_ONCE, async (asset) => {
    const label = assetLabel(asset);
    if (!profile.applies_to.includes(asset.kind)) {
      return { asset, verdict: settled(asset, "not_applicable", `the advisory is about ${profile.applies_to.join(" and ")} assets, not ${asset.kind}s`) };
    }
    const inventory = await measureAsset(asset, factsFor(profile, asset.kind), packages, deps.machine, deps.inventory);
    deps.signal?.throwIfAborted();
    if (inventory.status === "unmeasured") return { asset, verdict: settled(asset, "unmeasured", inventory.reason) };
    const facts = factsOf(inventory);
    try {
      const results = await askJson(
        deps.model,
        languagePrompt(questionOf("Conditions"), renderConditionsInput(profile, asset, facts)),
        (reply) => checkedResults(profile, facts, parseConditionsReply(reply)),
        deps.signal === undefined ? {} : { signal: deps.signal },
      );
      return { asset, verdict: { asset: label, ...verdictOf(profile, results), conditions: results } };
    } catch (error) {
      if (isAbort(error)) throw error;
      const why = error instanceof Error ? error.message : String(error);
      return { asset, verdict: settled(asset, "unmeasured", `the facts were read but could not be judged: ${why}`) };
    }
  });

  const judged = verdicts.map(({ verdict }) => verdict).sort(byVerdict);
  const counts = countsOf(judged);
  return {
    advisory: profile,
    sources: sources.map(({ text: _text, ...source }) => source),
    headline: headlineOf(counts),
    counts,
    assets: judged,
    findings: judged.filter((verdict) => verdict.verdict === "affected").map((verdict) => findingFor(profile, verdict)).sort(bySeverity),
    unmeasured: judged.filter((verdict) => verdict.verdict === "unmeasured").map(({ asset, reason }) => ({ asset, reason })),
  };
}
