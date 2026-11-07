import { readFileSync } from "node:fs";
import { FakeSecurityNet } from "./fake_net.ts";
import type { HttpAnswer, NetAnswer } from "./net.ts";
import type { PublicApiReading } from "./public_api.ts";
import { RELEASES_URL } from "./public_api.ts";

/** Test helpers for the tools that ask a site over HTTP: a recorded site, and a network that replays it. */

export const SITE = "https://example.org";

/** A recorded public-API reading (`clean` refuses everything; `compromised` answers like a hacked site). */
export type RecordedApi = Required<PublicApiReading> & { releases: { status: "measured"; versions: string[] } };

export function apiFixture(name: "clean" | "compromised"): RecordedApi {
  const parsed = JSON.parse(readFileSync(new URL(`./fixtures/public_api_${name}.json`, import.meta.url), "utf8"));
  if (parsed.status !== "measured") throw new Error("the fixture is not a measurement");
  return parsed as RecordedApi;
}

const answerOf = (recorded: HttpAnswer): NetAnswer => ({
  status: recorded.status,
  contentType: recorded.content_type,
  body: recorded.body,
  ...(recorded.location === undefined ? {} : { location: recorded.location }),
});

/** The WordPress.org answer for a list of releases. */
export const releaseBody = (versions: readonly string[]): string =>
  JSON.stringify({ offers: versions.map((current) => ({ response: "upgrade", current })) });

/** A network that answers the way the recorded site did, by address; `replaced` adds or overrides addresses. */
export function netFor(
  recorded: RecordedApi,
  replaced: Readonly<Record<string, NetAnswer | Error>> = {},
): FakeSecurityNet {
  const http: Record<string, NetAnswer | Error> = {};
  for (const each of [recorded.home, recorded.feed, recorded.readme, recorded.xmlrpc, recorded.author]) {
    http[`${SITE}${each.path}`] = answerOf(each);
  }
  for (const each of [...recorded.rest_batch, ...recorded.users]) http[`${SITE}${each.path}`] = answerOf(each);
  http[RELEASES_URL] = { status: 200, contentType: "application/json", body: releaseBody(recorded.releases.versions) };
  return new FakeSecurityNet({ http: { ...http, ...replaced } });
}
