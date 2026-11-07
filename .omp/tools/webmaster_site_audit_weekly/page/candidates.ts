import type { ContentMeasurement, SeoMeasurement } from "./measurement.ts";
import { plainUrl, publisherHost } from "./page_address.ts";
import { ANALOG_SETS, type AnalogSet, type RejectedCandidate } from "./schemas.ts";

/** The most distinct search results one round fetches for a set; the rest are rejected unfetched. */
export const FETCH_CAP_PER_SET = 12;
/** Fewer rendered characters than this means the page needs JavaScript to show its content. */
export const MIN_VISIBLE_TEXT = 200;
const SIGN_IN_PATH = /\/(wp-login\.php|login|log-in|signin|sign-in|account\/login)\b/i;

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

export interface Candidate {
  /** The plain address the fetch reads. */
  readonly url: string;
  readonly snippet: string;
}

export type MeasuredSeo = Extract<SeoMeasurement, { status: "measured" }>;
export type MeasuredContent = Extract<ContentMeasurement, { status: "measured" }>;

/** A candidate both probes read: what the choose step sees and the validate step checks against. */
export interface FetchedPage {
  readonly url: string;
  readonly snippet: string;
  readonly seo: MeasuredSeo;
  readonly content: MeasuredContent;
}

/**
 * The distinct pages one round's searches found, set by set in the order found, each set capped at FETCH_CAP_PER_SET
 * so one set's results never crowd out the other's. The target's own site, PDFs and addresses that are not web pages
 * are rejected before any fetch. Repeats of one page, including every page an earlier round already considered, are
 * dropped silently: that page is already accounted for.
 */
export function candidatesFrom(
  hits: Readonly<Record<AnalogSet, readonly SearchHit[]>>,
  target: string,
  considered: ReadonlySet<string>,
): { readonly candidates: Candidate[]; readonly rejected: RejectedCandidate[] } {
  const targetHost = publisherHost(target);
  const seen = new Set(considered);
  const candidates: Candidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const set of ANALOG_SETS) {
    let fetching = 0;
    for (const hit of hits[set]) {
      const url = plainUrl(hit.url);
      if (url === undefined) {
        rejected.push({ url: hit.url, reason: "not a web address" });
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      if (publisherHost(url) === targetHost) {
        rejected.push({ url, reason: "the target's own site" });
      } else if (new URL(url).pathname.toLowerCase().endsWith(".pdf")) {
        rejected.push({ url, reason: "a PDF, not a page" });
      } else if (fetching >= FETCH_CAP_PER_SET) {
        rejected.push({ url, reason: `beyond the ${FETCH_CAP_PER_SET}-page fetch cap of ${set}` });
      } else {
        fetching += 1;
        candidates.push({ url, snippet: hit.snippet });
      }
    }
  }
  return { candidates, rejected };
}

/** The fetched page, or why it cannot be an analog: a probe that could not read it, an error, a sign-in wall, no text. */
export function fetchedOrRejected(
  candidate: Candidate,
  seo: SeoMeasurement,
  content: ContentMeasurement,
): FetchedPage | RejectedCandidate {
  const reject = (reason: string): RejectedCandidate => ({ url: candidate.url, reason });
  if (seo.status === "unmeasured") return reject(`not fetched: ${seo.reason}`);
  if (content.status === "unmeasured") return reject(`not fetched: ${content.reason}`);
  if (content.http_status >= 400) return reject(`HTTP ${content.http_status}`);
  if (SIGN_IN_PATH.test(content.final_url)) return reject(`redirected to a sign-in page (${content.final_url})`);
  const characters = content.visible_text.trim().length;
  if (characters < MIN_VISIBLE_TEXT) {
    return reject(`renders ${characters} characters of text without JavaScript`);
  }
  return { url: candidate.url, snippet: candidate.snippet, seo, content };
}
