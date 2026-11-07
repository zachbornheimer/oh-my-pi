import { plainUrl, publisherHost } from "./page_address.ts";
import type { FetchedPage } from "./candidates.ts";
import {
  ANALOG_SET_MAX,
  ANALOG_SETS,
  type AnalogAnswer,
  type AnalogChoice,
  type AnalogSet,
  type RejectedCandidate,
} from "./schemas.ts";

/** A choice that passed validation, with the page the fetch read for it. */
export interface KeptChoice {
  readonly choice: AnalogChoice;
  readonly page: FetchedPage;
}

/** What earlier search rounds settled: the analogs each set kept and every page rejected. */
export interface EarlierRounds {
  readonly kept: Readonly<Record<AnalogSet, readonly KeptChoice[]>>;
  readonly rejected: readonly RejectedCandidate[];
}

/** Below this many characters, a title fragment is too generic to match on containment alone. */
const MIN_CONTAINED_TITLE = 4;

const words = (text: string): string => text.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Whether `observed` is the fetched page's title or one of its H1s, allowing a site-name suffix or prefix. */
function titleMatches(observed: string, page: FetchedPage): boolean {
  const seen = words(observed);
  const fetched = [page.seo.title, ...page.seo.headings.filter((heading) => heading.level === 1).map((h) => h.text)]
    .map(words)
    .filter((text) => text !== "");
  return seen !== "" && fetched.some((text) => {
    if (text === seen) return true;
    const [shorter, longer] = text.length < seen.length ? [text, seen] : [seen, text];
    return shorter.length >= MIN_CONTAINED_TITLE && longer.includes(shorter);
  });
}

/** Every address the fetch knows a page by: the one it was asked for and where each probe ended up. */
function pagesByAddress(pages: readonly FetchedPage[]): ReadonlyMap<string, FetchedPage> {
  const byAddress = new Map<string, FetchedPage>();
  for (const page of pages) {
    for (const address of [page.url, page.seo.final_url, page.content.final_url]) {
      const plain = plainUrl(address);
      if (plain !== undefined && !byAddress.has(plain)) byAddress.set(plain, page);
    }
  }
  return byAddress;
}

/**
 * One round's choose answer, checked against what this round fetched and what earlier rounds settled. Earlier kept
 * analogs stay kept and count toward each set's cap and its publishers. A choice whose page was not fetched, was
 * already rejected, whose observed title is not the fetched title or an H1, that repeats a page or a publisher, or that
 * overflows its set moves to `rejected` with the reason. The model's own rejections follow, minus any page already
 * accounted for. `kept` is every set's cumulative list; `rejected` is this round's alone. Never pads.
 */
export function validateChoices(
  answer: AnalogAnswer,
  pages: readonly FetchedPage[],
  earlier: EarlierRounds,
): { readonly kept: Readonly<Record<AnalogSet, KeptChoice[]>>; readonly rejected: RejectedCandidate[] } {
  const kept: Record<AnalogSet, KeptChoice[]> = {
    sameIndustry: [...earlier.kept.sameIndustry],
    differentIndustry: [...earlier.kept.differentIndustry],
  };
  const earlierKept = ANALOG_SETS.flatMap((set) => earlier.kept[set]);
  const byAddress = pagesByAddress([...earlierKept.map(({ page }) => page), ...pages]);
  const plain = (address: string) => plainUrl(address) ?? address;
  const earlierRejected = new Set(earlier.rejected.map((entry) => plain(entry.url)));
  const rejected: RejectedCandidate[] = [];
  const usedPages = new Set<FetchedPage>(earlierKept.map(({ page }) => page));
  const usedPublishers = new Map<string, string>(
    earlierKept.map(({ page }) => [publisherHost(page.url), page.url]),
  );
  for (const set of ANALOG_SETS) {
    for (const choice of answer[set]) {
      const reject = (reason: string) => rejected.push({ url: choice.url, reason });
      const page = byAddress.get(plain(choice.url));
      if (page === undefined) {
        reject(
          earlierRejected.has(plain(choice.url)) ? "already rejected in an earlier round" : "not fetched in this run",
        );
      } else if (!titleMatches(choice.observedTitle, page)) {
        reject(
          `observed title "${choice.observedTitle}" is neither the fetched title "${page.seo.title}" nor an H1`,
        );
      } else if (usedPages.has(page)) {
        reject("chosen twice");
      } else if (usedPublishers.has(publisherHost(page.url))) {
        reject(`a second page from ${publisherHost(page.url)}, after ${usedPublishers.get(publisherHost(page.url))}`);
      } else if (kept[set].length >= ANALOG_SET_MAX) {
        reject(`beyond the ${ANALOG_SET_MAX}-analog cap of ${set}`);
      } else {
        usedPages.add(page);
        usedPublishers.set(publisherHost(page.url), page.url);
        kept[set].push({ choice: { ...choice, url: page.url }, page });
      }
    }
  }
  const accounted = new Set([
    ...earlierRejected,
    ...[...ANALOG_SETS.flatMap((set) => kept[set].map(({ page }) => page.url)), ...rejected.map((entry) => entry.url)]
      .map(plain),
  ]);
  for (const entry of answer.rejected) {
    const address = plain(entry.url);
    if (accounted.has(address)) continue;
    accounted.add(address);
    rejected.push(entry);
  }
  return { kept, rejected };
}
