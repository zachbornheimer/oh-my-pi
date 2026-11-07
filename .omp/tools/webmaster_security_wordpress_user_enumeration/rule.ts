import { listed, securityFinding, type Verdict } from "./check.ts";
import { type HttpAnswer, succeeded } from "./net.ts";

export const CHECK = "webmaster.security.wordpress.user_enumeration";
const REDIRECT_FLOOR = 300;
const CLIENT_ERROR_FLOOR = 400;
const NAMES_SHOWN = 5;

function slugsOf(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((user: unknown) =>
      typeof user === "object" && user !== null && "slug" in user && typeof user.slug === "string" ? [user.slug] : []
    );
  } catch {
    return [];
  }
}

function authorPathOf(asked: HttpAnswer): string | undefined {
  if (asked.status < REDIRECT_FLOOR || asked.status >= CLIENT_ERROR_FLOOR || asked.location === undefined) {
    return undefined;
  }
  const path = new URL(asked.location, "https://site.invalid").pathname;
  return /\/author\/[^/]+/.test(path) ? path : undefined;
}

/** User names an anonymous visitor can read off the users route or an author redirect. */
export function userEnumerationVerdict(
  reading: { readonly users?: readonly HttpAnswer[]; readonly author?: HttpAnswer },
): Verdict {
  const { users, author } = reading;
  if (users === undefined || author === undefined) return { unmeasured: "the public API was not read" };
  const asked = [...users, author];
  if (asked.every((each) => each.status === 0)) {
    return { unmeasured: `no user route answered: ${asked[0]?.error ?? "no request was sent"}` };
  }
  const listings = users.filter(succeeded).map((each) => ({ path: each.path, names: slugsOf(each.body) })).filter((
    each,
  ) => each.names.length > 0);
  const redirect = authorPathOf(author);
  if (listings.length === 0 && redirect === undefined) return [];
  const names = [
    ...new Set([
      ...listings.flatMap((each) => each.names),
      ...redirect === undefined ? [] : [redirect.split("/").filter(Boolean).at(-1) ?? ""],
    ]),
  ];
  const sources = [
    ...listings.map((each) => `${each.path} lists them`),
    ...redirect === undefined ? [] : [`${author.path} redirects to ${redirect}`],
  ];
  return [securityFinding(
    "security.wordpress.user_enumeration",
    "medium",
    `User names are public: ${listed(names, NAMES_SHOWN)}. ${sources.join("; ")}.`,
    "Block /wp-json/wp/v2/users and ?author= lookups for anonymous visitors, and check that every listed account "
      + "has a strong, unique password and two-factor login.",
    "Hide the users route from anonymous REST callers and stop author archives from redirecting by id.",
  )];
}
